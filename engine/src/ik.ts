import { Quat, Vec3, Mat4 } from "./math"
import type { Bone, Skeleton } from "./model"

export interface IKLink {
  boneIndex: number
  hasLimit: boolean
  minAngle?: Vec3 // Euler angles in radians
  maxAngle?: Vec3 // Euler angles in radians
}

export interface IKChain {
  targetBoneIndex: number // Bone that should reach the target position
  effectorBoneIndex: number // End effector bone (usually the last bone in chain)
  iterationCount: number
  rotationConstraint: number // Angle limit in radians (typically 0.1-0.5)
  links: IKLink[] // Chain links from effector toward root
  enabled: boolean
}

export class IK {
  private chains: IKChain[]
  private computeWorldMatricesCallback?: () => void
  // Track last target positions to detect movement
  private lastTargetPositions: Map<number, Vec3> = new Map()
  // Track convergence state for each chain (true = converged, skip solving)
  private convergedChains: Set<number> = new Set()
  // Accumulated IK rotations for each bone (boneIndex -> quaternion)
  private ikRotations: Map<number, Quat> = new Map()

  constructor(chains: IKChain[] = []) {
    this.chains = chains
  }

  // Set the callback to use Model's computeWorldMatrices
  // The callback doesn't need parameters since Model uses its own runtime state
  setComputeWorldMatricesCallback(callback: () => void): void {
    this.computeWorldMatricesCallback = callback
  }

  getChains(): IKChain[] {
    return this.chains
  }

  // Enable/disable IK chain by target bone name
  enableChain(targetBoneName: string, enabled: boolean): void {
    // Chains are identified by target bone index, but we need to find by name
    // This will be called from Model which has bone name lookup
    for (const chain of this.chains) {
      // We'll need to pass bone names or use indices - for now, this is a placeholder
      // The actual implementation will be in Model class
    }
  }

  // Main IK solve method - modifies bone local rotations in-place
  solve(
    skeleton: Skeleton,
    localRotations: Float32Array,
    localTranslations: Float32Array,
    worldMatrices: Float32Array
  ): void {
    if (this.chains.length === 0) return

    const boneCount = skeleton.bones.length

    // Reset accumulated IK rotations for all chain bones (as per reference)
    for (const chain of this.chains) {
      for (const link of chain.links) {
        const boneIdx = link.boneIndex
        if (boneIdx >= 0 && boneIdx < boneCount) {
          this.ikRotations.set(boneIdx, new Quat(0, 0, 0, 1))
        }
      }
    }

    // Use Model's computeWorldMatrices if available (it uses the same arrays)
    // Otherwise fall back to simplified version
    if (this.computeWorldMatricesCallback) {
      this.computeWorldMatricesCallback()
    } else {
      // Fallback to simplified version (shouldn't happen in normal usage)
      this.computeWorldMatrices(skeleton, localRotations, localTranslations, worldMatrices)
    }

    // Solve each IK chain
    for (const chain of this.chains) {
      if (!chain.enabled) continue

      const targetBoneIdx = chain.targetBoneIndex
      const effectorBoneIdx = chain.effectorBoneIndex

      if (targetBoneIdx < 0 || targetBoneIdx >= boneCount || effectorBoneIdx < 0 || effectorBoneIdx >= boneCount) {
        continue
      }

      // Get target position (world position of target bone)
      // In MMD, the target bone is the bone that should reach a specific position
      // The target bone's current world position is where we want the effector to reach
      const targetWorldMatIdx = targetBoneIdx * 16
      const targetWorldMat = new Mat4(worldMatrices.subarray(targetWorldMatIdx, targetWorldMatIdx + 16))
      const targetPos = targetWorldMat.getPosition()

      // Check if target has moved (detect any movement, even small)
      const lastTargetPos = this.lastTargetPositions.get(targetBoneIdx)
      let targetMoved = false
      if (!lastTargetPos) {
        // First time seeing this target, initialize position and always solve
        this.lastTargetPositions.set(targetBoneIdx, new Vec3(targetPos.x, targetPos.y, targetPos.z))
        targetMoved = true
      } else {
        const targetMoveDistance = targetPos.subtract(lastTargetPos).length()
        targetMoved = targetMoveDistance > 0.001 // Detect any movement > 0.001 units (0.1mm)
      }

      // Get current effector position
      const effectorWorldMatIdx = effectorBoneIdx * 16
      const effectorWorldMat = new Mat4(worldMatrices.subarray(effectorWorldMatIdx, effectorWorldMatIdx + 16))
      const effectorPos = effectorWorldMat.getPosition()

      // Check distance to target
      const distanceToTarget = effectorPos.subtract(targetPos).length()

      // If target moved, always clear convergence and solve
      if (targetMoved) {
        this.convergedChains.delete(targetBoneIdx)
        this.lastTargetPositions.set(targetBoneIdx, new Vec3(targetPos.x, targetPos.y, targetPos.z))
        // Always solve when target moves, regardless of distance
      } else if (distanceToTarget < 0.1) {
        // Target hasn't moved and we're already close, skip solving
        if (!this.convergedChains.has(targetBoneIdx)) {
          this.convergedChains.add(targetBoneIdx)
        }
        continue
      }
      // Otherwise, solve (target hasn't moved but effector is far from target)

      // Solve using CCD
      // Note: In PMX, links are stored from effector toward root
      // So links[0] is the effector, links[links.length-1] is closest to root
      this.solveCCD(chain, skeleton, localRotations, localTranslations, worldMatrices, targetPos)

      // Recompute world matrices after IK adjustments
      if (this.computeWorldMatricesCallback) {
        this.computeWorldMatricesCallback()
      } else {
        this.computeWorldMatrices(skeleton, localRotations, localTranslations, worldMatrices)
      }
    }
  }

  // Cyclic Coordinate Descent IK solver (based on saba MMD implementation)
  private solveCCD(
    chain: IKChain,
    skeleton: Skeleton,
    localRotations: Float32Array,
    localTranslations: Float32Array,
    worldMatrices: Float32Array,
    targetPos: Vec3
  ): void {
    const bones = skeleton.bones
    const iterationCount = chain.iterationCount
    const rotationConstraint = chain.rotationConstraint
    const links = chain.links

    if (links.length === 0) return

    const effectorBoneIdx = chain.effectorBoneIndex

    // Get effector position
    const effectorWorldMatIdx = effectorBoneIdx * 16
    const effectorWorldMat = new Mat4(worldMatrices.subarray(effectorWorldMatIdx, effectorWorldMatIdx + 16))
    let effectorPos = effectorWorldMat.getPosition()

    // Check initial distance - only skip if extremely close (numerical precision threshold)
    const initialDistanceSq = effectorPos.subtract(targetPos).lengthSquared()
    if (initialDistanceSq < 1.0e-10) {
      this.convergedChains.add(chain.targetBoneIndex)
      return
    }

    const halfIteration = iterationCount >> 1

    for (let iter = 0; iter < iterationCount; iter++) {
      const useAxis = iter < halfIteration

      for (let linkIdx = 0; linkIdx < links.length; linkIdx++) {
        const link = links[linkIdx]
        const jointBoneIdx = link.boneIndex

        if (jointBoneIdx < 0 || jointBoneIdx >= bones.length) continue

        const bone = bones[jointBoneIdx]

        // Get joint world position
        const jointWorldMatIdx = jointBoneIdx * 16
        const jointWorldMat = new Mat4(worldMatrices.subarray(jointWorldMatIdx, jointWorldMatIdx + 16))
        const jointPos = jointWorldMat.getPosition()

        // Vectors: from joint to target and effector (REVERSED from typical CCD!)
        // This matches the reference implementation
        const chainTargetVector = jointPos.subtract(targetPos).normalize()
        const chainIkVector = jointPos.subtract(effectorPos).normalize()

        // Rotation axis: cross product
        const chainRotationAxis = chainTargetVector.cross(chainIkVector)
        const axisLenSq = chainRotationAxis.lengthSquared()

        // Skip if axis is too small (vectors are parallel)
        if (axisLenSq < 1.0e-8) continue

        const chainRotationAxisNorm = chainRotationAxis.normalize()

        // Get parent's world rotation matrix (rotation part only)
        let parentWorldRot: Quat
        if (bone.parentIndex >= 0 && bone.parentIndex < bones.length) {
          const parentWorldMatIdx = bone.parentIndex * 16
          const parentWorldMat = new Mat4(worldMatrices.subarray(parentWorldMatIdx, parentWorldMatIdx + 16))
          parentWorldRot = parentWorldMat.toQuat()
        } else {
          parentWorldRot = new Quat(0, 0, 0, 1)
        }

        // Transform rotation axis to parent's local space
        // Invert parent rotation: parentWorldRot^-1
        const parentWorldRotInv = parentWorldRot.conjugate()
        // Transform axis: parentWorldRotInv * axis (as vector)
        const localAxis = parentWorldRotInv.rotateVec(chainRotationAxisNorm).normalize()

        // Calculate angle between vectors
        const dot = Math.max(-1.0, Math.min(1.0, chainTargetVector.dot(chainIkVector)))
        const angle = Math.min(rotationConstraint * (linkIdx + 1), Math.acos(dot))

        // Create rotation quaternion from axis and angle
        // q = (sin(angle/2) * axis, cos(angle/2))
        const halfAngle = angle * 0.5
        const sinHalf = Math.sin(halfAngle)
        const cosHalf = Math.cos(halfAngle)
        const rotationFromAxis = new Quat(
          localAxis.x * sinHalf,
          localAxis.y * sinHalf,
          localAxis.z * sinHalf,
          cosHalf
        ).normalize()

        // Get accumulated ikRotation for this bone (or identity if first time)
        let accumulatedIkRot = this.ikRotations.get(jointBoneIdx) || new Quat(0, 0, 0, 1)

        // Accumulate rotation: ikRotation = rotationFromAxis * ikRotation
        // Reference: ikRotation.multiplyToRef(chainBone.ikChainInfo!.ikRotation, chainBone.ikChainInfo!.ikRotation)
        // This means: ikRotation = rotationFromAxis * accumulatedIkRot
        accumulatedIkRot = rotationFromAxis.multiply(accumulatedIkRot)
        this.ikRotations.set(jointBoneIdx, accumulatedIkRot)

        // Get current local rotation
        const qi = jointBoneIdx * 4
        const currentLocalRot = new Quat(
          localRotations[qi],
          localRotations[qi + 1],
          localRotations[qi + 2],
          localRotations[qi + 3]
        )

        // Reference: ikRotation.multiplyToRef(chainBone.ikChainInfo!.localRotation, ikRotation)
        // This means: tempRot = accumulatedIkRot * currentLocalRot
        let tempRot = accumulatedIkRot.multiply(currentLocalRot)

        // Apply angle constraints if specified (on the combined rotation)
        if (link.hasLimit && link.minAngle && link.maxAngle) {
          tempRot = this.applyAngleConstraints(tempRot, link.minAngle, link.maxAngle)
        }

        // Reference: ikRotation.multiplyToRef(invertedLocalRotation, ikRotation)
        // This means: accumulatedIkRot = tempRot * currentLocalRot^-1
        // But we need the new local rotation, not the accumulated IK rotation
        // The new local rotation should be: newLocalRot such that accumulatedIkRot * newLocalRot = tempRot
        // So: newLocalRot = accumulatedIkRot^-1 * tempRot
        // But wait, the reference updates ikRotation, not localRotation directly...
        // Actually, looking at the reference, it seems like ikRotation is used to compute the final rotation
        // Let me try a different approach: the reference applies constraints to (ikRotation * localRotation)
        // then extracts the new ikRotation, but we need the new localRotation

        // Actually, I think the issue is that we should apply: newLocalRot = tempRot (the constrained result)
        // But we need to extract what the new local rotation should be
        // If tempRot = accumulatedIkRot * currentLocalRot (after constraints)
        // Then: newLocalRot = accumulatedIkRot^-1 * tempRot
        const accumulatedIkRotInv = accumulatedIkRot.conjugate()
        let newLocalRot = accumulatedIkRotInv.multiply(tempRot)

        // Update local rotation
        const normalized = newLocalRot.normalize()
        localRotations[qi] = normalized.x
        localRotations[qi + 1] = normalized.y
        localRotations[qi + 2] = normalized.z
        localRotations[qi + 3] = normalized.w

        // Update accumulated IK rotation as per reference
        const localRotInv = currentLocalRot.conjugate()
        accumulatedIkRot = tempRot.multiply(localRotInv)
        this.ikRotations.set(jointBoneIdx, accumulatedIkRot)

        // Update world matrices after this link adjustment (only once per link, not per bone)
        if (this.computeWorldMatricesCallback) {
          this.computeWorldMatricesCallback()
        } else {
          this.computeWorldMatrices(skeleton, localRotations, localTranslations, worldMatrices)
        }

        // Update effector position for next link
        const updatedEffectorMat2 = new Mat4(worldMatrices.subarray(effectorWorldMatIdx, effectorWorldMatIdx + 16))
        effectorPos = updatedEffectorMat2.getPosition()

        // Early exit if converged (check against original target position)
        const currentDistanceSq = effectorPos.subtract(targetPos).lengthSquared()
        if (currentDistanceSq < 1.0e-10) {
          this.convergedChains.add(chain.targetBoneIndex)
          return
        }
      }

      // Check convergence at end of iteration
      const finalEffectorMat = new Mat4(worldMatrices.subarray(effectorWorldMatIdx, effectorWorldMatIdx + 16))
      const finalEffectorPos = finalEffectorMat.getPosition()
      const finalDistanceSq = finalEffectorPos.subtract(targetPos).lengthSquared()

      if (finalDistanceSq < 1.0e-10) {
        this.convergedChains.add(chain.targetBoneIndex)
        break
      }
    }
  }

  // Apply angle constraints to local rotation (Euler angle limits)
  private applyAngleConstraints(localRot: Quat, minAngle: Vec3, maxAngle: Vec3): Quat {
    // Convert quaternion to Euler angles
    const euler = localRot.toEuler()

    // Clamp each Euler angle component
    let clampedX = Math.max(minAngle.x, Math.min(maxAngle.x, euler.x))
    let clampedY = Math.max(minAngle.y, Math.min(maxAngle.y, euler.y))
    let clampedZ = Math.max(minAngle.z, Math.min(maxAngle.z, euler.z))

    // Convert back to quaternion (ZXY order, left-handed)
    return Quat.fromEuler(clampedX, clampedY, clampedZ)
  }

  // Compute world matrices from local rotations and translations
  // This matches Model.computeWorldMatrices logic (including append transforms)
  private computeWorldMatrices(
    skeleton: Skeleton,
    localRotations: Float32Array,
    localTranslations: Float32Array,
    worldMatrices: Float32Array
  ): void {
    const bones = skeleton.bones
    const boneCount = bones.length
    const computed = new Array(boneCount).fill(false)

    const computeWorld = (i: number): void => {
      if (computed[i]) return

      const bone = bones[i]
      if (bone.parentIndex >= boneCount) {
        console.warn(`[IK] bone ${i} parent out of range: ${bone.parentIndex}`)
      }

      const qi = i * 4
      const ti = i * 3

      // Get local rotation
      let rotateM = Mat4.fromQuat(
        localRotations[qi],
        localRotations[qi + 1],
        localRotations[qi + 2],
        localRotations[qi + 3]
      )
      let addLocalTx = 0,
        addLocalTy = 0,
        addLocalTz = 0

      // Handle append transforms (same as Model.computeWorldMatrices)
      const appendParentIdx = bone.appendParentIndex
      const hasAppend =
        bone.appendRotate && appendParentIdx !== undefined && appendParentIdx >= 0 && appendParentIdx < boneCount

      if (hasAppend) {
        const ratio = bone.appendRatio === undefined ? 1 : Math.max(-1, Math.min(1, bone.appendRatio))
        const hasRatio = Math.abs(ratio) > 1e-6

        if (hasRatio) {
          const apQi = appendParentIdx * 4
          const apTi = appendParentIdx * 3

          if (bone.appendRotate) {
            let ax = localRotations[apQi]
            let ay = localRotations[apQi + 1]
            let az = localRotations[apQi + 2]
            const aw = localRotations[apQi + 3]
            const absRatio = ratio < 0 ? -ratio : ratio
            if (ratio < 0) {
              ax = -ax
              ay = -ay
              az = -az
            }
            const identityQuat = new Quat(0, 0, 0, 1)
            const appendQuat = new Quat(ax, ay, az, aw)
            const result = Quat.slerp(identityQuat, appendQuat, absRatio)
            rotateM = Mat4.fromQuat(result.x, result.y, result.z, result.w).multiply(rotateM)
          }

          if (bone.appendMove) {
            const appendRatio = bone.appendRatio ?? 1
            addLocalTx = localTranslations[apTi] * appendRatio
            addLocalTy = localTranslations[apTi + 1] * appendRatio
            addLocalTz = localTranslations[apTi + 2] * appendRatio
          }
        }
      }

      // Get bone's own translation
      const boneTx = localTranslations[ti]
      const boneTy = localTranslations[ti + 1]
      const boneTz = localTranslations[ti + 2]

      // Build local matrix: bindTranslation + rotation + (bone translation + append translation)
      const localM = Mat4.identity().translateInPlace(
        bone.bindTranslation[0],
        bone.bindTranslation[1],
        bone.bindTranslation[2]
      )
      const transM = Mat4.identity().translateInPlace(boneTx + addLocalTx, boneTy + addLocalTy, boneTz + addLocalTz)
      const localMatrix = localM.multiply(rotateM).multiply(transM)

      const worldOffset = i * 16
      if (bone.parentIndex >= 0) {
        const p = bone.parentIndex
        if (!computed[p]) computeWorld(p)
        const parentOffset = p * 16
        const parentWorldMat = new Mat4(worldMatrices.subarray(parentOffset, parentOffset + 16))
        const worldMat = parentWorldMat.multiply(localMatrix)
        worldMatrices.set(worldMat.values, worldOffset)
      } else {
        worldMatrices.set(localMatrix.values, worldOffset)
      }
      computed[i] = true
    }

    // Process all bones
    for (let i = 0; i < boneCount; i++) computeWorld(i)
  }
}
