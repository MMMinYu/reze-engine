import { Vec3, Quat, Mat4 } from "../math"
import type { Rigidbody, Joint, PhysicsOptions } from "./types"
import { RigidbodyType } from "./types"
import { RigidBodyStore } from "./body"
import { World } from "./world"
import { buildConstraints, type SixDofSpringConstraint } from "./constraint"

// Scratch storage shared across all instances — RezePhysics step() runs
// synchronously and never re-enters itself, so reusing module-local buffers
// is safe and avoids per-frame allocation.
const _bodyMat = new Float32Array(16)
const _boneMat = new Float32Array(16)
const _scratchQuat = new Quat(0, 0, 0, 1)

// reze-physics public class. API matches the prior Ammo-backed Physics so the
// engine integration in engine.ts is unchanged.
//
// Current behavior (gravity-only stage):
//   - Static / kinematic bodies follow their bone via boneWorld × bodyOffset.
//   - Dynamic bodies integrate under gravity + damping; their world transforms
//     are written back to bones via bodyWorld × bodyOffsetInverse.
//   - No contacts, no joints. Hair tips, skirts, etc. will free-fall until the
//     6DOF spring constraint solver lands.
export class RezePhysics {
  private rigidbodies: Rigidbody[]
  private joints: Joint[]
  private options: PhysicsOptions
  private store: RigidBodyStore
  private world: World
  private constraints: SixDofSpringConstraint[]
  private firstFrame = true

  constructor(rigidbodies: Rigidbody[], joints: Joint[] = [], options?: PhysicsOptions) {
    this.rigidbodies = rigidbodies
    this.joints = joints
    this.options = options ?? {}
    this.store = new RigidBodyStore(rigidbodies)
    this.world = new World(new Vec3(0, -98, 0)) // MMD scale, cm/s²
    this.constraints = buildConstraints(rigidbodies, joints, this.options)
  }

  setGravity(gravity: Vec3): void { this.world.setGravity(gravity) }
  getGravity(): Vec3 { return this.world.gravity }
  getRigidbodies(): Rigidbody[] { return this.rigidbodies }
  getJoints(): Joint[] { return this.joints }
  getOptions(): PhysicsOptions { return this.options }
  // Direct SoA access for the debug renderer / future tooling. Treat as
  // read-only — mutating these arrays will break the simulator.
  getStore(): RigidBodyStore { return this.store }

  getRigidbodyTransforms(): Array<{ position: Vec3; rotation: Quat }> {
    const out: Array<{ position: Vec3; rotation: Quat }> = []
    const pos = this.store.positions
    const ori = this.store.orientations
    for (let i = 0; i < this.store.count; i++) {
      const i3 = i * 3
      const i4 = i * 4
      out.push({
        position: new Vec3(pos[i3 + 0], pos[i3 + 1], pos[i3 + 2]),
        rotation: new Quat(ori[i4 + 0], ori[i4 + 1], ori[i4 + 2], ori[i4 + 3]),
      })
    }
    return out
  }

  // Snap dynamic bodies back to their bone-driven pose, zero velocities.
  // Used when the simulation diverged or the user scrubbed the timeline.
  reset(boneWorldMatrices: Mat4[]): void {
    if (this.firstFrame) return
    this.snapBodiesToBones(boneWorldMatrices)
  }

  step(dt: number, boneWorldMatrices: Mat4[], boneInverseBindMatrices: Float32Array): void {
    if (this.firstFrame) {
      this.store.computeBoneOffsets(boneInverseBindMatrices)
      // Start every body at its bone-driven world pose, not the PMX bind pose,
      // so animations that skip frame 0 don't pop bodies on first step.
      this.snapBodiesToBones(boneWorldMatrices)
      this.firstFrame = false
    }

    // Pull static & kinematic bodies along with their bones.
    this.syncFromBones(boneWorldMatrices)

    // Integrate dynamics + solve joint constraints.
    this.world.step(this.store, this.constraints, dt)

    // Push dynamic body transforms back to their bones.
    this.applyDynamicsToBones(boneWorldMatrices)
  }

  // For every bone-bound body, set its world transform to boneWorld × bodyOffset
  // and clear its velocities. Used on first step + on reset.
  private snapBodiesToBones(boneWorldMatrices: Mat4[]): void {
    const N = this.store.count
    const offsets = this.store.bodyOffsetMatrix
    const positions = this.store.positions
    const orientations = this.store.orientations
    const lv = this.store.linearVelocities
    const av = this.store.angularVelocities
    const boneIdx = this.store.boneIndex

    for (let i = 0; i < N; i++) {
      const b = boneIdx[i]
      if (b < 0 || b >= boneWorldMatrices.length) continue

      Mat4.multiplyArrays(boneWorldMatrices[b].values, 0, offsets, i * 16, _bodyMat, 0)

      const i3 = i * 3
      const i4 = i * 4
      positions[i3 + 0] = _bodyMat[12]
      positions[i3 + 1] = _bodyMat[13]
      positions[i3 + 2] = _bodyMat[14]
      Mat4.toQuatFromArrayInto(_bodyMat, 0, _scratchQuat)
      orientations[i4 + 0] = _scratchQuat.x
      orientations[i4 + 1] = _scratchQuat.y
      orientations[i4 + 2] = _scratchQuat.z
      orientations[i4 + 3] = _scratchQuat.w

      lv[i3 + 0] = 0; lv[i3 + 1] = 0; lv[i3 + 2] = 0
      av[i3 + 0] = 0; av[i3 + 1] = 0; av[i3 + 2] = 0
    }
  }

  // Static (FollowBone) and Kinematic bodies read their transform from bones.
  // Velocities are zeroed so they don't carry phantom momentum into contacts
  // once the solver lands.
  private syncFromBones(boneWorldMatrices: Mat4[]): void {
    const N = this.store.count
    const offsets = this.store.bodyOffsetMatrix
    const positions = this.store.positions
    const orientations = this.store.orientations
    const lv = this.store.linearVelocities
    const av = this.store.angularVelocities
    const types = this.store.type
    const boneIdx = this.store.boneIndex

    for (let i = 0; i < N; i++) {
      const t = types[i]
      if (t !== RigidbodyType.Static && t !== RigidbodyType.Kinematic) continue
      const b = boneIdx[i]
      if (b < 0 || b >= boneWorldMatrices.length) continue

      Mat4.multiplyArrays(boneWorldMatrices[b].values, 0, offsets, i * 16, _bodyMat, 0)

      const i3 = i * 3
      const i4 = i * 4
      positions[i3 + 0] = _bodyMat[12]
      positions[i3 + 1] = _bodyMat[13]
      positions[i3 + 2] = _bodyMat[14]
      Mat4.toQuatFromArrayInto(_bodyMat, 0, _scratchQuat)
      orientations[i4 + 0] = _scratchQuat.x
      orientations[i4 + 1] = _scratchQuat.y
      orientations[i4 + 2] = _scratchQuat.z
      orientations[i4 + 3] = _scratchQuat.w

      lv[i3 + 0] = 0; lv[i3 + 1] = 0; lv[i3 + 2] = 0
      av[i3 + 0] = 0; av[i3 + 1] = 0; av[i3 + 2] = 0
    }
  }

  // Dynamic bodies write their transform back to the bone matrix:
  //   boneWorld = bodyWorld × bodyOffsetInverse.
  private applyDynamicsToBones(boneWorldMatrices: Mat4[]): void {
    const N = this.store.count
    const inv = this.store.bodyOffsetInverse
    const positions = this.store.positions
    const orientations = this.store.orientations
    const types = this.store.type
    const boneIdx = this.store.boneIndex

    for (let i = 0; i < N; i++) {
      if (types[i] !== RigidbodyType.Dynamic) continue
      const b = boneIdx[i]
      if (b < 0 || b >= boneWorldMatrices.length) continue

      const i3 = i * 3
      const i4 = i * 4
      Mat4.fromPositionRotationInto(
        positions[i3 + 0], positions[i3 + 1], positions[i3 + 2],
        orientations[i4 + 0], orientations[i4 + 1], orientations[i4 + 2], orientations[i4 + 3],
        _bodyMat,
      )
      Mat4.multiplyArrays(_bodyMat, 0, inv, i * 16, _boneMat, 0)

      // Sanity gate against NaN / extreme values — silently drop the update.
      if (Number.isFinite(_boneMat[0]) && Math.abs(_boneMat[0]) < 1e6) {
        boneWorldMatrices[b].values.set(_boneMat)
      }
    }
  }
}
