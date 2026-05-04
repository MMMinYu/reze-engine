import { Mat4, Quat } from "../math"
import { RigidbodyType, RigidbodyShape, type Rigidbody } from "./types"

// SoA storage for all rigid bodies in a RezePhysics world.
// Fields are intentionally minimal for the gravity-only stage; broadphase AABBs,
// world inertia tensors, friction, group/mask, etc. will be added as the
// solver pipeline grows.
export class RigidBodyStore {
  readonly count: number

  // Per-body state (parallel arrays).
  readonly positions: Float32Array         // 3*N
  readonly orientations: Float32Array      // 4*N (xyzw)
  readonly linearVelocities: Float32Array  // 3*N
  readonly angularVelocities: Float32Array // 3*N

  // Per-body constants (set once from PMX, not mutated by the simulator).
  readonly invMass: Float32Array       // N (0 for static / kinematic)
  // Scalar isotropic inverse inertia. Real bodies have a 3x3 tensor, but
  // PMX shapes are roughly compact so a single I⁻¹ is good enough — and *much*
  // better than collapsing to invMass (which under-rotates by 100-1000×).
  // Sphere:  I = (2/5)·m·r²;  Box: I = (1/3)·m·max(a,b,c)²
  // Capsule: I = (1/3)·m·(half-height)² (treat as cylinder, transverse axis).
  readonly invInertia: Float32Array    // N (0 for static / kinematic)
  readonly linearDamping: Float32Array // N
  readonly angularDamping: Float32Array// N
  readonly type: Uint8Array            // N (RigidbodyType)
  readonly boneIndex: Int32Array       // N (-1 if unattached)

  // Bone↔body coupling. bodyOffsetMatrix[i] = boneInverseBind × shapeWorldBind.
  // bodyWorld = boneWorld × bodyOffsetMatrix; boneWorld = bodyWorld × bodyOffsetInverse.
  // Filled by computeBoneOffsets() — until then, both arrays are zero.
  readonly bodyOffsetMatrix: Float32Array  // 16*N column-major
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
        pos[i3 + 0], pos[i3 + 1], pos[i3 + 2],
        ori[i4 + 0], ori[i4 + 1], ori[i4 + 2], ori[i4 + 3],
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
  out[offset + 0] = 1; out[offset + 1] = 0; out[offset + 2] = 0; out[offset + 3] = 0
  out[offset + 4] = 0; out[offset + 5] = 1; out[offset + 6] = 0; out[offset + 7] = 0
  out[offset + 8] = 0; out[offset + 9] = 0; out[offset + 10] = 1; out[offset + 11] = 0
  out[offset + 12] = 0; out[offset + 13] = 0; out[offset + 14] = 0; out[offset + 15] = 1
}
