import { Mat4, Quat, Vec3, easeInOut, bezierInterpolate } from "./math"
import { Rigidbody, Joint, Physics } from "./physics"
import { IKSolverSystem } from "./ik-solver"
import { VMDKeyFrame, VMDLoader, BoneFrame, MorphFrame } from "./vmd-loader"

const VERTEX_STRIDE = 8

export interface Texture {
  path: string
  name: string
}

export interface Material {
  name: string
  diffuse: [number, number, number, number]
  specular: [number, number, number]
  ambient: [number, number, number]
  shininess: number
  diffuseTextureIndex: number
  normalTextureIndex: number
  sphereTextureIndex: number
  sphereMode: number
  toonTextureIndex: number
  edgeFlag: number
  edgeColor: [number, number, number, number]
  edgeSize: number
  vertexCount: number
  isEye?: boolean // New: marks eye materials
  isFace?: boolean // New: marks face/skin materials
  isHair?: boolean // New: marks hair materials
}

export interface Bone {
  name: string
  parentIndex: number // -1 if no parent
  bindTranslation: [number, number, number]
  children: number[] // child bone indices (built on skeleton creation)
  appendParentIndex?: number // index of the bone to inherit from
  appendRatio?: number // 0..1
  appendRotate?: boolean
  appendMove?: boolean
  ikTargetIndex?: number // IK target bone index (if this bone is an IK effector)
  ikIteration?: number // IK iteration count
  ikLimitAngle?: number // IK rotation constraint (radians)
  ikLinks?: IKLink[] // IK chain links
}

// IK link with angle constraints
export interface IKLink {
  boneIndex: number
  hasLimit: boolean
  minAngle?: Vec3 // Minimum Euler angles (radians)
  maxAngle?: Vec3 // Maximum Euler angles (radians)
}

// IK solver definition
export interface IKSolver {
  index: number
  ikBoneIndex: number // Effector bone (the bone that should reach the target)
  targetBoneIndex: number // Target bone
  iterationCount: number
  limitAngle: number // Max rotation per iteration (radians)
  links: IKLink[] // Chain bones from effector to root
}

// IK chain info per bone (runtime state)
export interface IKChainInfo {
  ikRotation: Quat // Accumulated IK rotation
  localRotation: Quat // Cached local rotation before IK
}

export interface Skeleton {
  bones: Bone[]
  inverseBindMatrices: Float32Array // One inverse-bind matrix per bone (column-major mat4, 16 floats per bone)
}

export interface Skinning {
  joints: Uint16Array // length = vertexCount * 4, bone indices per vertex
  weights: Uint8Array // UNORM8, length = vertexCount * 4, sums ~ 255 per-vertex
}

// Vertex morph offset data
export interface VertexMorphOffset {
  vertexIndex: number
  positionOffset: [number, number, number]
}

// Group morph reference (for type 0)
export interface GroupMorphReference {
  morphIndex: number
  ratio: number
}

// Morph definition
export interface Morph {
  name: string
  type: number // 0=group, 1=vertex, 2=bone, 3=UV, 8=material
  vertexOffsets: VertexMorphOffset[] // Only for type 1 (vertex morph)
  groupReferences?: GroupMorphReference[] // Only for type 0 (group morph)
}

export interface Morphing {
  morphs: Morph[]
  offsetsBuffer: Float32Array // Dense buffer: morphCount * vertexCount * 3 floats
}

// Runtime skeleton pose state (updated each frame)
export interface SkeletonRuntime {
  nameIndex: Record<string, number> // Cached lookup: bone name -> bone index (built on initialization)
  localRotations: Float32Array // quat per bone (x,y,z,w) length = boneCount*4
  localTranslations: Float32Array // vec3 per bone length = boneCount*3
  worldMatrices: Float32Array // mat4 per bone length = boneCount*16
  ikChainInfo?: IKChainInfo[] // IK chain info per bone (only for IK chain bones)
  ikSolvers?: IKSolver[] // All IK solvers in the model
}

// Runtime morph state
export interface MorphRuntime {
  nameIndex: Record<string, number> // Cached lookup: morph name -> morph index
  weights: Float32Array // One weight per morph (0.0 to 1.0)
}

// Tween state - combines rotation, translation, and morph tweens
// All tweens share the same time reference to avoid conflicts
interface TweenState {
  // Bone rotation tweens
  rotActive: Uint8Array // 0/1 per bone
  rotStartQuat: Float32Array // quat per bone (x,y,z,w)
  rotTargetQuat: Float32Array // quat per bone (x,y,z,w)
  rotStartTimeMs: Float32Array // one float per bone (ms)
  rotDurationMs: Float32Array // one float per bone (ms)

  // Bone translation tweens
  transActive: Uint8Array // 0/1 per bone
  transStartVec: Float32Array // vec3 per bone (x,y,z)
  transTargetVec: Float32Array // vec3 per bone (x,y,z)
  transStartTimeMs: Float32Array // one float per bone (ms)
  transDurationMs: Float32Array // one float per bone (ms)

  // Morph weight tweens
  morphActive: Uint8Array // 0/1 per morph
  morphStartWeight: Float32Array // one float per morph
  morphTargetWeight: Float32Array // one float per morph
  morphStartTimeMs: Float32Array // one float per morph (ms)
  morphDurationMs: Float32Array // one float per morph (ms)
}

export class Model {
  private vertexData: Float32Array<ArrayBuffer>
  private baseVertexData: Float32Array<ArrayBuffer> // Original vertex data before morphing
  private vertexCount: number
  private indexData: Uint32Array<ArrayBuffer>
  private textures: Texture[] = []
  private materials: Material[] = []
  // Static skeleton/skinning (not necessarily serialized yet)
  private skeleton: Skeleton
  private skinning: Skinning

  // Static morph data (from PMX)
  private morphing: Morphing

  // Physics data from PMX
  private rigidbodies: Rigidbody[] = []
  private joints: Joint[] = []

  // Runtime skeleton pose state (updated each frame)
  private runtimeSkeleton!: SkeletonRuntime

  // Runtime morph state
  private runtimeMorph!: MorphRuntime
  private morphsDirty: boolean = false // Flag indicating if morphs need to be applied

  // Cached identity matrices to avoid allocations in computeWorldMatrices
  private cachedIdentityMat1 = Mat4.identity()
  private cachedIdentityMat2 = Mat4.identity()

  // Cached skin matrices array to avoid allocations in getSkinMatrices
  private cachedSkinMatrices?: Float32Array

  private tweenState!: TweenState
  private tweenTimeMs: number = 0 // Time tracking for tweens (milliseconds)

  // Animation runtime
  private animationData: VMDKeyFrame[] | null = null
  private boneTracks: Map<string, Array<{ boneFrame: BoneFrame; time: number }>> = new Map()
  private morphTracks: Map<string, Array<{ morphFrame: MorphFrame; time: number }>> = new Map()
  private animationDuration: number = 0
  private isPlaying: boolean = false
  private isPaused: boolean = false
  private animationTime: number = 0 // Current time in animation (seconds)

  // Physics runtime
  private physics: Physics | null = null

  constructor(
    vertexData: Float32Array<ArrayBuffer>,
    indexData: Uint32Array<ArrayBuffer>,
    textures: Texture[],
    materials: Material[],
    skeleton: Skeleton,
    skinning: Skinning,
    morphing: Morphing,
    rigidbodies: Rigidbody[] = [],
    joints: Joint[] = []
  ) {
    // Store base vertex data (original positions before morphing)
    this.baseVertexData = new Float32Array(vertexData)
    this.vertexData = vertexData
    this.vertexCount = vertexData.length / VERTEX_STRIDE
    this.indexData = indexData
    this.textures = textures
    this.materials = materials
    this.skeleton = skeleton
    this.skinning = skinning
    this.morphing = morphing
    this.rigidbodies = rigidbodies
    this.joints = joints

    if (this.skeleton.bones.length == 0) {
      throw new Error("Model has no bones")
    }

    this.initializeRuntimeSkeleton()
    this.initializeRuntimeMorph()
    this.initializeTweenBuffers()
    this.applyMorphs() // Apply initial morphs (all weights are 0, so no change)

    // Initialize physics if rigidbodies exist
    if (rigidbodies.length > 0) {
      this.physics = new Physics(rigidbodies, joints)
      console.log(`[Model] Physics initialized with ${rigidbodies.length} rigidbodies`)
    } else {
      console.log("[Model] No rigidbodies found, physics disabled")
    }
  }

  private initializeRuntimeSkeleton(): void {
    const boneCount = this.skeleton.bones.length

    this.runtimeSkeleton = {
      localRotations: new Float32Array(boneCount * 4),
      localTranslations: new Float32Array(boneCount * 3),
      worldMatrices: new Float32Array(boneCount * 16),
      nameIndex: this.skeleton.bones.reduce((acc, bone, index) => {
        acc[bone.name] = index
        return acc
      }, {} as Record<string, number>),
    }

    const rotations = this.runtimeSkeleton.localRotations
    for (let i = 0; i < this.skeleton.bones.length; i++) {
      const qi = i * 4
      if (rotations[qi + 3] === 0) {
        rotations[qi] = 0
        rotations[qi + 1] = 0
        rotations[qi + 2] = 0
        rotations[qi + 3] = 1
      }
    }

    // Initialize IK runtime state
    this.initializeIKRuntime()
  }

  private initializeIKRuntime(): void {
    const boneCount = this.skeleton.bones.length
    const bones = this.skeleton.bones

    // Initialize IK chain info for all bones (will be populated for IK chain bones)
    const ikChainInfo: IKChainInfo[] = new Array(boneCount)
    for (let i = 0; i < boneCount; i++) {
      ikChainInfo[i] = {
        ikRotation: new Quat(0, 0, 0, 1),
        localRotation: new Quat(0, 0, 0, 1),
      }
    }

    // Build IK solvers from bone data
    const ikSolvers: IKSolver[] = []
    let solverIndex = 0

    for (let i = 0; i < boneCount; i++) {
      const bone = bones[i]
      if (bone.ikTargetIndex !== undefined && bone.ikLinks && bone.ikLinks.length > 0) {
        const solver: IKSolver = {
          index: solverIndex++,
          ikBoneIndex: i,
          targetBoneIndex: bone.ikTargetIndex,
          iterationCount: bone.ikIteration ?? 1,
          limitAngle: bone.ikLimitAngle ?? Math.PI,
          links: bone.ikLinks,
        }
        ikSolvers.push(solver)
      }
    }

    this.runtimeSkeleton.ikChainInfo = ikChainInfo
    this.runtimeSkeleton.ikSolvers = ikSolvers
  }

  private initializeTweenBuffers(): void {
    const boneCount = this.skeleton.bones.length
    const morphCount = this.morphing.morphs.length

    this.tweenState = {
      // Bone rotation tweens
      rotActive: new Uint8Array(boneCount),
      rotStartQuat: new Float32Array(boneCount * 4),
      rotTargetQuat: new Float32Array(boneCount * 4),
      rotStartTimeMs: new Float32Array(boneCount),
      rotDurationMs: new Float32Array(boneCount),

      // Bone translation tweens
      transActive: new Uint8Array(boneCount),
      transStartVec: new Float32Array(boneCount * 3),
      transTargetVec: new Float32Array(boneCount * 3),
      transStartTimeMs: new Float32Array(boneCount),
      transDurationMs: new Float32Array(boneCount),

      // Morph weight tweens
      morphActive: new Uint8Array(morphCount),
      morphStartWeight: new Float32Array(morphCount),
      morphTargetWeight: new Float32Array(morphCount),
      morphStartTimeMs: new Float32Array(morphCount),
      morphDurationMs: new Float32Array(morphCount),
    }
  }

  private initializeRuntimeMorph(): void {
    const morphCount = this.morphing.morphs.length
    this.runtimeMorph = {
      nameIndex: this.morphing.morphs.reduce((acc, morph, index) => {
        acc[morph.name] = index
        return acc
      }, {} as Record<string, number>),
      weights: new Float32Array(morphCount),
    }
  }

  // Tween update - processes all tweens together with a single time reference
  // This avoids conflicts and ensures consistent timing across all tween types
  // Returns true if morph weights changed (needed for vertex buffer updates)
  private updateTweens(): boolean {
    const state = this.tweenState
    const now = this.tweenTimeMs // Single time reference for all tweens
    let morphChanged = false

    // Update bone rotation tweens
    const rotations = this.runtimeSkeleton.localRotations
    const boneCount = this.skeleton.bones.length
    for (let i = 0; i < boneCount; i++) {
      if (state.rotActive[i] !== 1) continue

      const startMs = state.rotStartTimeMs[i]
      const durMs = Math.max(1, state.rotDurationMs[i])
      const t = Math.max(0, Math.min(1, (now - startMs) / durMs))
      const e = easeInOut(t)

      const qi = i * 4
      const startQuat = new Quat(
        state.rotStartQuat[qi],
        state.rotStartQuat[qi + 1],
        state.rotStartQuat[qi + 2],
        state.rotStartQuat[qi + 3]
      )
      const targetQuat = new Quat(
        state.rotTargetQuat[qi],
        state.rotTargetQuat[qi + 1],
        state.rotTargetQuat[qi + 2],
        state.rotTargetQuat[qi + 3]
      )
      const result = Quat.slerp(startQuat, targetQuat, e)

      rotations[qi] = result.x
      rotations[qi + 1] = result.y
      rotations[qi + 2] = result.z
      rotations[qi + 3] = result.w

      if (t >= 1) {
        state.rotActive[i] = 0
      }
    }

    // Update bone translation tweens
    const translations = this.runtimeSkeleton.localTranslations
    for (let i = 0; i < boneCount; i++) {
      if (state.transActive[i] !== 1) continue

      const startMs = state.transStartTimeMs[i]
      const durMs = Math.max(1, state.transDurationMs[i])
      const t = Math.max(0, Math.min(1, (now - startMs) / durMs))
      const e = easeInOut(t)

      const ti = i * 3
      translations[ti] = state.transStartVec[ti] + (state.transTargetVec[ti] - state.transStartVec[ti]) * e
      translations[ti + 1] =
        state.transStartVec[ti + 1] + (state.transTargetVec[ti + 1] - state.transStartVec[ti + 1]) * e
      translations[ti + 2] =
        state.transStartVec[ti + 2] + (state.transTargetVec[ti + 2] - state.transStartVec[ti + 2]) * e

      if (t >= 1) {
        state.transActive[i] = 0
      }
    }

    // Update morph weight tweens
    const weights = this.runtimeMorph.weights
    const morphCount = this.morphing.morphs.length
    for (let i = 0; i < morphCount; i++) {
      if (state.morphActive[i] !== 1) continue

      const startMs = state.morphStartTimeMs[i]
      const durMs = Math.max(1, state.morphDurationMs[i])
      const t = Math.max(0, Math.min(1, (now - startMs) / durMs))
      const e = easeInOut(t)

      const oldWeight = weights[i]
      weights[i] = state.morphStartWeight[i] + (state.morphTargetWeight[i] - state.morphStartWeight[i]) * e

      // Check if weight actually changed (accounting for floating point precision)
      if (Math.abs(weights[i] - oldWeight) > 1e-6) {
        morphChanged = true
      }

      if (t >= 1) {
        weights[i] = state.morphTargetWeight[i]
        state.morphActive[i] = 0
        // Check if final weight is different from old weight
        if (Math.abs(weights[i] - oldWeight) > 1e-6) {
          morphChanged = true
        }
      }
    }

    return morphChanged
  }

  getVertices(): Float32Array<ArrayBuffer> {
    return this.vertexData
  }

  getTextures(): Texture[] {
    return this.textures
  }

  getMaterials(): Material[] {
    return this.materials
  }

  getIndices(): Uint32Array<ArrayBuffer> {
    return this.indexData
  }

  getSkeleton(): Skeleton {
    return this.skeleton
  }

  getSkinning(): Skinning {
    return this.skinning
  }

  getRigidbodies(): Rigidbody[] {
    return this.rigidbodies
  }

  getJoints(): Joint[] {
    return this.joints
  }

  getMorphing(): Morphing {
    return this.morphing
  }

  getMorphWeights(): Float32Array {
    return this.runtimeMorph.weights
  }

  // ------- Bone helpers (public API) -------

  rotateBones(names: string[], quats: Quat[], durationMs?: number): void {
    const state = this.tweenState
    const normalized = quats.map((q) => q.normalize())
    const now = this.tweenTimeMs
    const dur = durationMs && durationMs > 0 ? durationMs : 0

    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const idx = this.runtimeSkeleton.nameIndex[name] ?? -1
      if (idx < 0 || idx >= this.skeleton.bones.length) continue

      const qi = idx * 4
      const rotations = this.runtimeSkeleton.localRotations
      const [tx, ty, tz, tw] = normalized[i].toArray()

      if (dur === 0) {
        rotations[qi] = tx
        rotations[qi + 1] = ty
        rotations[qi + 2] = tz
        rotations[qi + 3] = tw
        state.rotActive[idx] = 0
        continue
      }

      let sx = rotations[qi]
      let sy = rotations[qi + 1]
      let sz = rotations[qi + 2]
      let sw = rotations[qi + 3]

      if (state.rotActive[idx] === 1) {
        const startMs = state.rotStartTimeMs[idx]
        const prevDur = Math.max(1, state.rotDurationMs[idx])
        const t = Math.max(0, Math.min(1, (now - startMs) / prevDur))
        const e = easeInOut(t)
        const startQuat = new Quat(
          state.rotStartQuat[qi],
          state.rotStartQuat[qi + 1],
          state.rotStartQuat[qi + 2],
          state.rotStartQuat[qi + 3]
        )
        const targetQuat = new Quat(
          state.rotTargetQuat[qi],
          state.rotTargetQuat[qi + 1],
          state.rotTargetQuat[qi + 2],
          state.rotTargetQuat[qi + 3]
        )
        const result = Quat.slerp(startQuat, targetQuat, e)
        sx = result.x
        sy = result.y
        sz = result.z
        sw = result.w
      }

      state.rotStartQuat[qi] = sx
      state.rotStartQuat[qi + 1] = sy
      state.rotStartQuat[qi + 2] = sz
      state.rotStartQuat[qi + 3] = sw
      state.rotTargetQuat[qi] = tx
      state.rotTargetQuat[qi + 1] = ty
      state.rotTargetQuat[qi + 2] = tz
      state.rotTargetQuat[qi + 3] = tw
      state.rotStartTimeMs[idx] = now
      state.rotDurationMs[idx] = dur
      state.rotActive[idx] = 1
    }
  }

  // Move bones using VMD-style relative translations (relative to bind pose world position)
  // This is the default behavior for VMD animations
  moveBones(names: string[], relativeTranslations: Vec3[], durationMs?: number): void {
    const state = this.tweenState
    const now = this.tweenTimeMs
    const dur = durationMs && durationMs > 0 ? durationMs : 0
    const localRot = this.runtimeSkeleton.localRotations

    // Compute bind pose world positions for all bones
    const skeleton = this.skeleton
    const computeBindPoseWorldPosition = (idx: number): Vec3 => {
      const bone = skeleton.bones[idx]
      const bindPos = new Vec3(bone.bindTranslation[0], bone.bindTranslation[1], bone.bindTranslation[2])
      if (bone.parentIndex >= 0 && bone.parentIndex < skeleton.bones.length) {
        const parentWorldPos = computeBindPoseWorldPosition(bone.parentIndex)
        return parentWorldPos.add(bindPos)
      } else {
        return bindPos
      }
    }

    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const idx = this.runtimeSkeleton.nameIndex[name] ?? -1
      if (idx < 0 || idx >= this.skeleton.bones.length) continue

      const bone = this.skeleton.bones[idx]
      const ti = idx * 3
      const qi = idx * 4
      const translations = this.runtimeSkeleton.localTranslations
      const vmdRelativeTranslation = relativeTranslations[i]

      // VMD translation is relative to bind pose world position
      // targetWorldPos = bindPoseWorldPos + vmdRelativeTranslation
      const bindPoseWorldPos = computeBindPoseWorldPosition(idx)
      const targetWorldPos = bindPoseWorldPos.add(vmdRelativeTranslation)

      // Convert target world position to local translation
      // We need parent's bind pose world position to transform to parent space
      let parentBindPoseWorldPos: Vec3
      if (bone.parentIndex >= 0) {
        parentBindPoseWorldPos = computeBindPoseWorldPosition(bone.parentIndex)
      } else {
        parentBindPoseWorldPos = new Vec3(0, 0, 0)
      }

      // Transform target world position to parent's local space
      // In bind pose, parent's world matrix is just a translation
      const parentSpacePos = targetWorldPos.subtract(parentBindPoseWorldPos)

      // Subtract bindTranslation to get position after bind translation
      const afterBindTranslation = parentSpacePos.subtract(
        new Vec3(bone.bindTranslation[0], bone.bindTranslation[1], bone.bindTranslation[2])
      )

      // Apply inverse rotation to get local translation
      const localRotation = new Quat(localRot[qi], localRot[qi + 1], localRot[qi + 2], localRot[qi + 3])
      const invRotation = localRotation.conjugate().normalize()
      const rotationMat = Mat4.fromQuat(invRotation.x, invRotation.y, invRotation.z, invRotation.w)
      const rm = rotationMat.values
      const localTranslation = new Vec3(
        rm[0] * afterBindTranslation.x + rm[4] * afterBindTranslation.y + rm[8] * afterBindTranslation.z,
        rm[1] * afterBindTranslation.x + rm[5] * afterBindTranslation.y + rm[9] * afterBindTranslation.z,
        rm[2] * afterBindTranslation.x + rm[6] * afterBindTranslation.y + rm[10] * afterBindTranslation.z
      )

      const [tx, ty, tz] = [localTranslation.x, localTranslation.y, localTranslation.z]

      if (dur === 0) {
        translations[ti] = tx
        translations[ti + 1] = ty
        translations[ti + 2] = tz
        state.transActive[idx] = 0
        continue
      }

      let sx = translations[ti]
      let sy = translations[ti + 1]
      let sz = translations[ti + 2]

      if (state.transActive[idx] === 1) {
        const startMs = state.transStartTimeMs[idx]
        const prevDur = Math.max(1, state.transDurationMs[idx])
        const t = Math.max(0, Math.min(1, (now - startMs) / prevDur))
        const e = easeInOut(t)
        sx = state.transStartVec[ti] + (state.transTargetVec[ti] - state.transStartVec[ti]) * e
        sy = state.transStartVec[ti + 1] + (state.transTargetVec[ti + 1] - state.transStartVec[ti + 1]) * e
        sz = state.transStartVec[ti + 2] + (state.transTargetVec[ti + 2] - state.transStartVec[ti + 2]) * e
      }

      state.transStartVec[ti] = sx
      state.transStartVec[ti + 1] = sy
      state.transStartVec[ti + 2] = sz
      state.transTargetVec[ti] = tx
      state.transTargetVec[ti + 1] = ty
      state.transTargetVec[ti + 2] = tz
      state.transStartTimeMs[idx] = now
      state.transDurationMs[idx] = dur
      state.transActive[idx] = 1
    }
  }

  getBoneWorldMatrices(): Float32Array {
    return this.runtimeSkeleton.worldMatrices
  }

  getBoneInverseBindMatrices(): Float32Array {
    return this.skeleton.inverseBindMatrices
  }

  getSkinMatrices(): Float32Array {
    const boneCount = this.skeleton.bones.length
    const worldMats = this.runtimeSkeleton.worldMatrices
    const invBindMats = this.skeleton.inverseBindMatrices

    // Initialize cached array if needed or if bone count changed
    if (!this.cachedSkinMatrices || this.cachedSkinMatrices.length !== boneCount * 16) {
      this.cachedSkinMatrices = new Float32Array(boneCount * 16)
    }

    const skinMatrices = this.cachedSkinMatrices

    // Compute skin matrices: skinMatrix = worldMatrix × inverseBindMatrix
    // Use Mat4.multiplyArrays to avoid creating Mat4 objects
    for (let i = 0; i < boneCount; i++) {
      const worldOffset = i * 16
      const invBindOffset = i * 16
      const skinOffset = i * 16
      Mat4.multiplyArrays(worldMats, worldOffset, invBindMats, invBindOffset, skinMatrices, skinOffset)
    }

    return skinMatrices
  }

  setMorphWeight(name: string, weight: number, durationMs?: number): void {
    const idx = this.runtimeMorph.nameIndex[name] ?? -1
    if (idx < 0 || idx >= this.runtimeMorph.weights.length) return

    const clampedWeight = Math.max(0, Math.min(1, weight))
    const dur = durationMs && durationMs > 0 ? durationMs : 0

    if (dur === 0) {
      // Instant change
      this.runtimeMorph.weights[idx] = clampedWeight
      this.tweenState.morphActive[idx] = 0
      this.applyMorphs()
      return
    }

    // Animated change
    const state = this.tweenState
    const now = this.tweenTimeMs

    // If already tweening, start from current interpolated value
    let startWeight = this.runtimeMorph.weights[idx]
    if (state.morphActive[idx] === 1) {
      const startMs = state.morphStartTimeMs[idx]
      const prevDur = Math.max(1, state.morphDurationMs[idx])
      const t = Math.max(0, Math.min(1, (now - startMs) / prevDur))
      const e = easeInOut(t)
      startWeight = state.morphStartWeight[idx] + (state.morphTargetWeight[idx] - state.morphStartWeight[idx]) * e
    }

    state.morphStartWeight[idx] = startWeight
    state.morphTargetWeight[idx] = clampedWeight
    state.morphStartTimeMs[idx] = now
    state.morphDurationMs[idx] = dur
    state.morphActive[idx] = 1

    // Immediately apply morphs with current weight
    this.runtimeMorph.weights[idx] = startWeight
    this.applyMorphs()
  }

  private applyMorphs(): void {
    // Reset vertex data to base positions
    this.vertexData.set(this.baseVertexData)

    const vertexCount = this.vertexCount
    const morphCount = this.morphing.morphs.length
    const weights = this.runtimeMorph.weights

    // First pass: Compute effective weights for all morphs (handling group morphs)
    const effectiveWeights = new Float32Array(morphCount)
    effectiveWeights.set(weights) // Start with direct weights

    // Apply group morphs: group morph weight * ratio affects referenced morphs
    for (let morphIdx = 0; morphIdx < morphCount; morphIdx++) {
      const morph = this.morphing.morphs[morphIdx]
      if (morph.type === 0 && morph.groupReferences) {
        const groupWeight = weights[morphIdx]
        if (groupWeight > 0.0001) {
          for (const ref of morph.groupReferences) {
            if (ref.morphIndex >= 0 && ref.morphIndex < morphCount) {
              // Add group morph's contribution to the referenced morph
              effectiveWeights[ref.morphIndex] += groupWeight * ref.ratio
            }
          }
        }
      }
    }

    // Clamp effective weights to [0, 1]
    for (let i = 0; i < morphCount; i++) {
      effectiveWeights[i] = Math.max(0, Math.min(1, effectiveWeights[i]))
    }

    // Second pass: Apply vertex morphs with their effective weights
    for (let morphIdx = 0; morphIdx < morphCount; morphIdx++) {
      const effectiveWeight = effectiveWeights[morphIdx]
      if (effectiveWeight === 0 || effectiveWeight < 0.0001) continue

      const morph = this.morphing.morphs[morphIdx]
      if (morph.type !== 1) continue // Only process vertex morphs

      // For vertex morphs, iterate through vertices that have offsets
      for (const vertexOffset of morph.vertexOffsets) {
        const vIdx = vertexOffset.vertexIndex
        if (vIdx < 0 || vIdx >= vertexCount) continue

        // Get morph offset for this vertex
        const offsetX = vertexOffset.positionOffset[0]
        const offsetY = vertexOffset.positionOffset[1]
        const offsetZ = vertexOffset.positionOffset[2]

        // Skip if offset is zero
        if (Math.abs(offsetX) < 0.0001 && Math.abs(offsetY) < 0.0001 && Math.abs(offsetZ) < 0.0001) {
          continue
        }

        // Apply weighted offset to vertex position (positions are at stride 0, 8, 16, ...)
        const vertexIdx = vIdx * VERTEX_STRIDE
        this.vertexData[vertexIdx] += offsetX * effectiveWeight
        this.vertexData[vertexIdx + 1] += offsetY * effectiveWeight
        this.vertexData[vertexIdx + 2] += offsetZ * effectiveWeight
      }
    }
  }

  /**
   * Load VMD animation file
   */
  async loadVmd(vmdUrl: string): Promise<void> {
    this.animationData = await VMDLoader.load(vmdUrl)
    this.processFrames()
    // Apply initial pose at time 0
    this.animationTime = 0
    this.getPoseAtTime(0)

    // Apply morphs if animation changed them
    if (this.morphsDirty) {
      this.applyMorphs()
      this.morphsDirty = false
    }

    // Compute world matrices after applying initial pose
    this.computeWorldMatrices()
  }

  /**
   * Process frames into tracks
   */
  private processFrames(): void {
    if (!this.animationData) return

    // Helper to group frames by name and sort by time
    const groupFrames = <T>(
      items: Array<{ item: T; name: string; time: number }>
    ): Map<string, Array<{ item: T; time: number }>> => {
      const tracks = new Map<string, Array<{ item: T; time: number }>>()
      for (const { item, name, time } of items) {
        if (!tracks.has(name)) tracks.set(name, [])
        tracks.get(name)!.push({ item, time })
      }
      for (const keyFrames of tracks.values()) {
        keyFrames.sort((a, b) => a.time - b.time)
      }
      return tracks
    }

    // Collect all bone and morph frames
    const boneItems: Array<{ item: BoneFrame; name: string; time: number }> = []
    const morphItems: Array<{ item: MorphFrame; name: string; time: number }> = []

    for (const keyFrame of this.animationData) {
      for (const boneFrame of keyFrame.boneFrames) {
        boneItems.push({ item: boneFrame, name: boneFrame.boneName, time: keyFrame.time })
      }
      for (const morphFrame of keyFrame.morphFrames) {
        morphItems.push({ item: morphFrame, name: morphFrame.morphName, time: keyFrame.time })
      }
    }

    // Transform to expected format
    this.boneTracks = new Map()
    for (const [name, frames] of groupFrames(boneItems).entries()) {
      this.boneTracks.set(
        name,
        frames.map((f) => ({ boneFrame: f.item, time: f.time }))
      )
    }

    this.morphTracks = new Map()
    for (const [name, frames] of groupFrames(morphItems).entries()) {
      this.morphTracks.set(
        name,
        frames.map((f) => ({ morphFrame: f.item, time: f.time }))
      )
    }

    // Calculate duration from all tracks
    const allTracks = [...this.boneTracks.values(), ...this.morphTracks.values()]
    this.animationDuration = allTracks.reduce((max, keyFrames) => {
      const lastTime = keyFrames[keyFrames.length - 1]?.time ?? 0
      return Math.max(max, lastTime)
    }, 0)
  }

  /**
   * Start or resume playback
   */
  playAnimation(): void {
    if (!this.animationData) {
      console.warn("[Model] Cannot play animation: no animation data loaded")
      return
    }

    this.isPaused = false
    this.isPlaying = true

    // Apply initial pose at current animation time
    this.getPoseAtTime(this.animationTime)

    // Apply morphs if animation changed them
    if (this.morphsDirty) {
      this.applyMorphs()
      this.morphsDirty = false
    }

    // Compute world matrices after applying pose
    this.computeWorldMatrices()

    // Reset physics when starting animation (prevents instability from sudden pose changes)
    if (this.physics) {
      this.physics.reset(this.runtimeSkeleton.worldMatrices, this.skeleton.inverseBindMatrices)
    }
  }

  /**
   * Pause playback
   */
  pauseAnimation(): void {
    if (!this.isPlaying || this.isPaused) return
    this.isPaused = true
  }

  /**
   * Stop playback and reset to beginning
   */
  stopAnimation(): void {
    this.isPlaying = false
    this.isPaused = false
    this.animationTime = 0

    // Reset physics state when stopping animation (prevents instability from sudden pose changes)
    if (this.physics) {
      this.computeWorldMatrices()
      this.physics.reset(this.runtimeSkeleton.worldMatrices, this.skeleton.inverseBindMatrices)
    }
  }

  /**
   * Seek to specific time
   * Immediately applies pose at the seeked time
   */
  seekAnimation(time: number): void {
    if (!this.animationData) return

    const clampedTime = Math.max(0, Math.min(time, this.animationDuration))
    this.animationTime = clampedTime
    // Immediately apply pose at seeked time
    this.getPoseAtTime(clampedTime)

    // Apply morphs if animation changed them
    if (this.morphsDirty) {
      this.applyMorphs()
      this.morphsDirty = false
    }

    // Compute world matrices after applying pose
    this.computeWorldMatrices()
  }

  /**
   * Get current animation progress
   */
  getAnimationProgress(): { current: number; duration: number; percentage: number } {
    const duration = this.animationDuration
    const percentage = duration > 0 ? (this.animationTime / duration) * 100 : 0
    return {
      current: this.animationTime,
      duration,
      percentage,
    }
  }

  /**
   * Get pose at specific time (internal helper)
   */
  private getPoseAtTime(time: number): void {
    if (!this.animationData) return

    // Helper for binary search upper bound
    const upperBound = <T extends { time: number }>(time: number, keyFrames: T[]): number => {
      let left = 0,
        right = keyFrames.length
      while (left < right) {
        const mid = Math.floor((left + right) / 2)
        if (keyFrames[mid].time <= time) left = mid + 1
        else right = mid
      }
      return left
    }

    // Process bone tracks
    for (const [boneName, keyFrames] of this.boneTracks.entries()) {
      if (keyFrames.length === 0) continue

      const clampedTime = Math.max(keyFrames[0].time, Math.min(keyFrames[keyFrames.length - 1].time, time))
      const idx = upperBound(clampedTime, keyFrames) - 1
      if (idx < 0) continue

      const frameA = keyFrames[idx].boneFrame
      const frameB = keyFrames[idx + 1]?.boneFrame

      const boneIdx = this.runtimeSkeleton.nameIndex[boneName]
      if (boneIdx === undefined) continue

      if (!frameB) {
        this.runtimeSkeleton.localRotations[boneIdx * 4] = frameA.rotation.x
        this.runtimeSkeleton.localRotations[boneIdx * 4 + 1] = frameA.rotation.y
        this.runtimeSkeleton.localRotations[boneIdx * 4 + 2] = frameA.rotation.z
        this.runtimeSkeleton.localRotations[boneIdx * 4 + 3] = frameA.rotation.w
        this.runtimeSkeleton.localTranslations[boneIdx * 3] = frameA.translation.x
        this.runtimeSkeleton.localTranslations[boneIdx * 3 + 1] = frameA.translation.y
        this.runtimeSkeleton.localTranslations[boneIdx * 3 + 2] = frameA.translation.z
      } else {
        const timeA = keyFrames[idx].time
        const timeB = keyFrames[idx + 1].time
        const gradient = (clampedTime - timeA) / (timeB - timeA)
        const interp = frameB.interpolation

        // Interpolate rotation using SLERP with bezier
        const rotT = bezierInterpolate(interp[0] / 127, interp[1] / 127, interp[2] / 127, interp[3] / 127, gradient)
        const rotation = Quat.slerp(frameA.rotation, frameB.rotation, rotT)

        // Interpolate translation using bezier for each component
        const getWeight = (offset: number) =>
          bezierInterpolate(
            interp[offset] / 127,
            interp[offset + 8] / 127,
            interp[offset + 4] / 127,
            interp[offset + 12] / 127,
            gradient
          )

        const lerp = (a: number, b: number, w: number) => a + (b - a) * w
        const translation = new Vec3(
          lerp(frameA.translation.x, frameB.translation.x, getWeight(0)),
          lerp(frameA.translation.y, frameB.translation.y, getWeight(16)),
          lerp(frameA.translation.z, frameB.translation.z, getWeight(32))
        )

        this.runtimeSkeleton.localRotations[boneIdx * 4] = rotation.x
        this.runtimeSkeleton.localRotations[boneIdx * 4 + 1] = rotation.y
        this.runtimeSkeleton.localRotations[boneIdx * 4 + 2] = rotation.z
        this.runtimeSkeleton.localRotations[boneIdx * 4 + 3] = rotation.w
        this.runtimeSkeleton.localTranslations[boneIdx * 3] = translation.x
        this.runtimeSkeleton.localTranslations[boneIdx * 3 + 1] = translation.y
        this.runtimeSkeleton.localTranslations[boneIdx * 3 + 2] = translation.z
      }
    }

    // Process morph tracks
    for (const [morphName, keyFrames] of this.morphTracks.entries()) {
      if (keyFrames.length === 0) continue

      const clampedTime = Math.max(keyFrames[0].time, Math.min(keyFrames[keyFrames.length - 1].time, time))
      const idx = upperBound(clampedTime, keyFrames) - 1
      if (idx < 0) continue

      const frameA = keyFrames[idx].morphFrame
      const frameB = keyFrames[idx + 1]?.morphFrame

      const morphIdx = this.runtimeMorph.nameIndex[morphName]
      if (morphIdx === undefined) continue

      const weight = frameB
        ? frameA.weight +
          (frameB.weight - frameA.weight) *
            ((clampedTime - keyFrames[idx].time) / (keyFrames[idx + 1].time - keyFrames[idx].time))
        : frameA.weight

      this.runtimeMorph.weights[morphIdx] = weight
      this.morphsDirty = true // Mark as dirty when animation sets morph weights
    }
  }

  /**
   * Updates the model pose by recomputing all matrices.
   * If animation is playing, applies animation pose first.
   * deltaTime: Time elapsed since last update in seconds
   * Returns true if vertices were modified (morphs changed)
   */
  update(deltaTime: number): boolean {
    // Update tween time (in milliseconds)
    this.tweenTimeMs += deltaTime * 1000

    // Update all active tweens (rotations, translations, morphs)
    const tweensChangedMorphs = this.updateTweens()

    // Apply animation if playing or paused (always apply pose if animation data exists and we have a time set)
    if (this.animationData) {
      if (this.isPlaying && !this.isPaused) {
        this.animationTime += deltaTime

        if (this.animationTime >= this.animationDuration) {
          this.animationTime = this.animationDuration
          this.pauseAnimation() // Auto-pause at end
        }

        this.getPoseAtTime(this.animationTime)
      } else if (this.isPaused || (!this.isPlaying && this.animationTime >= 0)) {
        // Apply pose at paused time or if we have a seeked time but not playing
        this.getPoseAtTime(this.animationTime)
      }
    }

    // Apply morphs if tweens changed morphs or animation changed morphs
    const verticesChanged = this.morphsDirty || tweensChangedMorphs
    if (this.morphsDirty || tweensChangedMorphs) {
      this.applyMorphs()
      this.morphsDirty = false
    }

    // Compute world matrices (needed for IK solving to read bone positions)
    this.computeWorldMatrices()

    // Solve IK chains (modifies localRotations with final IK rotations)
    this.solveIKChains()

    // Recompute world matrices with final IK rotations applied to localRotations
    this.computeWorldMatrices()

    if (this.physics) {
      this.physics.step(deltaTime, this.runtimeSkeleton.worldMatrices, this.skeleton.inverseBindMatrices)
    }

    return verticesChanged
  }

  private solveIKChains(): void {
    const ikSolvers = this.runtimeSkeleton.ikSolvers
    if (!ikSolvers || ikSolvers.length === 0) return

    const ikChainInfo = this.runtimeSkeleton.ikChainInfo
    if (!ikChainInfo) return

    IKSolverSystem.solve(
      ikSolvers,
      this.skeleton.bones,
      this.runtimeSkeleton.localRotations,
      this.runtimeSkeleton.localTranslations,
      this.runtimeSkeleton.worldMatrices,
      ikChainInfo
    )
  }

  private computeWorldMatrices(): void {
    const bones = this.skeleton.bones
    const localRot = this.runtimeSkeleton.localRotations
    const localTrans = this.runtimeSkeleton.localTranslations
    const worldBuf = this.runtimeSkeleton.worldMatrices
    const boneCount = bones.length

    if (boneCount === 0) return

    // Local computed array (avoids instance field overhead)
    const computed = new Array<boolean>(boneCount).fill(false)

    const computeWorld = (i: number): void => {
      if (computed[i]) return

      const b = bones[i]
      if (b.parentIndex >= boneCount) {
        console.warn(`[RZM] bone ${i} parent out of range: ${b.parentIndex}`)
      }

      const qi = i * 4
      let rotateM = Mat4.fromQuat(localRot[qi], localRot[qi + 1], localRot[qi + 2], localRot[qi + 3])
      let addLocalTx = 0,
        addLocalTy = 0,
        addLocalTz = 0

      // Optimized append rotation check - only check necessary conditions
      const appendParentIdx = b.appendParentIndex
      const hasAppend =
        b.appendRotate && appendParentIdx !== undefined && appendParentIdx >= 0 && appendParentIdx < boneCount

      if (hasAppend) {
        const ratio = b.appendRatio === undefined ? 1 : Math.max(-1, Math.min(1, b.appendRatio))
        const hasRatio = Math.abs(ratio) > 1e-6

        if (hasRatio) {
          const apQi = appendParentIdx * 4
          const apTi = appendParentIdx * 3

          if (b.appendRotate) {
            let ax = localRot[apQi]
            let ay = localRot[apQi + 1]
            let az = localRot[apQi + 2]
            const aw = localRot[apQi + 3]
            const absRatio = ratio < 0 ? -ratio : ratio
            if (ratio < 0) {
              ax = -ax
              ay = -ay
              az = -az
            }
            const appendQuat = new Quat(ax, ay, az, aw)
            const result = Quat.slerp(new Quat(0, 0, 0, 1), appendQuat, absRatio)
            rotateM = Mat4.fromQuat(result.x, result.y, result.z, result.w).multiply(rotateM)
          }

          if (b.appendMove) {
            const appendRatio = b.appendRatio ?? 1
            addLocalTx = localTrans[apTi] * appendRatio
            addLocalTy = localTrans[apTi + 1] * appendRatio
            addLocalTz = localTrans[apTi + 2] * appendRatio
          }
        }
      }

      // Build local matrix: identity + bind translation, then rotation, then local translation, then append translation
      const ti = i * 3
      const localTx = localTrans[ti] + addLocalTx
      const localTy = localTrans[ti + 1] + addLocalTy
      const localTz = localTrans[ti + 2] + addLocalTz
      this.cachedIdentityMat1
        .setIdentity()
        .translateInPlace(b.bindTranslation[0], b.bindTranslation[1], b.bindTranslation[2])
      this.cachedIdentityMat2.setIdentity().translateInPlace(localTx, localTy, localTz)
      const localM = this.cachedIdentityMat1.multiply(rotateM).multiply(this.cachedIdentityMat2)

      const worldOffset = i * 16
      if (b.parentIndex >= 0) {
        const p = b.parentIndex
        if (!computed[p]) computeWorld(p)
        const parentOffset = p * 16
        // Use cachedIdentityMat2 as temporary buffer for parent * local multiplication
        Mat4.multiplyArrays(worldBuf, parentOffset, localM.values, 0, this.cachedIdentityMat2.values, 0)
        worldBuf.subarray(worldOffset, worldOffset + 16).set(this.cachedIdentityMat2.values)
      } else {
        worldBuf.subarray(worldOffset, worldOffset + 16).set(localM.values)
      }
      computed[i] = true
    }

    // Process all bones (recursion handles dependencies automatically)
    for (let i = 0; i < boneCount; i++) computeWorld(i)
  }
}
