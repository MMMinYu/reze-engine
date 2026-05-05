// 6DOF spring constraint solver. Modeled after Bullet 2.75's
// btGeneric6DofConstraint with `useOffsetForConstraintFrame = false` (the
// pre-2.82 default). Both bodies share a single anchor point in world space
// — the mass-weighted blend of their constraint frame origins — and lever
// arms `rA / rB` are measured from each CG to that shared anchor. This is
// the convention PMX rigs were tuned against, so breast / hair / skirt
// joints behave like saba / classic MMD without per-joint workarounds.
//
// Per-axis math, matching Bullet 2.75:
//   linearDiff[i]  = (TA.basis^T · (TB.origin − TA.origin))[i]
//   angularDiff    = matrixToEulerXYZ(TA.basis^T · TB.basis)
//   calculatedAxis: ax[1] = TA.col2 × TB.col0
//                   ax[0] = ax[1] × TA.col2
//                   ax[2] = TB.col0 × ax[1]
//
//   AnchorPos:     pA · weight + pB · (1 − weight),
//                  weight = (imB == 0) ? 1 : imA / (imA + imB)
//   Lever arms:    rA = AnchorPos − bodyA.position
//                  rB = AnchorPos − bodyB.position
//   Linear J:      J_A = (axis, rA × axis);  J_B = (−axis, −rB × axis)
//   relVel @anchor: (vB + ωB × rB) − (vA + ωA × rA)  along axis
//   jacDiagABInv:  1 / (invMassA + invMassB
//                       + (rA×axis)² · invInertiaA
//                       + (rB×axis)² · invInertiaB)
//
// Spring per iteration follows Bullet's clipped motor:
//   maxMotorImpulse = |k·δ| / fps;  per-iter contribution ≤ maxMotorImpulse·dt
//   Total spring impulse over a step ≤ |k·δ|·dt — distributed across iters
//   below to keep proportions right under varying iteration counts.
//
// Angular sign convention: d(angDiff[i])/dt = −(ω_B − ω_A)·ax[i] (Bullet's
// matrixToEulerXYZ with our calculatedAxis derivation), so the angular
// `targetVel` and spring impulse use the opposite sign from linear.

import { Mat4 } from "../math"
import type { RigidBodyStore } from "./body"
import type { SixDofSpringConstraint } from "./constraint"
import { STOP_ERP } from "./constraint"
import type { Contact, ContactPool } from "./contact"

// Contact constraint parameters. Bullet defaults:
//   - global ERP for contacts is 0.2 (softer than the 0.475 stop ERP for
//     joint limits, since contacts shouldn't snap rigidly)
//   - linearSlop = 0.0; the push-only impulse clamp + signed depth handle
//     near-touch contacts without an explicit dead zone. A nonzero slop
//     carves a sink-in band before push engages, which shows up as cloth
//     sinking a few mm into the body and then jittering as the system
//     cycles between sink → eject → sink.
//   - bounce threshold: minimum approach speed for restitution to kick in
const CONTACT_ERP = 0.2
const BOUNCE_THRESHOLD = 2.0

const _TA = new Float32Array(16)
const _TB = new Float32Array(16)
const _bodyMatA = new Float32Array(16)
const _bodyMatB = new Float32Array(16)

const _axisX = new Float32Array(3)
const _axisY = new Float32Array(3)
const _axisZ = new Float32Array(3)
const _angAxisX = new Float32Array(3)
const _angAxisY = new Float32Array(3)
const _angAxisZ = new Float32Array(3)
const _euler = new Float32Array(3)
const _rA = new Float32Array(3)
const _rB = new Float32Array(3)

export function solveConstraints(
  store: RigidBodyStore,
  constraints: SixDofSpringConstraint[],
  contacts: ContactPool,
  dt: number,
  iterations: number,
): void {
  if (dt <= 0) return
  if (constraints.length === 0 && contacts.count === 0) return

  const invDt = 1 / dt

  const lv = store.linearVelocities
  const av = store.angularVelocities
  const pos = store.positions
  const invMass = store.invMass
  const invInertia = store.invInertia

  for (let iter = 0; iter < iterations; iter++) {
    // Joint constraints first, then contacts. Order matters less than the
    // accumulated impulse warmstart (which we don't do), so this is fine.
    for (let c = 0; c < constraints.length; c++) {
      const con = constraints[c]
      const a = con.bodyA
      const b = con.bodyB
      const imA = invMass[a]
      const imB = invMass[b]
      const iiA = invInertia[a]
      const iiB = invInertia[b]
      if (imA === 0 && imB === 0) continue

      buildBodyMat(store, a, _bodyMatA)
      buildBodyMat(store, b, _bodyMatB)

      // TA = worldA × frameA;  TB = worldB × frameB
      Mat4.multiplyArrays(_bodyMatA, 0, con.frameA, 0, _TA, 0)
      Mat4.multiplyArrays(_bodyMatB, 0, con.frameB, 0, _TB, 0)

      // Mass-weighted shared anchor (Bullet 2.75 m_AnchorPos). Kinematic body
      // gets weight 1 for its partner so the anchor sits exactly on it; two
      // dynamic bodies blend by inverse mass.
      const ai = a * 3
      const bi = b * 3
      const weightA = imB === 0 ? 1 : imA / (imA + imB)
      const weightB = 1 - weightA
      const anchorX = _TA[12] * weightA + _TB[12] * weightB
      const anchorY = _TA[13] * weightA + _TB[13] * weightB
      const anchorZ = _TA[14] * weightA + _TB[14] * weightB
      _rA[0] = anchorX - pos[ai + 0]
      _rA[1] = anchorY - pos[ai + 1]
      _rA[2] = anchorZ - pos[ai + 2]
      _rB[0] = anchorX - pos[bi + 0]
      _rB[1] = anchorY - pos[bi + 1]
      _rB[2] = anchorZ - pos[bi + 2]

      // -- Linear part (offset-point) -------------------------------------
      const dxw = _TB[12] - _TA[12]
      const dyw = _TB[13] - _TA[13]
      const dzw = _TB[14] - _TA[14]
      const dl0 = _TA[0] * dxw + _TA[1] * dyw + _TA[2] * dzw
      const dl1 = _TA[4] * dxw + _TA[5] * dyw + _TA[6] * dzw
      const dl2 = _TA[8] * dxw + _TA[9] * dyw + _TA[10] * dzw
      const linearDiff = [dl0, dl1, dl2]

      _axisX[0] = _TA[0]; _axisX[1] = _TA[1]; _axisX[2] = _TA[2]
      _axisY[0] = _TA[4]; _axisY[1] = _TA[5]; _axisY[2] = _TA[6]
      _axisZ[0] = _TA[8]; _axisZ[1] = _TA[9]; _axisZ[2] = _TA[10]
      const linAxes = [_axisX, _axisY, _axisZ]

      for (let i = 0; i < 3; i++) {
        const lo = con.linearMin[i]
        const hi = con.linearMax[i]
        const curr = linearDiff[i]
        const ax = linAxes[i]

        // (rA × axis) and (rB × axis) — angular components of the linear
        // Jacobian. They give both the velocity-at-pivot calculation and the
        // angular impulse to apply when correcting along this axis.
        const cAx = _rA[1] * ax[2] - _rA[2] * ax[1]
        const cAy = _rA[2] * ax[0] - _rA[0] * ax[2]
        const cAz = _rA[0] * ax[1] - _rA[1] * ax[0]
        const cBx = _rB[1] * ax[2] - _rB[2] * ax[1]
        const cBy = _rB[2] * ax[0] - _rB[0] * ax[2]
        const cBz = _rB[0] * ax[1] - _rB[1] * ax[0]
        const cA2 = cAx * cAx + cAy * cAy + cAz * cAz
        const cB2 = cBx * cBx + cBy * cBy + cBz * cBz
        const denom = imA + imB + cA2 * iiA + cB2 * iiB
        if (denom <= 0) continue
        const jacInv = 1 / denom

        // Velocity at pivot points along axis: v_pivot = v_CG + ω × r.
        const vAaxX = lv[ai + 0] + av[ai + 1] * _rA[2] - av[ai + 2] * _rA[1]
        const vAaxY = lv[ai + 1] + av[ai + 2] * _rA[0] - av[ai + 0] * _rA[2]
        const vAaxZ = lv[ai + 2] + av[ai + 0] * _rA[1] - av[ai + 1] * _rA[0]
        const vBaxX = lv[bi + 0] + av[bi + 1] * _rB[2] - av[bi + 2] * _rB[1]
        const vBaxY = lv[bi + 1] + av[bi + 2] * _rB[0] - av[bi + 0] * _rB[2]
        const vBaxZ = lv[bi + 2] + av[bi + 0] * _rB[1] - av[bi + 1] * _rB[0]
        const relVel =
          (vBaxX - vAaxX) * ax[0] + (vBaxY - vAaxY) * ax[1] + (vBaxZ - vAaxZ) * ax[2]

        let targetVel = 0
        let active = false

        // Limit correction.
        if (lo <= hi) {
          let err = 0
          if (curr < lo) err = curr - lo
          else if (curr > hi) err = curr - hi
          if (err !== 0) {
            targetVel = -err * STOP_ERP * invDt
            active = true
          }
        }
        // Spring contribution: matches the relVel delta Bullet's clipped
        // motor produces per step. internalUpdateSprings sets
        // maxMotorImpulse = |k·δ|·dt, and the SI clamp pins the accumulated
        // impulse to that bound on iter 1 — so total relVel change per step
        // is ±k·δ·dt regardless of iteration count. We bake this directly
        // into the target velocity (single-iter convergence has the same
        // effect as 10 capped iterations).
        if (con.springEnabled[i]) {
          const k = con.springStiffness[i]
          const eq = con.equilibriumPoint[i]
          targetVel += -k * (curr - eq) * dt
          active = true
        }

        if (active) {
          const j = (targetVel - relVel) * jacInv
          // Apply +j·axis at TB.origin to body B; −j·axis at TA.origin to A.
          if (imA > 0) {
            lv[ai + 0] -= j * imA * ax[0]
            lv[ai + 1] -= j * imA * ax[1]
            lv[ai + 2] -= j * imA * ax[2]
            av[ai + 0] -= j * iiA * cAx
            av[ai + 1] -= j * iiA * cAy
            av[ai + 2] -= j * iiA * cAz
          }
          if (imB > 0) {
            lv[bi + 0] += j * imB * ax[0]
            lv[bi + 1] += j * imB * ax[1]
            lv[bi + 2] += j * imB * ax[2]
            av[bi + 0] += j * iiB * cBx
            av[bi + 1] += j * iiB * cBy
            av[bi + 2] += j * iiB * cBz
          }
        }
      }

      // -- Angular part ----------------------------------------------------
      // Refresh TA/TB after linear solve (lever-arm impulses changed velocities,
      // not positions yet — but cleaner to be consistent).
      const r00 = _TA[0]*_TB[0] + _TA[1]*_TB[1] + _TA[2]*_TB[2]
      const r01 = _TA[0]*_TB[4] + _TA[1]*_TB[5] + _TA[2]*_TB[6]
      const r02 = _TA[0]*_TB[8] + _TA[1]*_TB[9] + _TA[2]*_TB[10]
      const r10 = _TA[4]*_TB[0] + _TA[5]*_TB[1] + _TA[6]*_TB[2]
      const r11 = _TA[4]*_TB[4] + _TA[5]*_TB[5] + _TA[6]*_TB[6]
      const r12 = _TA[4]*_TB[8] + _TA[5]*_TB[9] + _TA[6]*_TB[10]
      const r20 = _TA[8]*_TB[0] + _TA[9]*_TB[1] + _TA[10]*_TB[2]
      const r21 = _TA[8]*_TB[4] + _TA[9]*_TB[5] + _TA[10]*_TB[6]
      const r22 = _TA[8]*_TB[8] + _TA[9]*_TB[9] + _TA[10]*_TB[10]
      matrixToEulerXYZ(r00, r01, r02, r10, r11, r12, r20, r21, r22, _euler)
      const angDiff = [_euler[0], _euler[1], _euler[2]]

      const a2x = _TA[8],  a2y = _TA[9],  a2z = _TA[10]
      const b0x = _TB[0],  b0y = _TB[1],  b0z = _TB[2]
      cross(a2x, a2y, a2z, b0x, b0y, b0z, _angAxisY); normalize3(_angAxisY)
      cross(_angAxisY[0], _angAxisY[1], _angAxisY[2], a2x, a2y, a2z, _angAxisX); normalize3(_angAxisX)
      cross(b0x, b0y, b0z, _angAxisY[0], _angAxisY[1], _angAxisY[2], _angAxisZ); normalize3(_angAxisZ)
      const angAxes = [_angAxisX, _angAxisY, _angAxisZ]

      const angDenom = iiA + iiB
      if (angDenom > 0) {
        const angJacInv = 1 / angDenom

        for (let i = 0; i < 3; i++) {
          const idx = i + 3
          const lo = con.angularMin[i]
          const hi = con.angularMax[i]
          const curr = angDiff[i]
          const ax = angAxes[i]

          const relAv =
            (av[bi + 0] - av[ai + 0]) * ax[0] +
            (av[bi + 1] - av[ai + 1]) * ax[1] +
            (av[bi + 2] - av[ai + 2]) * ax[2]

          // Sign flip vs linear: d(angDiff)/dt = −(ω_B − ω_A)·ax.
          let targetVel = 0
          let active = false

          if (lo <= hi) {
            let err = 0
            if (curr < lo) err = curr - lo
            else if (curr > hi) err = curr - hi
            if (err !== 0) {
              targetVel = err * STOP_ERP * invDt
              active = true
            }
          }
          if (con.springEnabled[idx]) {
            const k = con.springStiffness[idx]
            const eq = con.equilibriumPoint[idx]
            targetVel += k * (curr - eq) * dt
            active = true
          }

          if (active) {
            const j = (targetVel - relAv) * angJacInv
            if (iiA > 0) {
              av[ai + 0] -= j * iiA * ax[0]
              av[ai + 1] -= j * iiA * ax[1]
              av[ai + 2] -= j * iiA * ax[2]
            }
            if (iiB > 0) {
              av[bi + 0] += j * iiB * ax[0]
              av[bi + 1] += j * iiB * ax[1]
              av[bi + 2] += j * iiB * ax[2]
            }
          }
        }
      }
    }

    // -- Contact constraints (per iteration) -------------------------------
    // Bullet uses one normal row + two friction rows per contact, all run
    // alongside the joint rows in the same SI loop. We follow the same
    // structure but inline the math (no btSolverConstraint allocation).
    for (let ci = 0; ci < contacts.count; ci++) {
      solveContactRow(contacts.get(ci), invDt, lv, av, invMass, invInertia)
    }
  }
}

// Per-iteration solve of one contact: one push-only normal row + two friction
// rows whose impulse range is bounded by μ·appliedNormalImpulse. The
// `applied*` fields on the Contact persist across iterations to make the
// clamp behave like Bullet's accumulating SI solver.
function solveContactRow(
  c: Contact,
  invDt: number,
  lv: Float32Array,
  av: Float32Array,
  invMass: Float32Array,
  invInertia: Float32Array,
): void {
  const ai = c.bodyA * 3, bi = c.bodyB * 3
  const imA = invMass[c.bodyA], imB = invMass[c.bodyB]
  const iiA = invInertia[c.bodyA], iiB = invInertia[c.bodyB]
  if (imA === 0 && imB === 0) return
  const rAx = c.rAx, rAy = c.rAy, rAz = c.rAz
  const rBx = c.rBx, rBy = c.rBy, rBz = c.rBz
  const nx = c.nx, ny = c.ny, nz = c.nz

  // Velocity at contact point (linear + ω × r).
  const vAx = lv[ai + 0] + av[ai + 1] * rAz - av[ai + 2] * rAy
  const vAy = lv[ai + 1] + av[ai + 2] * rAx - av[ai + 0] * rAz
  const vAz = lv[ai + 2] + av[ai + 0] * rAy - av[ai + 1] * rAx
  const vBx = lv[bi + 0] + av[bi + 1] * rBz - av[bi + 2] * rBy
  const vBy = lv[bi + 1] + av[bi + 2] * rBx - av[bi + 0] * rBz
  const vBz = lv[bi + 2] + av[bi + 0] * rBy - av[bi + 1] * rBx
  const dvX = vBx - vAx
  const dvY = vBy - vAy
  const dvZ = vBz - vAz

  // -- Normal row -----------------------------------------------------------
  // (rA × n) and (rB × n) for jacDiagABInv.
  const cAxN = rAy * nz - rAz * ny
  const cAyN = rAz * nx - rAx * nz
  const cAzN = rAx * ny - rAy * nx
  const cBxN = rBy * nz - rBz * ny
  const cByN = rBz * nx - rBx * nz
  const cBzN = rBx * ny - rBy * nx
  const denomN = imA + imB +
    (cAxN * cAxN + cAyN * cAyN + cAzN * cAzN) * iiA +
    (cBxN * cBxN + cByN * cByN + cBzN * cBzN) * iiB
  if (denomN <= 0) return
  const jacInvN = 1 / denomN

  const relVelN = dvX * nx + dvY * ny + dvZ * nz
  // Position bias: depth · ERP · invDt over dt's worth of velocity. Signed —
  // positive depth pushes apart, depth ≤ 0 (within speculative margin but
  // not touching) gives a small negative bias the push-only clamp on
  // accumulated impulse silently drops to zero. Restitution kicks in only
  // above the bounce threshold so resting contacts don't oscillate.
  const posBias = c.depth * CONTACT_ERP * invDt
  let bounce = 0
  if (c.restitution > 0 && relVelN < -BOUNCE_THRESHOLD) {
    bounce = -c.restitution * relVelN
  }
  const targetN = posBias + bounce
  let dImpN = (targetN - relVelN) * jacInvN
  // Push-only clamp on accumulated impulse.
  const oldN = c.appliedNormalImpulse
  let newN = oldN + dImpN
  if (newN < 0) { newN = 0; dImpN = -oldN }
  c.appliedNormalImpulse = newN

  if (dImpN !== 0) {
    if (imA > 0) {
      lv[ai + 0] -= dImpN * imA * nx
      lv[ai + 1] -= dImpN * imA * ny
      lv[ai + 2] -= dImpN * imA * nz
      av[ai + 0] -= dImpN * iiA * cAxN
      av[ai + 1] -= dImpN * iiA * cAyN
      av[ai + 2] -= dImpN * iiA * cAzN
    }
    if (imB > 0) {
      lv[bi + 0] += dImpN * imB * nx
      lv[bi + 1] += dImpN * imB * ny
      lv[bi + 2] += dImpN * imB * nz
      av[bi + 0] += dImpN * iiB * cBxN
      av[bi + 1] += dImpN * iiB * cByN
      av[bi + 2] += dImpN * iiB * cBzN
    }
  }

  // -- Friction rows --------------------------------------------------------
  // Build a tangent basis from the normal. Pick the axis that's least aligned
  // with n to avoid a near-zero cross product, then normalize.
  let t1x: number, t1y: number, t1z: number
  if (Math.abs(nx) < 0.7071) {
    // (1,0,0) × n
    t1x = 0; t1y = -nz; t1z = ny
  } else {
    // (0,1,0) × n
    t1x = nz; t1y = 0; t1z = -nx
  }
  {
    const l = Math.hypot(t1x, t1y, t1z)
    if (l < 1e-8) return
    const inv = 1 / l
    t1x *= inv; t1y *= inv; t1z *= inv
  }
  // t2 = n × t1 (already unit since n ⊥ t1 and both unit)
  const t2x = ny * t1z - nz * t1y
  const t2y = nz * t1x - nx * t1z
  const t2z = nx * t1y - ny * t1x

  const muNormal = c.friction * c.appliedNormalImpulse

  applyFrictionRow(c, ai, bi, t1x, t1y, t1z,
    rAx, rAy, rAz, rBx, rBy, rBz, dvX, dvY, dvZ,
    imA, imB, iiA, iiB, lv, av, muNormal, 1)
  applyFrictionRow(c, ai, bi, t2x, t2y, t2z,
    rAx, rAy, rAz, rBx, rBy, rBz, dvX, dvY, dvZ,
    imA, imB, iiA, iiB, lv, av, muNormal, 2)
}

// One Coulomb-friction row: drives relative tangential velocity to zero with
// impulse bound = ±μ·appliedNormalImpulse. `slot` selects which friction
// accumulator on the contact to update (1 or 2).
function applyFrictionRow(
  c: Contact,
  ai: number, bi: number,
  tx: number, ty: number, tz: number,
  rAx: number, rAy: number, rAz: number,
  rBx: number, rBy: number, rBz: number,
  dvX: number, dvY: number, dvZ: number,
  imA: number, imB: number, iiA: number, iiB: number,
  lv: Float32Array, av: Float32Array,
  muNormal: number,
  slot: 1 | 2,
): void {
  if (muNormal <= 0) return
  const cAx = rAy * tz - rAz * ty
  const cAy = rAz * tx - rAx * tz
  const cAz = rAx * ty - rAy * tx
  const cBx = rBy * tz - rBz * ty
  const cBy = rBz * tx - rBx * tz
  const cBz = rBx * ty - rBy * tx
  const denom = imA + imB +
    (cAx * cAx + cAy * cAy + cAz * cAz) * iiA +
    (cBx * cBx + cBy * cBy + cBz * cBz) * iiB
  if (denom <= 0) return
  const jacInv = 1 / denom

  const relVel = dvX * tx + dvY * ty + dvZ * tz
  let dImp = (-relVel) * jacInv
  const old = slot === 1 ? c.appliedFrictionImpulse1 : c.appliedFrictionImpulse2
  let next = old + dImp
  if (next < -muNormal) { next = -muNormal; dImp = next - old }
  else if (next > muNormal) { next = muNormal; dImp = next - old }
  if (slot === 1) c.appliedFrictionImpulse1 = next
  else c.appliedFrictionImpulse2 = next

  if (dImp === 0) return
  if (imA > 0) {
    lv[ai + 0] -= dImp * imA * tx
    lv[ai + 1] -= dImp * imA * ty
    lv[ai + 2] -= dImp * imA * tz
    av[ai + 0] -= dImp * iiA * cAx
    av[ai + 1] -= dImp * iiA * cAy
    av[ai + 2] -= dImp * iiA * cAz
  }
  if (imB > 0) {
    lv[bi + 0] += dImp * imB * tx
    lv[bi + 1] += dImp * imB * ty
    lv[bi + 2] += dImp * imB * tz
    av[bi + 0] += dImp * iiB * cBx
    av[bi + 1] += dImp * iiB * cBy
    av[bi + 2] += dImp * iiB * cBz
  }
}

// --- helpers ----------------------------------------------------------------

function buildBodyMat(store: RigidBodyStore, i: number, out: Float32Array): void {
  const i3 = i * 3, i4 = i * 4
  Mat4.fromPositionRotationInto(
    store.positions[i3 + 0], store.positions[i3 + 1], store.positions[i3 + 2],
    store.orientations[i4 + 0], store.orientations[i4 + 1], store.orientations[i4 + 2], store.orientations[i4 + 3],
    out,
  )
}

function cross(ax: number, ay: number, az: number, bx: number, by: number, bz: number, out: Float32Array): void {
  out[0] = ay * bz - az * by
  out[1] = az * bx - ax * bz
  out[2] = ax * by - ay * bx
}

function normalize3(v: Float32Array): void {
  const l = Math.hypot(v[0], v[1], v[2])
  if (l > 1e-8) { const inv = 1 / l; v[0] *= inv; v[1] *= inv; v[2] *= inv }
}

// MatrixToEulerXYZ from Bullet (btGeneric6DofConstraint.cpp). r_ij = mat[i][j].
// Bullet's btGetMatrixElem(mat, k) maps k%3 → row, k/3 → col, so the asin
// pivot is mat[2][0] (= r20), not mat[0][2].
function matrixToEulerXYZ(
  r00: number, r01: number, _r02: number,
  r10: number, r11: number, _r12: number,
  r20: number, r21: number, r22: number,
  out: Float32Array,
): void {
  const fi = r20
  if (fi < 1) {
    if (fi > -1) {
      out[0] = Math.atan2(-r21, r22)
      out[1] = Math.asin(r20)
      out[2] = Math.atan2(-r10, r00)
    } else {
      out[0] = -Math.atan2(r01, r11)
      out[1] = -Math.PI * 0.5
      out[2] = 0
    }
  } else {
    out[0] = Math.atan2(r01, r11)
    out[1] = Math.PI * 0.5
    out[2] = 0
  }
}
