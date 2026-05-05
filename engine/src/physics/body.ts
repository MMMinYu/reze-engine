import { Mat4, Quat } from "../math"
import { RigidbodyType, RigidbodyShape, type Rigidbody } from "./types"

// SoA storage for all rigid bodies in a RezePhysics world. Holds per-body
// state (positions, velocities), constants (mass/inertia/damping/group/mask),
// the bind-pose↔bone coupling matrices, and a per-step AABB for broadphase.
export class RigidBodyStore {
  readonly count: number

  // Per-body state (parallel arrays).
  readonly positions: Float32Array // 3*N
  readonly orientations: Float32Array // 4*N (xyzw)
  readonly linearVelocities: Float32Array // 3*N
  readonly angularVelocities: Float32Array // 3*N

  // Per-body constants (set once from PMX, not mutated by the simulator).
  readonly invMass: Float32Array // N (0 for static / kinematic)
  // Scalar isotropic inverse inertia. Real bodies have a 3x3 tensor, but
  // PMX shapes are roughly compact so a single I⁻¹ is good enough — and *much*
  // better than collapsing to invMass (which under-rotates by 100-1000×).
  // Sphere:  I = (2/5)·m·r²;  Box: I = (1/3)·m·max(a,b,c)²
  // Capsule: I = (1/12)·m·(3r² + h²) (cylinder, transverse axis).
  readonly invInertia: Float32Array // N (0 for static / kinematic)
  readonly linearDamping: Float32Array // N
  readonly angularDamping: Float32Array // N
  readonly type: Uint8Array // N (RigidbodyType)
  readonly boneIndex: Int32Array // N (-1 if unattached)
  readonly friction: Float32Array // N (Coulomb friction coefficient)
  readonly restitution: Float32Array // N (bounciness, 0..1)

  // Collision filtering. PMX has 16 groups; group is the body's own index
  // (1..16, stored as zero-based 0..15) and collisionMask is the set of
  // groups it *will not* collide with — invert to get "willCollide" mask
  // (the form solvers actually want to test).
  readonly collisionGroup: Uint16Array // N (single bit, 1<<groupIndex)
  readonly willCollideMask: Uint16Array // N (16 bits, 1 = pair allowed)

  // Shape descriptor for narrowphase. Same layout as PMX.
  readonly shape: Uint8Array // N (RigidbodyShape)
  readonly size: Float32Array // 3*N (semantics depend on shape)

  // Per-step AABB (world space, axis-aligned). Refreshed by updateAabbs()
  // each step from current position + orientation + shape.
  readonly aabbMin: Float32Array // 3*N
  readonly aabbMax: Float32Array // 3*N

  // Bone↔body coupling. bodyOffsetMatrix[i] = boneInverseBind × shapeWorldBind.
  // bodyWorld = boneWorld × bodyOffsetMatrix; boneWorld = bodyWorld × bodyOffsetInverse.
  // Filled by computeBoneOffsets() — until then, both arrays are zero.
  readonly bodyOffsetMatrix: Float32Array // 16*N column-major
  readonly bodyOffsetInverse: Float32Array // 16*N column-major
  private boneOffsetsReady = false

  constructor(rigidbodies: Rigidbody[]) {
    const N = rigidbodies.length
    this.count = N

    this.positions = new Float32Array(N * 3)
    this.orientations = new Float32Array(N * 4)
    this.linearVelocities = new Float32Array(N * 3)
    this.angularVelocities = new Float32Array(N * 3)
    this.invMass = new Float32Array(N)
    this.invInertia = new Float32Array(N)
    this.linearDamping = new Float32Array(N)
    this.angularDamping = new Float32Array(N)
    this.type = new Uint8Array(N)
    this.boneIndex = new Int32Array(N)
    this.bodyOffsetMatrix = new Float32Array(N * 16)
    this.bodyOffsetInverse = new Float32Array(N * 16)
    this.friction = new Float32Array(N)
    this.restitution = new Float32Array(N)
    this.collisionGroup = new Uint16Array(N)
    this.willCollideMask = new Uint16Array(N)
    this.shape = new Uint8Array(N)
    this.size = new Float32Array(N * 3)
    this.aabbMin = new Float32Array(N * 3)
    this.aabbMax = new Float32Array(N * 3)

    for (let i = 0; i < N; i++) {
      const rb = rigidbodies[i]
      const i3 = i * 3
      const i4 = i * 4

      this.positions[i3 + 0] = rb.shapePosition.x
      this.positions[i3 + 1] = rb.shapePosition.y
      this.positions[i3 + 2] = rb.shapePosition.z

      const q = Quat.fromEuler(rb.shapeRotation.x, rb.shapeRotation.y, rb.shapeRotation.z)
      this.orientations[i4 + 0] = q.x
      this.orientations[i4 + 1] = q.y
      this.orientations[i4 + 2] = q.z
      this.orientations[i4 + 3] = q.w

      const dynamic = rb.type === RigidbodyType.Dynamic && rb.mass > 0
      this.invMass[i] = dynamic ? 1 / rb.mass : 0
      this.invInertia[i] = dynamic ? computeInvInertia(rb) : 0
      this.linearDamping[i] = rb.linearDamping
      this.angularDamping[i] = rb.angularDamping
      this.type[i] = rb.type
      this.boneIndex[i] = rb.boneIndex
      this.friction[i] = rb.friction
      this.restitution[i] = rb.restitution
      // PMX `group` is 1..16 (or 0..15 zero-based). Encode as single-bit set.
      // collisionMask in PMX lists groups this body WILL collide with — store
      // directly so solvers can do `(maskA & groupB) && (maskB & groupA)`.
      this.collisionGroup[i] = 1 << (rb.group & 0xf)
      this.willCollideMask[i] = rb.collisionMask & 0xffff
      this.shape[i] = rb.shape
      this.size[i * 3 + 0] = rb.size.x
      this.size[i * 3 + 1] = rb.size.y
      this.size[i * 3 + 2] = rb.size.z
    }
  }

  // Refresh world-space AABBs for every body. Called once per step before
  // broadphase. Includes a small inflation margin so contacts stay paired
  // across velocity-induced jitter without re-checking AABBs each iteration.
  updateAabbs(margin = 0.5): void {
    const N = this.count
    const pos = this.positions
    const ori = this.orientations
    const shapes = this.shape
    const sz = this.size
    const minA = this.aabbMin
    const maxA = this.aabbMax

    for (let i = 0; i < N; i++) {
      const i3 = i * 3
      const i4 = i * 4
      const px = pos[i3 + 0],
        py = pos[i3 + 1],
        pz = pos[i3 + 2]
      let hx = 0,
        hy = 0,
        hz = 0

      switch (shapes[i]) {
        case RigidbodyShape.Sphere: {
          const r = sz[i3 + 0]
          hx = hy = hz = r
          break
        }
        case RigidbodyShape.Box: {
          // Conservative AABB of an OBB: half-extents projected by |R|·size.
          const qx = ori[i4 + 0],
            qy = ori[i4 + 1],
            qz = ori[i4 + 2],
            qw = ori[i4 + 3]
          const x2 = qx + qx,
            y2 = qy + qy,
            z2 = qz + qz
          const xx = qx * x2,
            yy = qy * y2,
            zz = qz * z2
          const xy = qx * y2,
            xz = qx * z2,
            yz = qy * z2
          const wx = qw * x2,
            wy = qw * y2,
            wz = qw * z2
          const m00 = Math.abs(1 - (yy + zz)),
            m01 = Math.abs(xy + wz),
            m02 = Math.abs(xz - wy)
          const m10 = Math.abs(xy - wz),
            m11 = Math.abs(1 - (xx + zz)),
            m12 = Math.abs(yz + wx)
          const m20 = Math.abs(xz + wy),
            m21 = Math.abs(yz - wx),
            m22 = Math.abs(1 - (xx + yy))
          const sx = sz[i3 + 0],
            sy = sz[i3 + 1],
            szz = sz[i3 + 2]
          hx = m00 * sx + m01 * sy + m02 * szz
          hy = m10 * sx + m11 * sy + m12 * szz
          hz = m20 * sx + m21 * sy + m22 * szz
          break
        }
        case RigidbodyShape.Capsule: {
          // Capsule is a sphere swept along Y in body-local: AABB = sphere
          // around each cap, unioned. After rotation, the cap offsets become
          // ±halfHeight·R·ŷ, so AABB half-extents = |R·ŷ|·halfH + radius.
          const r = sz[i3 + 0]
          const halfH = sz[i3 + 1] * 0.5
          const qx = ori[i4 + 0],
            qy = ori[i4 + 1],
            qz = ori[i4 + 2],
            qw = ori[i4 + 3]
          // R · (0,1,0) = (2(xy − wz), 1 − 2(xx + zz), 2(yz + wx))
          const rx = 2 * (qx * qy - qw * qz)
          const ry = 1 - 2 * (qx * qx + qz * qz)
          const rz = 2 * (qy * qz + qw * qx)
          hx = Math.abs(rx) * halfH + r
          hy = Math.abs(ry) * halfH + r
          hz = Math.abs(rz) * halfH + r
          break
        }
      }

      minA[i3 + 0] = px - hx - margin
      minA[i3 + 1] = py - hy - margin
      minA[i3 + 2] = pz - hz - margin
      maxA[i3 + 0] = px + hx + margin
      maxA[i3 + 1] = py + hy + margin
      maxA[i3 + 2] = pz + hz + margin
    }
  }

  // Compute bodyOffsetMatrix + bodyOffsetInverse for every body bound to a bone.
  // Called once on the first physics step, when bone inverse-bind matrices are
  // available. Bodies with boneIndex < 0 get identity offsets.
  computeBoneOffsets(boneInverseBindMatrices: Float32Array): void {
    const N = this.count
    const offsets = this.bodyOffsetMatrix
    const inverses = this.bodyOffsetInverse
    const ori = this.orientations
    const pos = this.positions
    const boneIdx = this.boneIndex
    const totalBones = boneInverseBindMatrices.length / 16

    const shapeWorldBind = _scratchA
    const offsetMat = _scratchB

    for (let i = 0; i < N; i++) {
      const dst = i * 16
      const b = boneIdx[i]

      if (b < 0 || b >= totalBones) {
        identity16(offsets, dst)
        identity16(inverses, dst)
        continue
      }

      // shapeWorldBind = T(shapePosition) · R(shapeRotation)
      const i3 = i * 3
      const i4 = i * 4
      Mat4.fromPositionRotationInto(
        pos[i3 + 0],
        pos[i3 + 1],
        pos[i3 + 2],
        ori[i4 + 0],
        ori[i4 + 1],
        ori[i4 + 2],
        ori[i4 + 3],
        shapeWorldBind,
      )

      // bodyOffset = boneInverseBind × shapeWorldBind
      Mat4.multiplyArrays(boneInverseBindMatrices, b * 16, shapeWorldBind, 0, offsetMat, 0)

      // Copy into offsets[dst] and invert into inverses[dst].
      offsets.set(offsetMat, dst)
      const inverseTmp = _scratchC
      const ok = Mat4.inverseInto(offsetMat, inverseTmp)
      if (ok) {
        inverses.set(inverseTmp, dst)
      } else {
        identity16(inverses, dst)
      }
    }

    this.boneOffsetsReady = true
  }

  isBoneOffsetsReady(): boolean {
    return this.boneOffsetsReady
  }
}

// Module-local scratch matrices, used only inside computeBoneOffsets above and
// reset on every call so concurrent calls would still be safe per-instance
// (we don't run RezePhysics concurrently).
const _scratchA = new Float32Array(16)
const _scratchB = new Float32Array(16)
const _scratchC = new Float32Array(16)

// Scalar isotropic inverse inertia. Conservative analytical formulas per shape
// (treated as a single transverse-axis value — exact along that axis, slight
// over-/under-estimate on others). Skips static bodies (mass = 0) by returning
// 0; the solver guards against ÷0 separately.
function computeInvInertia(rb: Rigidbody): number {
  const m = rb.mass
  if (m <= 0) return 0
  let I: number
  switch (rb.shape) {
    case RigidbodyShape.Sphere: {
      const r = rb.size.x
      I = 0.4 * m * r * r
      break
    }
    case RigidbodyShape.Box: {
      // Use the largest half-extent — produces a single isotropic value that
      // doesn't under-rotate the long axis.
      const a = Math.max(rb.size.x, rb.size.y, rb.size.z)
      I = (1 / 3) * m * a * a
      break
    }
    case RigidbodyShape.Capsule: {
      // Cylinder transverse axis: I = (1/12)·m·(3r² + h²) where h = full height.
      const r = rb.size.x
      const h = rb.size.y
      I = (1 / 12) * m * (3 * r * r + h * h)
      break
    }
    default:
      I = m
  }
  return I > 0 ? 1 / I : 0
}

function identity16(out: Float32Array, offset: number): void {
  out[offset + 0] = 1
  out[offset + 1] = 0
  out[offset + 2] = 0
  out[offset + 3] = 0
  out[offset + 4] = 0
  out[offset + 5] = 1
  out[offset + 6] = 0
  out[offset + 7] = 0
  out[offset + 8] = 0
  out[offset + 9] = 0
  out[offset + 10] = 1
  out[offset + 11] = 0
  out[offset + 12] = 0
  out[offset + 13] = 0
  out[offset + 14] = 0
  out[offset + 15] = 1
}
