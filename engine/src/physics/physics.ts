import { Vec3, Quat, Mat4 } from "../math"
import type { Rigidbody, Joint, PhysicsOptions } from "./types"
import { RigidbodyType } from "./types"
import { RigidBodyStore } from "./body"
import { World } from "./world"
import { buildConstraints, type SixDofSpringConstraint } from "./constraint"
import { ContactPool } from "./contact"

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
  private contacts: ContactPool
  private firstFrame = true
  // Fixed-timestep accumulator. Matches Ammo's stepSimulation(dt, 10, 1/75)
  // exactly: physics runs at a consistent 75 Hz regardless of render rate
  // variance. Variable render dt makes spring impulse (∝ dt), damping
  // (pow(1-d, dt)), and integration (pos += vel·dt) all change frame-to-frame
  // — for a coupled cloth chain that prevents steady state and shows up as
  // dress-shaking jitter that survives every other contact-side fix. Bullet
  // doesn't have this problem because it always substeps internally.
  private timeAccum = 0
  private readonly fixedTimeStep = 1 / 75
  private readonly maxSubSteps = 10

  constructor(rigidbodies: Rigidbody[], joints: Joint[] = [], options?: PhysicsOptions) {
    this.rigidbodies = rigidbodies
    this.joints = joints
    this.options = options ?? {}
    this.store = new RigidBodyStore(rigidbodies)
    this.world = new World(new Vec3(0, -98, 0)) // MMD scale, cm/s²
    this.constraints = buildConstraints(rigidbodies, joints)
    this.contacts = new ContactPool()
  }

  setGravity(gravity: Vec3): void {
    this.world.setGravity(gravity)
  }
  getGravity(): Vec3 {
    return this.world.gravity
  }
  getRigidbodies(): Rigidbody[] {
    return this.rigidbodies
  }
  getJoints(): Joint[] {
    return this.joints
  }
  getOptions(): PhysicsOptions {
    return this.options
  }
  // Direct SoA access for the debug renderer / future tooling. Treat as
  // read-only — mutating these arrays will break the simulator.
  getStore(): RigidBodyStore {
    return this.store
  }

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

    // Pull static & kinematic bodies along with their bones. Done once per
    // render frame — kinematic targets don't change between substeps, same
    // as Bullet's internal pipeline. Pass render dt so kinematic velocities
    // can be derived from the bone-pose delta.
    this.syncFromBones(boneWorldMatrices, dt)

    // Fixed-timestep substeps. At 60 fps render with fixedTimeStep = 1/75,
    // we run ~1.25 substeps per frame on average (1, 1, 1, 2, 1, 1, 1, 2…).
    // The maxSubSteps cap prevents runaway after a long stall (tab
    // backgrounded etc.) — if we hit it, we drop residual accumulation
    // rather than letting debt pile up forever.
    this.timeAccum += dt
    let sub = 0
    while (this.timeAccum >= this.fixedTimeStep && sub < this.maxSubSteps) {
      this.world.step(this.store, this.constraints, this.contacts, this.fixedTimeStep)
      this.timeAccum -= this.fixedTimeStep
      sub++
    }
    if (sub === this.maxSubSteps) this.timeAccum = 0

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

      lv[i3 + 0] = 0
      lv[i3 + 1] = 0
      lv[i3 + 2] = 0
      av[i3 + 0] = 0
      av[i3 + 1] = 0
      av[i3 + 2] = 0
    }
  }

  // Static (FollowBone) and Kinematic bodies read their transform from bones.
  // Linear + angular velocities are derived from the bone-pose delta so the
  // joint solver sees fast-moving kinematic bodies actually moving — without
  // this, joints attached to a fast arm only see a *position* jump and can't
  // drag dependent cloth bodies along at the kinematic's pace, so cloth
  // visibly lags during quick limb motion. Mirrors Bullet's
  // btRigidBody::saveKinematicState → btTransformUtil::calculateVelocity.
  private syncFromBones(boneWorldMatrices: Mat4[], dt: number): void {
    const N = this.store.count
    const offsets = this.store.bodyOffsetMatrix
    const positions = this.store.positions
    const orientations = this.store.orientations
    const lv = this.store.linearVelocities
    const av = this.store.angularVelocities
    const types = this.store.type
    const boneIdx = this.store.boneIndex
    const invDt = dt > 0 ? 1 / dt : 0

    for (let i = 0; i < N; i++) {
      const t = types[i]
      if (t !== RigidbodyType.Static && t !== RigidbodyType.Kinematic) continue
      const b = boneIdx[i]
      if (b < 0 || b >= boneWorldMatrices.length) continue

      Mat4.multiplyArrays(boneWorldMatrices[b].values, 0, offsets, i * 16, _bodyMat, 0)

      const i3 = i * 3
      const i4 = i * 4

      // Save previous transform before overwriting — needed for velocity
      // diff. invDt = 0 (first frame / reset) skips the diff and zeros
      // velocities, matching the original behavior in those cases.
      const oldPx = positions[i3 + 0], oldPy = positions[i3 + 1], oldPz = positions[i3 + 2]
      const oldOx = orientations[i4 + 0], oldOy = orientations[i4 + 1]
      const oldOz = orientations[i4 + 2], oldOw = orientations[i4 + 3]

      positions[i3 + 0] = _bodyMat[12]
      positions[i3 + 1] = _bodyMat[13]
      positions[i3 + 2] = _bodyMat[14]
      Mat4.toQuatFromArrayInto(_bodyMat, 0, _scratchQuat)
      const newOx = _scratchQuat.x, newOy = _scratchQuat.y
      const newOz = _scratchQuat.z, newOw = _scratchQuat.w
      orientations[i4 + 0] = newOx
      orientations[i4 + 1] = newOy
      orientations[i4 + 2] = newOz
      orientations[i4 + 3] = newOw

      if (invDt === 0) {
        lv[i3 + 0] = 0; lv[i3 + 1] = 0; lv[i3 + 2] = 0
        av[i3 + 0] = 0; av[i3 + 1] = 0; av[i3 + 2] = 0
      } else {
        lv[i3 + 0] = (_bodyMat[12] - oldPx) * invDt
        lv[i3 + 1] = (_bodyMat[13] - oldPy) * invDt
        lv[i3 + 2] = (_bodyMat[14] - oldPz) * invDt

        // ω from quaternion delta. qDiff = qNew * conj(qOld); for the
        // small-angle range typical of one render-frame's worth of bone
        // motion, ω ≈ 2 · qDiff.xyz / dt. Pick the shortest-arc sign so
        // qDiff and −qDiff (same rotation) don't double the angular speed.
        const cox = -oldOx, coy = -oldOy, coz = -oldOz, cow = oldOw
        const dx = newOw * cox + newOx * cow + newOy * coz - newOz * coy
        const dy = newOw * coy - newOx * coz + newOy * cow + newOz * cox
        const dz = newOw * coz + newOx * coy - newOy * cox + newOz * cow
        const dw = newOw * cow - newOx * cox - newOy * coy - newOz * coz
        const sign = dw < 0 ? -1 : 1
        av[i3 + 0] = 2 * sign * dx * invDt
        av[i3 + 1] = 2 * sign * dy * invDt
        av[i3 + 2] = 2 * sign * dz * invDt
      }
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
        positions[i3 + 0],
        positions[i3 + 1],
        positions[i3 + 2],
        orientations[i4 + 0],
        orientations[i4 + 1],
        orientations[i4 + 2],
        orientations[i4 + 3],
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
