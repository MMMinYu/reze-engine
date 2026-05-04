import { Mat4 } from "../math"
import type { Joint, Rigidbody } from "./types"

// 6DOF spring constraint, modeled after btGeneric6DofSpringConstraint but
// trimmed to what MMD actually uses. The constraint connects bodyA and bodyB
// via local-space anchor frames frameA / frameB. At simulate time the world
// frames are TA = worldA × frameA, TB = worldB × frameB. The 6 DOFs are the
// linear diff in TA's basis (axes 0..2) and the Euler-XYZ angular diff between
// TA's and TB's basis (axes 3..5), matching Bullet's index convention.
//
// Springs (when enabled) drive each DOF toward equilibriumPoint[i] with
// stiffness[i] (Hooke). Damping is fixed to 1.0 (no extra damping) — matches
// the constructor default in btGeneric6DofSpringConstraint and what saba and
// MMD-tuned rigs expect.
//
// stopERP = 0.475 mirrors the old Ammo init: setParam(BT_CONSTRAINT_STOP_ERP,
// 0.475, i) for every axis; PMX joints rely on this softness.
//
// The solver is hard-coded to Bullet 2.75's `useOffsetForConstraintFrame =
// false` behavior (m_AnchorPos as mass-weighted blend), so there is no
// per-constraint flag — the historical "胸" keyword whitelist is unnecessary.
export interface SixDofSpringConstraint {
  bodyA: number
  bodyB: number
  // Local 4x4 (column-major) anchor frames on each body.
  frameA: Float32Array
  frameB: Float32Array
  // Per-axis limits. For each i: when min[i] > max[i] the axis is free
  // (Bullet's "free" convention); when min[i] === max[i] the axis is locked.
  linearMin: Float32Array  // length 3
  linearMax: Float32Array
  angularMin: Float32Array // length 3, radians
  angularMax: Float32Array
  // Springs.
  springEnabled: Uint8Array     // length 6
  springStiffness: Float32Array // length 6 (k)
  equilibriumPoint: Float32Array// length 6, baked at setup time
}

export const STOP_ERP = 0.475

// Build per-joint constraints from PMX joint + rigidbody data, matching the
// math the deleted Ammo path used:
//   frameA = (bodyA_worldBind)^(-1) × jointWorldBind
//   frameB = (bodyB_worldBind)^(-1) × jointWorldBind
// where bodyN_worldBind = T(rb.shapePosition) · R(rb.shapeRotation) and
// jointWorldBind = T(joint.position) · R(joint.rotation).
//
// Equilibrium is set to zero on every axis (the "current" pose at bind = 0
// linear diff and 0 angular diff, since both frames coincide on the joint).
export function buildConstraints(
  rigidbodies: Rigidbody[],
  joints: Joint[],
): SixDofSpringConstraint[] {
  const out: SixDofSpringConstraint[] = []
  const jointWorld = new Float32Array(16)
  const bodyWorld = new Float32Array(16)
  const bodyInv = new Float32Array(16)

  for (let j = 0; j < joints.length; j++) {
    const joint = joints[j]
    const a = joint.rigidbodyIndexA
    const b = joint.rigidbodyIndexB
    if (a < 0 || b < 0 || a >= rigidbodies.length || b >= rigidbodies.length) continue
    if (a === b) continue
    const rbA = rigidbodies[a]
    const rbB = rigidbodies[b]

    // jointWorldBind from PMX (Euler XYZ as written by saba reference).
    const jq = eulerToQuat(joint.rotation.x, joint.rotation.y, joint.rotation.z)
    Mat4.fromPositionRotationInto(
      joint.position.x, joint.position.y, joint.position.z,
      jq.x, jq.y, jq.z, jq.w,
      jointWorld,
    )

    const frameA = new Float32Array(16)
    const frameB = new Float32Array(16)
    if (!buildLocalFrame(rbA, jointWorld, bodyWorld, bodyInv, frameA)) continue
    if (!buildLocalFrame(rbB, jointWorld, bodyWorld, bodyInv, frameB)) continue

    const linearMin = new Float32Array([joint.positionMin.x, joint.positionMin.y, joint.positionMin.z])
    const linearMax = new Float32Array([joint.positionMax.x, joint.positionMax.y, joint.positionMax.z])
    // Normalize angular bounds to [-π, π] — same as the old Ammo path; some
    // PMX rigs encode "fully free" axes with values like ±π·N that drift over
    // wrap and break the limit comparisons.
    const angularMin = new Float32Array([
      normalizeAngle(joint.rotationMin.x),
      normalizeAngle(joint.rotationMin.y),
      normalizeAngle(joint.rotationMin.z),
    ])
    const angularMax = new Float32Array([
      normalizeAngle(joint.rotationMax.x),
      normalizeAngle(joint.rotationMax.y),
      normalizeAngle(joint.rotationMax.z),
    ])

    const springEnabled = new Uint8Array(6)
    const springStiffness = new Float32Array(6)
    springStiffness[0] = joint.springPosition.x
    springStiffness[1] = joint.springPosition.y
    springStiffness[2] = joint.springPosition.z
    springStiffness[3] = joint.springRotation.x
    springStiffness[4] = joint.springRotation.y
    springStiffness[5] = joint.springRotation.z
    for (let i = 0; i < 6; i++) springEnabled[i] = springStiffness[i] !== 0 ? 1 : 0

    out.push({
      bodyA: a,
      bodyB: b,
      frameA,
      frameB,
      linearMin,
      linearMax,
      angularMin,
      angularMax,
      springEnabled,
      springStiffness,
      equilibriumPoint: new Float32Array(6),
    })
  }

  return out
}

// frame = bodyWorldBind^(-1) × jointWorld. Returns false if bodyWorldBind is
// singular (shouldn't happen for sane PMX data).
function buildLocalFrame(
  rb: Rigidbody,
  jointWorld: Float32Array,
  bodyWorld: Float32Array,
  bodyInv: Float32Array,
  out: Float32Array,
): boolean {
  const q = eulerToQuat(rb.shapeRotation.x, rb.shapeRotation.y, rb.shapeRotation.z)
  Mat4.fromPositionRotationInto(
    rb.shapePosition.x, rb.shapePosition.y, rb.shapePosition.z,
    q.x, q.y, q.z, q.w,
    bodyWorld,
  )
  if (!Mat4.inverseInto(bodyWorld, bodyInv)) return false
  Mat4.multiplyArrays(bodyInv, 0, jointWorld, 0, out, 0)
  return true
}

function normalizeAngle(a: number): number {
  const twoPi = Math.PI * 2
  a = a % twoPi
  if (a < -Math.PI) a += twoPi
  else if (a > Math.PI) a -= twoPi
  return a
}

// Local helper — same convention as Quat.fromEuler (ZXY, LH PMX) but inlined
// to avoid an allocation per joint.
function eulerToQuat(rx: number, ry: number, rz: number) {
  const cx = Math.cos(rx * 0.5), sx = Math.sin(rx * 0.5)
  const cy = Math.cos(ry * 0.5), sy = Math.sin(ry * 0.5)
  const cz = Math.cos(rz * 0.5), sz = Math.sin(rz * 0.5)
  const w = cy * cx * cz + sy * sx * sz
  const x = cy * sx * cz + sy * cx * sz
  const y = sy * cx * cz - cy * sx * sz
  const z = cy * cx * sz - sy * sx * cz
  const len = Math.hypot(x, y, z, w) || 1
  const inv = 1 / len
  return { x: x * inv, y: y * inv, z: z * inv, w: w * inv }
}
