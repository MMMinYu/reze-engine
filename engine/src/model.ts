import { Mat4, Quat, Vec3, easeInOut } from "./math"
import { Rigidbody, Joint } from "./physics"
import { IKSolverSystem } from "./ik-solver"

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

// Rotation tween state per bone
interface RotationTweenState {
  active: Uint8Array // 0/1 per bone
  startQuat: Float32Array // quat per bone (x,y,z,w)
  targetQuat: Float32Array // quat per bone (x,y,z,w)
  startTimeMs: Float32Array // one float per bone (ms)
  durationMs: Float32Array // one float per bone (ms)
}

// Morph weight tween state per morph
interface MorphWeightTweenState {
  active: Uint8Array // 0/1 per morph
  startWeight: Float32Array // one float per morph
  targetWeight: Float32Array // one float per morph
  startTimeMs: Float32Array // one float per morph (ms)
  durationMs: Float32Array // one float per morph (ms)
}

// Translation tween state per bone
interface TranslationTweenState {
  active: Uint8Array // 0/1 per bone
  startVec: Float32Array // vec3 per bone (x,y,z)
  targetVec: Float32Array // vec3 per bone (x,y,z)
  startTimeMs: Float32Array // one float per bone (ms)
  durationMs: Float32Array // one float per bone (ms)
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

  // Cached identity matrices to avoid allocations in computeWorldMatrices
  private cachedIdentityMat1 = Mat4.identity()
  private cachedIdentityMat2 = Mat4.identity()

  private rotTweenState!: RotationTweenState
  private transTweenState!: TranslationTweenState
  private morphTweenState!: MorphWeightTweenState

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
    this.initializeRotTweenBuffers()
    this.initializeTransTweenBuffers()
    this.initializeRuntimeMorph()
    this.initializeMorphTweenBuffers()
    this.applyMorphs() // Apply initial morphs (all weights are 0, so no change)
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

  private initializeRotTweenBuffers(): void {
    this.rotTweenState = this.createTweenState(this.skeleton.bones.length, 4, 4)
  }

  private initializeTransTweenBuffers(): void {
    this.transTweenState = this.createTweenState(this.skeleton.bones.length, 3, 3)
  }

  private initializeMorphTweenBuffers(): void {
    this.morphTweenState = this.createTweenState(this.morphing.morphs.length, 1, 1)
  }

  private createTweenState(count: number, startSize: number, targetSize: number): any {
    return {
      active: new Uint8Array(count),
      startQuat: new Float32Array(count * startSize),
      targetQuat: new Float32Array(count * targetSize),
      startTimeMs: new Float32Array(count),
      durationMs: new Float32Array(count),
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

  private updateRotationTweens(): void {
    const state = this.rotTweenState
    const now = performance.now()
    const rotations = this.runtimeSkeleton.localRotations
    const boneCount = this.skeleton.bones.length

    for (let i = 0; i < boneCount; i++) {
      if (state.active[i] !== 1) continue

      const startMs = state.startTimeMs[i]
      const durMs = Math.max(1, state.durationMs[i])
      const t = Math.max(0, Math.min(1, (now - startMs) / durMs))
      const e = easeInOut(t)

      const qi = i * 4
      const startQuat = new Quat(
        state.startQuat[qi],
        state.startQuat[qi + 1],
        state.startQuat[qi + 2],
        state.startQuat[qi + 3]
      )
      const targetQuat = new Quat(
        state.targetQuat[qi],
        state.targetQuat[qi + 1],
        state.targetQuat[qi + 2],
        state.targetQuat[qi + 3]
      )
      const result = Quat.slerp(startQuat, targetQuat, e)

      rotations[qi] = result.x
      rotations[qi + 1] = result.y
      rotations[qi + 2] = result.z
      rotations[qi + 3] = result.w

      if (t >= 1) state.active[i] = 0
    }
  }

  private updateTranslationTweens(): void {
    const state = this.transTweenState
    const now = performance.now()
    const translations = this.runtimeSkeleton.localTranslations
    const boneCount = this.skeleton.bones.length

    for (let i = 0; i < boneCount; i++) {
      if (state.active[i] !== 1) continue

      const startMs = state.startTimeMs[i]
      const durMs = Math.max(1, state.durationMs[i])
      const t = Math.max(0, Math.min(1, (now - startMs) / durMs))
      const e = easeInOut(t)

      const ti = i * 3
      translations[ti] = state.startVec[ti] + (state.targetVec[ti] - state.startVec[ti]) * e
      translations[ti + 1] = state.startVec[ti + 1] + (state.targetVec[ti + 1] - state.startVec[ti + 1]) * e
      translations[ti + 2] = state.startVec[ti + 2] + (state.targetVec[ti + 2] - state.startVec[ti + 2]) * e

      if (t >= 1) state.active[i] = 0
    }
  }

  private updateMorphWeightTweens(): boolean {
    const state = this.morphTweenState
    const now = performance.now()
    const weights = this.runtimeMorph.weights
    const morphCount = this.morphing.morphs.length
    let hasActiveTweens = false

    for (let i = 0; i < morphCount; i++) {
      if (state.active[i] !== 1) continue

      hasActiveTweens = true
      const startMs = state.startTimeMs[i]
      const durMs = Math.max(1, state.durationMs[i])
      const t = Math.max(0, Math.min(1, (now - startMs) / durMs))
      const e = easeInOut(t)

      weights[i] = state.startWeight[i] + (state.targetWeight[i] - state.startWeight[i]) * e

      if (t >= 1) {
        weights[i] = state.targetWeight[i]
        state.active[i] = 0
      }
    }

    return hasActiveTweens
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
    const state = this.rotTweenState
    const normalized = quats.map((q) => q.normalize())
    const now = performance.now()
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
        state.active[idx] = 0
        continue
      }

      let sx = rotations[qi]
      let sy = rotations[qi + 1]
      let sz = rotations[qi + 2]
      let sw = rotations[qi + 3]

      if (state.active[idx] === 1) {
        const startMs = state.startTimeMs[idx]
        const prevDur = Math.max(1, state.durationMs[idx])
        const t = Math.max(0, Math.min(1, (now - startMs) / prevDur))
        const e = easeInOut(t)
        const startQuat = new Quat(
          state.startQuat[qi],
          state.startQuat[qi + 1],
          state.startQuat[qi + 2],
          state.startQuat[qi + 3]
        )
        const targetQuat = new Quat(
          state.targetQuat[qi],
          state.targetQuat[qi + 1],
          state.targetQuat[qi + 2],
          state.targetQuat[qi + 3]
        )
        const result = Quat.slerp(startQuat, targetQuat, e)
        sx = result.x
        sy = result.y
        sz = result.z
        sw = result.w
      }

      state.startQuat[qi] = sx
      state.startQuat[qi + 1] = sy
      state.startQuat[qi + 2] = sz
      state.startQuat[qi + 3] = sw
      state.targetQuat[qi] = tx
      state.targetQuat[qi + 1] = ty
      state.targetQuat[qi + 2] = tz
      state.targetQuat[qi + 3] = tw
      state.startTimeMs[idx] = now
      state.durationMs[idx] = dur
      state.active[idx] = 1
    }
  }

  // Move bones using VMD-style relative translations (relative to bind pose world position)
  // This is the default behavior for VMD animations
  moveBones(names: string[], relativeTranslations: Vec3[], durationMs?: number): void {
    const state = this.transTweenState
    const now = performance.now()
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
        state.active[idx] = 0
        continue
      }

      let sx = translations[ti]
      let sy = translations[ti + 1]
      let sz = translations[ti + 2]

      if (state.active[idx] === 1) {
        const startMs = state.startTimeMs[idx]
        const prevDur = Math.max(1, state.durationMs[idx])
        const t = Math.max(0, Math.min(1, (now - startMs) / prevDur))
        const e = easeInOut(t)
        sx = state.startVec[ti] + (state.targetVec[ti] - state.startVec[ti]) * e
        sy = state.startVec[ti + 1] + (state.targetVec[ti + 1] - state.startVec[ti + 1]) * e
        sz = state.startVec[ti + 2] + (state.targetVec[ti + 2] - state.startVec[ti + 2]) * e
      }

      state.startVec[ti] = sx
      state.startVec[ti + 1] = sy
      state.startVec[ti + 2] = sz
      state.targetVec[ti] = tx
      state.targetVec[ti + 1] = ty
      state.targetVec[ti + 2] = tz
      state.startTimeMs[idx] = now
      state.durationMs[idx] = dur
      state.active[idx] = 1
    }
  }

  getBoneWorldMatrices(): Float32Array {
    return this.runtimeSkeleton.worldMatrices
  }

  getBoneInverseBindMatrices(): Float32Array {
    return this.skeleton.inverseBindMatrices
  }

  setMorphWeight(name: string, weight: number, durationMs?: number): void {
    const idx = this.runtimeMorph.nameIndex[name] ?? -1
    if (idx < 0 || idx >= this.runtimeMorph.weights.length) return

    const clampedWeight = Math.max(0, Math.min(1, weight))
    const dur = durationMs && durationMs > 0 ? durationMs : 0

    if (dur === 0) {
      // Instant change
      this.runtimeMorph.weights[idx] = clampedWeight
      this.morphTweenState.active[idx] = 0
      this.applyMorphs()
      return
    }

    // Animated change
    const state = this.morphTweenState
    const now = performance.now()

    // If already tweening, start from current interpolated value
    let startWeight = this.runtimeMorph.weights[idx]
    if (state.active[idx] === 1) {
      const startMs = state.startTimeMs[idx]
      const prevDur = Math.max(1, state.durationMs[idx])
      const t = Math.max(0, Math.min(1, (now - startMs) / prevDur))
      const e = easeInOut(t)
      startWeight = state.startWeight[idx] + (state.targetWeight[idx] - state.startWeight[idx]) * e
    }

    state.startWeight[idx] = startWeight
    state.targetWeight[idx] = clampedWeight
    state.startTimeMs[idx] = now
    state.durationMs[idx] = dur
    state.active[idx] = 1

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

  evaluatePose(): boolean {
    this.updateRotationTweens()
    this.updateTranslationTweens()
    const hasActiveMorphTweens = this.updateMorphWeightTweens()
    if (hasActiveMorphTweens) {
      this.applyMorphs()
    }

    // Compute initial world matrices (needed for IK solving to read bone positions)
    this.computeWorldMatrices()

    // Solve IK chains (modifies localRotations with final IK rotations)
    this.solveIKChains()

    // Recompute world matrices with final IK rotations applied to localRotations
    this.computeWorldMatrices()

    return hasActiveMorphTweens
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
