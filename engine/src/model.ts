import { Mat4, Quat, Vec3, bezierInterpolate } from "./math"
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
  localRotations: Quat[] // quat per bone
  localTranslations: Vec3[] // vec3 per bone
  worldMatrices: Mat4[] // mat4 per bone
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
  rotStartQuat: Quat[]
  rotTargetQuat: Quat[]
  rotStartTimeMs: Float32Array // one float per bone (ms)
  rotDurationMs: Float32Array // one float per bone (ms)

  // Bone translation tweens
  transActive: Uint8Array // 0/1 per bone
  transStartVec: Vec3[] // vec3 per bone (x,y,z)
  transTargetVec: Vec3[] // vec3 per bone (x,y,z)
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
  private skinMatricesArray?: Float32Array

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

  // Cached keyframe indices for faster lookup (per track)
  private boneTrackIndices: Map<string, number> = new Map()
  private morphTrackIndices: Map<string, number> = new Map()

  // Physics runtime
  private physics: Physics | null = null

  // IK and Physics enable flags
  private ikEnabled = true
  private physicsEnabled = true

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
    this.applyMorphs()

    // Initialize physics if rigidbodies exist
    if (rigidbodies.length > 0) {
      this.physics = new Physics(rigidbodies, joints)
    }
  }

  private initializeRuntimeSkeleton(): void {
    const boneCount = this.skeleton.bones.length

    // Pre-allocate object arrays for skeletal pose
    const localRotations: Quat[] = new Array(boneCount)
    const localTranslations: Vec3[] = new Array(boneCount)
    const worldMatrices: Mat4[] = new Array(boneCount)
    for (let i = 0; i < boneCount; i++) {
      localRotations[i] = Quat.identity()
      localTranslations[i] = Vec3.zeros()
      worldMatrices[i] = Mat4.identity()
    }

    this.runtimeSkeleton = {
      localRotations,
      localTranslations,
      worldMatrices,
      nameIndex: this.skeleton.bones.reduce((acc, bone, index) => {
        acc[bone.name] = index
        return acc
      }, {} as Record<string, number>),
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
        ikRotation: Quat.identity(),
        localRotation: Quat.identity(),
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

    // Pre-allocate Quat and Vec3 arrays to avoid reallocation during tweens
    const rotStartQuat: Quat[] = new Array(boneCount)
    const rotTargetQuat: Quat[] = new Array(boneCount)
    const transStartVec: Vec3[] = new Array(boneCount)
    const transTargetVec: Vec3[] = new Array(boneCount)
    for (let i = 0; i < boneCount; i++) {
      rotStartQuat[i] = Quat.identity()
      rotTargetQuat[i] = Quat.identity()
      transStartVec[i] = Vec3.zeros()
      transTargetVec[i] = Vec3.zeros()
    }

    this.tweenState = {
      // Bone rotation tweens
      rotActive: new Uint8Array(boneCount),
      rotStartQuat,
      rotTargetQuat,
      rotStartTimeMs: new Float32Array(boneCount),
      rotDurationMs: new Float32Array(boneCount),

      // Bone translation tweens
      transActive: new Uint8Array(boneCount),
      transStartVec,
      transTargetVec,
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
      const e = t // Linear interpolation

      const result = Quat.slerp(state.rotStartQuat[i], state.rotTargetQuat[i], e)
      rotations[i].set(result)

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
      const e = t // Linear interpolation

      const startVec = state.transStartVec[i]
      const targetVec = state.transTargetVec[i]
      translations[i].x = startVec.x + (targetVec.x - startVec.x) * e
      translations[i].y = startVec.y + (targetVec.y - startVec.y) * e
      translations[i].z = startVec.z + (targetVec.z - startVec.z) * e

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
      const e = t // Linear interpolation

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

  rotateBones(boneRotations: Record<string, Quat>, durationMs?: number): void {
    const state = this.tweenState
    // Clone and normalize to avoid mutating input
    Object.values(boneRotations).forEach((q) => q.normalize())
    const now = this.tweenTimeMs
    const dur = durationMs && durationMs > 0 ? durationMs : 0

    for (const [name, targetQuat] of Object.entries(boneRotations)) {
      const idx = this.runtimeSkeleton.nameIndex[name] ?? -1
      if (idx < 0 || idx >= this.skeleton.bones.length) continue

      const rotations = this.runtimeSkeleton.localRotations
      const targetNorm = targetQuat

      if (dur === 0) {
        rotations[idx].set(targetNorm)
        state.rotActive[idx] = 0
        continue
      }

      const currentRot = rotations[idx]
      let sx = currentRot.x
      let sy = currentRot.y
      let sz = currentRot.z
      let sw = currentRot.w

      if (state.rotActive[idx] === 1) {
        const startMs = state.rotStartTimeMs[idx]
        const prevDur = Math.max(1, state.rotDurationMs[idx])
        const t = Math.max(0, Math.min(1, (now - startMs) / prevDur))
        const e = t // Linear interpolation
        const result = Quat.slerp(state.rotStartQuat[idx], state.rotTargetQuat[idx], e)
        sx = result.x
        sy = result.y
        sz = result.z
        sw = result.w
      }

      state.rotStartQuat[idx].x = sx
      state.rotStartQuat[idx].y = sy
      state.rotStartQuat[idx].z = sz
      state.rotStartQuat[idx].w = sw
      state.rotTargetQuat[idx].set(targetNorm)
      state.rotStartTimeMs[idx] = now
      state.rotDurationMs[idx] = dur
      state.rotActive[idx] = 1
    }
  }

  // Move bones using VMD-style relative translations (relative to bind pose world position)
  // This is the default behavior for VMD animations
  moveBones(boneTranslations: Record<string, Vec3>, durationMs?: number): void {
    const state = this.tweenState
    const now = this.tweenTimeMs
    const dur = durationMs && durationMs > 0 ? durationMs : 0

    for (const [name, vmdRelativeTranslation] of Object.entries(boneTranslations)) {
      const idx = this.runtimeSkeleton.nameIndex[name] ?? -1
      if (idx < 0 || idx >= this.skeleton.bones.length) continue

      const translations = this.runtimeSkeleton.localTranslations

      // Convert VMD relative translation to local translation
      const localTranslation = this.convertVMDTranslationToLocal(idx, vmdRelativeTranslation)
      const [tx, ty, tz] = [localTranslation.x, localTranslation.y, localTranslation.z]

      if (dur === 0) {
        translations[idx].x = tx
        translations[idx].y = ty
        translations[idx].z = tz
        state.transActive[idx] = 0
        continue
      }

      const currentTrans = translations[idx]
      let sx = currentTrans.x
      let sy = currentTrans.y
      let sz = currentTrans.z

      if (state.transActive[idx] === 1) {
        const startMs = state.transStartTimeMs[idx]
        const prevDur = Math.max(1, state.transDurationMs[idx])
        const t = Math.max(0, Math.min(1, (now - startMs) / prevDur))
        const e = t // Linear interpolation
        const startVec = state.transStartVec[idx]
        const targetVec = state.transTargetVec[idx]
        sx = startVec.x + (targetVec.x - startVec.x) * e
        sy = startVec.y + (targetVec.y - startVec.y) * e
        sz = startVec.z + (targetVec.z - startVec.z) * e
      }

      state.transStartVec[idx].x = sx
      state.transStartVec[idx].y = sy
      state.transStartVec[idx].z = sz
      state.transTargetVec[idx].x = tx
      state.transTargetVec[idx].y = ty
      state.transTargetVec[idx].z = tz
      state.transStartTimeMs[idx] = now
      state.transDurationMs[idx] = dur
      state.transActive[idx] = 1
    }
  }

  /**
   * Convert VMD-style relative translation (relative to bind pose world position) to local translation
   * This helper is used by both moveBones and getPoseAtTime to ensure consistent translation handling
   */
  private convertVMDTranslationToLocal(boneIdx: number, vmdRelativeTranslation: Vec3): Vec3 {
    const skeleton = this.skeleton
    const bones = skeleton.bones
    const localRot = this.runtimeSkeleton.localRotations

    // Compute bind pose world positions for all bones
    const computeBindPoseWorldPosition = (idx: number): Vec3 => {
      const bone = bones[idx]
      const bindPos = new Vec3(bone.bindTranslation[0], bone.bindTranslation[1], bone.bindTranslation[2])
      if (bone.parentIndex >= 0 && bone.parentIndex < bones.length) {
        const parentWorldPos = computeBindPoseWorldPosition(bone.parentIndex)
        return parentWorldPos.add(bindPos)
      } else {
        return bindPos
      }
    }

    const bone = bones[boneIdx]

    // VMD translation is relative to bind pose world position
    // targetWorldPos = bindPoseWorldPos + vmdRelativeTranslation
    const bindPoseWorldPos = computeBindPoseWorldPosition(boneIdx)
    const targetWorldPos = bindPoseWorldPos.add(vmdRelativeTranslation)

    // Convert target world position to local translation
    // We need parent's bind pose world position to transform to parent space
    let parentBindPoseWorldPos: Vec3
    if (bone.parentIndex >= 0) {
      parentBindPoseWorldPos = computeBindPoseWorldPosition(bone.parentIndex)
    } else {
      parentBindPoseWorldPos = Vec3.zeros()
    }

    // Transform target world position to parent's local space
    // In bind pose, parent's world matrix is just a translation
    const parentSpacePos = targetWorldPos.subtract(parentBindPoseWorldPos)

    // Subtract bindTranslation to get position after bind translation
    const afterBindTranslation = parentSpacePos.subtract(
      new Vec3(bone.bindTranslation[0], bone.bindTranslation[1], bone.bindTranslation[2])
    )

    // Apply inverse rotation to get local translation
    const localRotation = localRot[boneIdx]
    // Clone to avoid mutating, then conjugate and normalize
    const invRotation = localRotation.clone().conjugate().normalize()
    const rotationMat = Mat4.fromQuat(invRotation.x, invRotation.y, invRotation.z, invRotation.w)
    const rm = rotationMat.values
    const localTranslation = new Vec3(
      rm[0] * afterBindTranslation.x + rm[4] * afterBindTranslation.y + rm[8] * afterBindTranslation.z,
      rm[1] * afterBindTranslation.x + rm[5] * afterBindTranslation.y + rm[9] * afterBindTranslation.z,
      rm[2] * afterBindTranslation.x + rm[6] * afterBindTranslation.y + rm[10] * afterBindTranslation.z
    )

    return localTranslation
  }

  getBoneWorldMatrices(): Float32Array {
    // Convert Mat4[] to Float32Array for WebGPU compatibility
    const boneCount = this.skeleton.bones.length
    const worldMats = this.runtimeSkeleton.worldMatrices
    const result = new Float32Array(boneCount * 16)
    for (let i = 0; i < boneCount; i++) {
      result.set(worldMats[i].values, i * 16)
    }
    return result
  }

  getBoneInverseBindMatrices(): Float32Array {
    return this.skeleton.inverseBindMatrices
  }

  getSkinMatrices(): Float32Array {
    const boneCount = this.skeleton.bones.length
    const worldMats = this.runtimeSkeleton.worldMatrices
    const invBindMats = this.skeleton.inverseBindMatrices

    // Initialize cached array if needed or if bone count changed
    if (!this.skinMatricesArray || this.skinMatricesArray.length !== boneCount * 16) {
      this.skinMatricesArray = new Float32Array(boneCount * 16)
    }

    const skinMatrices = this.skinMatricesArray

    // Compute skin matrices: skinMatrix = worldMatrix × inverseBindMatrix
    for (let i = 0; i < boneCount; i++) {
      const worldMat = worldMats[i]
      const invBindOffset = i * 16
      const skinOffset = i * 16
      Mat4.multiplyArrays(worldMat.values, 0, invBindMats, invBindOffset, skinMatrices, skinOffset)
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
      const e = t // Linear interpolation
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
    this.resetAllBones()
    this.resetAllMorphs()
    this.processFrames()
    // Apply initial pose at time 0
    this.animationTime = 0
    this.getPoseAtTime(0)

    if (this.physics) {
      this.computeWorldMatrices()
      this.physics.reset(this.runtimeSkeleton.worldMatrices, this.skeleton.inverseBindMatrices)
    }
  }

  /**
   * Reset all bones to their default pose
   */
  public resetAllBones(): void {
    for (let boneIdx = 0; boneIdx < this.skeleton.bones.length; boneIdx++) {
      const localRot = this.runtimeSkeleton.localRotations[boneIdx]
      const localTrans = this.runtimeSkeleton.localTranslations[boneIdx]

      // Reset to default pose: identity rotation and zero translation (like initial PMX state)
      localRot.set(Quat.identity())
      localTrans.set(Vec3.zeros())
    }
    this.computeWorldMatrices()
    if (this.physics) {
      this.physics.reset(this.runtimeSkeleton.worldMatrices, this.skeleton.inverseBindMatrices)
    }
  }

  public resetAllMorphs(): void {
    for (let morphIdx = 0; morphIdx < this.morphing.morphs.length; morphIdx++) {
      const morphName = this.morphing.morphs[morphIdx].name
      this.setMorphWeight(morphName, 0)
    }
    this.morphsDirty = true
    this.applyMorphs()
  }

  /**
   * Enable or disable IK solving
   */
  public setIKEnabled(enabled: boolean): void {
    this.ikEnabled = enabled
  }

  /**
   * Enable or disable physics simulation
   */
  public setPhysicsEnabled(enabled: boolean): void {
    this.physicsEnabled = enabled
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

    // Reset cached indices when tracks change
    this.boneTrackIndices.clear()
    this.morphTrackIndices.clear()

    // Calculate duration from all tracks
    const allTracks = [...this.boneTracks.values(), ...this.morphTracks.values()]
    this.animationDuration = allTracks.reduce((max, keyFrames) => {
      const lastTime = keyFrames[keyFrames.length - 1]?.time ?? 0
      return Math.max(max, lastTime)
    }, 0)
  }

  playAnimation(): void {
    if (!this.animationData) return

    this.isPaused = false
    this.isPlaying = true

    if (this.physics && this.animationTime === 0) {
      this.computeWorldMatrices()
      this.physics.reset(this.runtimeSkeleton.worldMatrices, this.skeleton.inverseBindMatrices)
    }
  }

  pauseAnimation(): void {
    if (!this.isPlaying || this.isPaused) return
    this.isPaused = true
  }

  stopAnimation(): void {
    this.isPlaying = false
    this.isPaused = false
    this.animationTime = 0
  }

  seekAnimation(time: number): void {
    if (!this.animationData) return
    const clampedTime = Math.max(0, Math.min(time, this.animationDuration))
    this.animationTime = clampedTime
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
   * Binary search upper bound helper (static to avoid recreation)
   */
  private static upperBound<T extends { time: number }>(time: number, keyFrames: T[], startIdx: number = 0): number {
    let left = startIdx,
      right = keyFrames.length
    while (left < right) {
      const mid = Math.floor((left + right) / 2)
      if (keyFrames[mid].time <= time) left = mid + 1
      else right = mid
    }
    return left
  }

  /**
   * Find keyframe index with caching optimization
   * Uses cached index as starting point for faster lookup when time is close
   */
  private findKeyframeIndex<T extends { time: number }>(time: number, keyFrames: T[], cachedIdx: number): number {
    if (keyFrames.length === 0) return -1

    // Check if cached index is still valid (time is within the cached frame range)
    if (cachedIdx >= 0 && cachedIdx < keyFrames.length) {
      const frameTime = keyFrames[cachedIdx].time
      const nextFrameTime = cachedIdx + 1 < keyFrames.length ? keyFrames[cachedIdx + 1].time : Infinity

      // If time is within [frameTime, nextFrameTime), use cached index
      if (time >= frameTime && time < nextFrameTime) {
        return cachedIdx
      }
    }

    // Fall back to binary search
    const idx = Model.upperBound(time, keyFrames, 0) - 1
    return idx
  }

  /**
   * Get pose at specific time (internal helper)
   * Optimized for per-frame performance
   */
  private getPoseAtTime(time: number): void {
    if (!this.animationData) return

    const INV_127 = 1 / 127 // Pre-compute division constant

    // Process bone tracks
    for (const [boneName, keyFrames] of this.boneTracks.entries()) {
      if (keyFrames.length === 0) continue

      const cachedIdx = this.boneTrackIndices.get(boneName) ?? -1
      const clampedTime = Math.max(keyFrames[0].time, Math.min(keyFrames[keyFrames.length - 1].time, time))
      const idx = this.findKeyframeIndex(clampedTime, keyFrames, cachedIdx)

      if (idx < 0) continue

      // Update cache
      this.boneTrackIndices.set(boneName, idx)

      const frameA = keyFrames[idx].boneFrame
      const frameB = keyFrames[idx + 1]?.boneFrame

      const boneIdx = this.runtimeSkeleton.nameIndex[boneName]
      if (boneIdx === undefined) continue

      const localRot = this.runtimeSkeleton.localRotations[boneIdx]
      const localTrans = this.runtimeSkeleton.localTranslations[boneIdx]

      if (!frameB) {
        // No interpolation needed - direct assignment
        localRot.set(frameA.rotation)
        // Convert VMD relative translation to local translation
        const localTranslation = this.convertVMDTranslationToLocal(boneIdx, frameA.translation)
        localTrans.set(localTranslation)
      } else {
        const timeA = keyFrames[idx].time
        const timeB = keyFrames[idx + 1].time
        const timeDelta = timeB - timeA
        const gradient = (clampedTime - timeA) / timeDelta
        const interp = frameB.interpolation

        // Pre-normalize interpolation values (avoid division in bezierInterpolate)
        const rotT = bezierInterpolate(
          interp[0] * INV_127,
          interp[1] * INV_127,
          interp[2] * INV_127,
          interp[3] * INV_127,
          gradient
        )

        // Use Quat.slerp to interpolate rotation
        const rotation = Quat.slerp(frameA.rotation, frameB.rotation, rotT)

        // Interpolate VMD translation using bezier for each component
        // Inline getWeight to avoid function call overhead
        const getWeight = (offset: number) =>
          bezierInterpolate(
            interp[offset] * INV_127,
            interp[offset + 8] * INV_127,
            interp[offset + 4] * INV_127,
            interp[offset + 12] * INV_127,
            gradient
          )

        const txWeight = getWeight(0)
        const tyWeight = getWeight(16)
        const tzWeight = getWeight(32)

        // Interpolate VMD relative translations (relative to bind pose world position)
        const interpolatedVMDTranslation = new Vec3(
          frameA.translation.x + (frameB.translation.x - frameA.translation.x) * txWeight,
          frameA.translation.y + (frameB.translation.y - frameA.translation.y) * tyWeight,
          frameA.translation.z + (frameB.translation.z - frameA.translation.z) * tzWeight
        )

        // Convert interpolated VMD translation to local translation
        const localTranslation = this.convertVMDTranslationToLocal(boneIdx, interpolatedVMDTranslation)

        // Direct property writes to avoid object allocation
        localRot.set(rotation)
        localTrans.set(localTranslation)
      }
    }

    // Process morph tracks
    for (const [morphName, keyFrames] of this.morphTracks.entries()) {
      if (keyFrames.length === 0) continue

      const cachedIdx = this.morphTrackIndices.get(morphName) ?? -1
      const clampedTime = Math.max(keyFrames[0].time, Math.min(keyFrames[keyFrames.length - 1].time, time))
      const idx = this.findKeyframeIndex(clampedTime, keyFrames, cachedIdx)

      if (idx < 0) continue

      // Update cache
      this.morphTrackIndices.set(morphName, idx)

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
    if (this.ikEnabled) {
      this.solveIKChains()
      // Recompute world matrices with final IK rotations applied to localRotations
      this.computeWorldMatrices()
    }

    if (this.physicsEnabled && this.physics) {
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
    const worldMats = this.runtimeSkeleton.worldMatrices
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

      const boneRot = localRot[i]
      let rotateM = Mat4.fromQuat(boneRot.x, boneRot.y, boneRot.z, boneRot.w)
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
          if (b.appendRotate) {
            const appendRot = localRot[appendParentIdx]
            let ax = appendRot.x
            let ay = appendRot.y
            let az = appendRot.z
            const aw = appendRot.w
            const absRatio = ratio < 0 ? -ratio : ratio
            if (ratio < 0) {
              ax = -ax
              ay = -ay
              az = -az
            }
            const appendQuat = new Quat(ax, ay, az, aw)
            const result = Quat.slerp(Quat.identity(), appendQuat, absRatio)
            rotateM = Mat4.fromQuat(result.x, result.y, result.z, result.w).multiply(rotateM)
          }

          if (b.appendMove) {
            const appendTrans = localTrans[appendParentIdx]
            const appendRatio = b.appendRatio ?? 1
            addLocalTx = appendTrans.x * appendRatio
            addLocalTy = appendTrans.y * appendRatio
            addLocalTz = appendTrans.z * appendRatio
          }
        }
      }

      // Build local matrix: identity + bind translation, then rotation, then local translation, then append translation
      const boneTrans = localTrans[i]
      const localTx = boneTrans.x + addLocalTx
      const localTy = boneTrans.y + addLocalTy
      const localTz = boneTrans.z + addLocalTz
      this.cachedIdentityMat1
        .setIdentity()
        .translateInPlace(b.bindTranslation[0], b.bindTranslation[1], b.bindTranslation[2])
      this.cachedIdentityMat2.setIdentity().translateInPlace(localTx, localTy, localTz)
      const localM = this.cachedIdentityMat1.multiply(rotateM).multiply(this.cachedIdentityMat2)

      const worldMat = worldMats[i]
      if (b.parentIndex >= 0) {
        const p = b.parentIndex
        if (!computed[p]) computeWorld(p)
        const parentMat = worldMats[p]
        // Multiply parent world matrix by local matrix
        Mat4.multiplyArrays(parentMat.values, 0, localM.values, 0, worldMat.values, 0)
      } else {
        worldMat.values.set(localM.values)
      }
      computed[i] = true
    }

    // Process all bones (recursion handles dependencies automatically)
    for (let i = 0; i < boneCount; i++) computeWorld(i)
  }
}
