/**
 * IK Solver implementation
 * Based on reference from babylon-mmd and Saba MMD library
 * https://github.com/benikabocha/saba/blob/master/src/Saba/Model/MMD/MMDIkSolver.cpp
 */

import { Mat4, Quat, Vec3 } from "./math"
import { Bone, IKLink, IKSolver, IKChainInfo, EulerRotationOrder, SolveAxis } from "./model"

const enum InternalEulerRotationOrder {
  YXZ = 0,
  ZYX = 1,
  XZY = 2,
}

const enum InternalSolveAxis {
  None = 0,
  Fixed = 1,
  X = 2,
  Y = 3,
  Z = 4,
}

class IKChain {
  public readonly boneIndex: number
  public readonly minimumAngle: Vec3 | null
  public readonly maximumAngle: Vec3 | null
  public readonly rotationOrder: InternalEulerRotationOrder
  public readonly solveAxis: InternalSolveAxis

  public constructor(boneIndex: number, link: IKLink) {
    this.boneIndex = boneIndex

    if (link.hasLimit && link.minAngle && link.maxAngle) {
      // Normalize min/max angles
      const minX = Math.min(link.minAngle.x, link.maxAngle.x)
      const minY = Math.min(link.minAngle.y, link.maxAngle.y)
      const minZ = Math.min(link.minAngle.z, link.maxAngle.z)
      const maxX = Math.max(link.minAngle.x, link.maxAngle.x)
      const maxY = Math.max(link.minAngle.y, link.maxAngle.y)
      const maxZ = Math.max(link.minAngle.z, link.maxAngle.z)
      this.minimumAngle = new Vec3(minX, minY, minZ)
      this.maximumAngle = new Vec3(maxX, maxY, maxZ)

      // Determine rotation order based on constraint ranges
      const halfPi = Math.PI * 0.5
      if (-halfPi < minX && maxX < halfPi) {
        this.rotationOrder = InternalEulerRotationOrder.YXZ
      } else if (-halfPi < minY && maxY < halfPi) {
        this.rotationOrder = InternalEulerRotationOrder.ZYX
      } else {
        this.rotationOrder = InternalEulerRotationOrder.XZY
      }

      // Determine solve axis optimization
      if (minX === 0 && maxX === 0 && minY === 0 && maxY === 0 && minZ === 0 && maxZ === 0) {
        this.solveAxis = InternalSolveAxis.Fixed
      } else if (minY === 0 && maxY === 0 && minZ === 0 && maxZ === 0) {
        this.solveAxis = InternalSolveAxis.X
      } else if (minX === 0 && maxX === 0 && minZ === 0 && maxZ === 0) {
        this.solveAxis = InternalSolveAxis.Y
      } else if (minX === 0 && maxX === 0 && minY === 0 && maxY === 0) {
        this.solveAxis = InternalSolveAxis.Z
      } else {
        this.solveAxis = InternalSolveAxis.None
      }
    } else {
      this.minimumAngle = null
      this.maximumAngle = null
      this.rotationOrder = InternalEulerRotationOrder.XZY // not used
      this.solveAxis = InternalSolveAxis.None
    }
  }
}

/**
 * Solve IK chains for a model
 */
export class IKSolverSystem {
  private static readonly EPSILON = 1.0e-8
  private static readonly THRESHOLD = (88 * Math.PI) / 180

  /**
   * Solve all IK chains
   */
  public static solve(
    ikSolvers: IKSolver[],
    bones: Bone[],
    localRotations: Float32Array,
    localTranslations: Float32Array,
    worldMatrices: Float32Array,
    ikChainInfo: IKChainInfo[],
    usePhysics: boolean = false
  ): void {
    for (const solver of ikSolvers) {
      if (usePhysics && solver.canSkipWhenPhysicsEnabled) {
        continue
      }
      this.solveIK(solver, bones, localRotations, localTranslations, worldMatrices, ikChainInfo)
    }
  }

  private static solveIK(
    solver: IKSolver,
    bones: Bone[],
    localRotations: Float32Array,
    localTranslations: Float32Array,
    worldMatrices: Float32Array,
    ikChainInfo: IKChainInfo[]
  ): void {
    if (solver.links.length === 0) return

    const ikBoneIndex = solver.ikBoneIndex
    const targetBoneIndex = solver.targetBoneIndex

    // Reset IK rotations
    for (const link of solver.links) {
      const chainInfo = ikChainInfo[link.boneIndex]
      if (chainInfo) {
        chainInfo.ikRotation = new Quat(0, 0, 0, 1)
      }
    }

    // Get IK bone and target positions
    const ikPosition = this.getWorldTranslation(ikBoneIndex, worldMatrices)
    const targetPosition = this.getWorldTranslation(targetBoneIndex, worldMatrices)

    if (ikPosition.subtract(targetPosition).length() < this.EPSILON) return

    // Build IK chains
    const chains: IKChain[] = []
    for (const link of solver.links) {
      chains.push(new IKChain(link.boneIndex, link))
    }

    // Update chain bones and target bone world matrices (initial state, no IK yet)
    for (let i = chains.length - 1; i >= 0; i--) {
      this.updateWorldMatrix(chains[i].boneIndex, bones, localRotations, localTranslations, worldMatrices)
    }
    this.updateWorldMatrix(targetBoneIndex, bones, localRotations, localTranslations, worldMatrices)

    // Re-read positions after initial update
    const updatedIkPosition = this.getWorldTranslation(ikBoneIndex, worldMatrices)
    const updatedTargetPosition = this.getWorldTranslation(targetBoneIndex, worldMatrices)

    if (updatedIkPosition.subtract(updatedTargetPosition).length() < this.EPSILON) return

    // Solve iteratively
    const iteration = Math.min(solver.iterationCount, 256)
    const halfIteration = iteration >> 1

    for (let i = 0; i < iteration; i++) {
      for (let chainIndex = 0; chainIndex < chains.length; chainIndex++) {
        const chain = chains[chainIndex]
        if (chain.solveAxis !== InternalSolveAxis.Fixed) {
          this.solveChain(
            chain,
            chainIndex,
            solver,
            ikBoneIndex,
            targetBoneIndex,
            bones,
            localRotations,
            localTranslations,
            worldMatrices,
            ikChainInfo,
            i < halfIteration
          )
        }
      }

      // Re-read positions after this iteration
      const currentIkPosition = this.getWorldTranslation(ikBoneIndex, worldMatrices)
      const currentTargetPosition = this.getWorldTranslation(targetBoneIndex, worldMatrices)
      const distance = currentIkPosition.subtract(currentTargetPosition).length()
      if (distance < this.EPSILON) break
    }

    // Apply IK rotations to local rotations
    for (const link of solver.links) {
      const chainInfo = ikChainInfo[link.boneIndex]
      if (chainInfo && chainInfo.ikRotation) {
        const qi = link.boneIndex * 4
        const localRot = new Quat(
          localRotations[qi],
          localRotations[qi + 1],
          localRotations[qi + 2],
          localRotations[qi + 3]
        )
        const finalRot = chainInfo.ikRotation.multiply(localRot).normalize()
        localRotations[qi] = finalRot.x
        localRotations[qi + 1] = finalRot.y
        localRotations[qi + 2] = finalRot.z
        localRotations[qi + 3] = finalRot.w
      }
    }
  }

  private static solveChain(
    chain: IKChain,
    chainIndex: number,
    solver: IKSolver,
    ikBoneIndex: number,
    targetBoneIndex: number,
    bones: Bone[],
    localRotations: Float32Array,
    localTranslations: Float32Array,
    worldMatrices: Float32Array,
    ikChainInfo: IKChainInfo[],
    useAxis: boolean
  ): void {
    const chainBoneIndex = chain.boneIndex
    const chainPosition = this.getWorldTranslation(chainBoneIndex, worldMatrices)
    const ikPosition = this.getWorldTranslation(ikBoneIndex, worldMatrices)
    const targetPosition = this.getWorldTranslation(targetBoneIndex, worldMatrices)

    const chainTargetVector = chainPosition.subtract(targetPosition).normalize()
    const chainIkVector = chainPosition.subtract(ikPosition).normalize()

    const chainRotationAxis = chainTargetVector.cross(chainIkVector)
    if (chainRotationAxis.length() < this.EPSILON) return

    // Get parent's world rotation matrix (translation removed)
    const parentWorldRotMatrix = this.getParentWorldRotationMatrix(chainBoneIndex, bones, worldMatrices)

    let finalRotationAxis: Vec3
    if (chain.minimumAngle !== null && useAxis) {
      switch (chain.solveAxis) {
        case InternalSolveAxis.None: {
          const invParentRot = parentWorldRotMatrix.inverse()
          finalRotationAxis = this.transformNormal(chainRotationAxis, invParentRot).normalize()
          break
        }
        case InternalSolveAxis.X: {
          const m = parentWorldRotMatrix.values
          const axisX = new Vec3(m[0], m[1], m[2])
          const dot = chainRotationAxis.dot(axisX)
          finalRotationAxis = new Vec3(dot >= 0 ? 1 : -1, 0, 0)
          break
        }
        case InternalSolveAxis.Y: {
          const m = parentWorldRotMatrix.values
          const axisY = new Vec3(m[4], m[5], m[6])
          const dot = chainRotationAxis.dot(axisY)
          finalRotationAxis = new Vec3(0, dot >= 0 ? 1 : -1, 0)
          break
        }
        case InternalSolveAxis.Z: {
          const m = parentWorldRotMatrix.values
          const axisZ = new Vec3(m[8], m[9], m[10])
          const dot = chainRotationAxis.dot(axisZ)
          finalRotationAxis = new Vec3(0, 0, dot >= 0 ? 1 : -1)
          break
        }
        default:
          finalRotationAxis = chainRotationAxis
      }
    } else {
      const invParentRot = parentWorldRotMatrix.inverse()
      finalRotationAxis = this.transformNormal(chainRotationAxis, invParentRot).normalize()
    }

    let dot = chainTargetVector.dot(chainIkVector)
    dot = Math.max(-1.0, Math.min(1.0, dot))

    const angle = Math.min(solver.limitAngle * (chainIndex + 1), Math.acos(dot))
    const ikRotation = Quat.fromAxisAngle(finalRotationAxis, angle)

    const chainInfo = ikChainInfo[chainBoneIndex]
    if (chainInfo) {
      chainInfo.ikRotation = ikRotation.multiply(chainInfo.ikRotation)

      // Apply angle constraints if present
      if (chain.minimumAngle !== null && chain.maximumAngle !== null) {
        const qi = chainBoneIndex * 4
        const localRot = new Quat(
          localRotations[qi],
          localRotations[qi + 1],
          localRotations[qi + 2],
          localRotations[qi + 3]
        )
        chainInfo.localRotation = localRot.clone()

        const combinedRot = chainInfo.ikRotation.multiply(localRot)
        const rotMatrix = Mat4.fromQuat(combinedRot.x, combinedRot.y, combinedRot.z, combinedRot.w)
        const m = rotMatrix.values

        let rX: number, rY: number, rZ: number

        switch (chain.rotationOrder) {
          case InternalEulerRotationOrder.YXZ: {
            rX = Math.asin(-m[9]) // m32
            if (Math.abs(rX) > this.THRESHOLD) {
              rX = rX < 0 ? -this.THRESHOLD : this.THRESHOLD
            }
            let cosX = Math.cos(rX)
            if (cosX !== 0) cosX = 1 / cosX
            rY = Math.atan2(m[8] * cosX, m[10] * cosX) // m31, m33
            rZ = Math.atan2(m[1] * cosX, m[5] * cosX) // m12, m22

            rX = this.limitAngle(rX, chain.minimumAngle.x, chain.maximumAngle.x, useAxis)
            rY = this.limitAngle(rY, chain.minimumAngle.y, chain.maximumAngle.y, useAxis)
            rZ = this.limitAngle(rZ, chain.minimumAngle.z, chain.maximumAngle.z, useAxis)

            chainInfo.ikRotation = Quat.fromAxisAngle(new Vec3(0, 1, 0), rY)
            chainInfo.ikRotation = chainInfo.ikRotation.multiply(Quat.fromAxisAngle(new Vec3(1, 0, 0), rX))
            chainInfo.ikRotation = chainInfo.ikRotation.multiply(Quat.fromAxisAngle(new Vec3(0, 0, 1), rZ))
            break
          }
          case InternalEulerRotationOrder.ZYX: {
            rY = Math.asin(-m[2]) // m13
            if (Math.abs(rY) > this.THRESHOLD) {
              rY = rY < 0 ? -this.THRESHOLD : this.THRESHOLD
            }
            let cosY = Math.cos(rY)
            if (cosY !== 0) cosY = 1 / cosY
            rX = Math.atan2(m[6] * cosY, m[10] * cosY) // m23, m33
            rZ = Math.atan2(m[1] * cosY, m[0] * cosY) // m12, m11

            rX = this.limitAngle(rX, chain.minimumAngle.x, chain.maximumAngle.x, useAxis)
            rY = this.limitAngle(rY, chain.minimumAngle.y, chain.maximumAngle.y, useAxis)
            rZ = this.limitAngle(rZ, chain.minimumAngle.z, chain.maximumAngle.z, useAxis)

            chainInfo.ikRotation = Quat.fromAxisAngle(new Vec3(0, 0, 1), rZ)
            chainInfo.ikRotation = chainInfo.ikRotation.multiply(Quat.fromAxisAngle(new Vec3(0, 1, 0), rY))
            chainInfo.ikRotation = chainInfo.ikRotation.multiply(Quat.fromAxisAngle(new Vec3(1, 0, 0), rX))
            break
          }
          case InternalEulerRotationOrder.XZY: {
            rZ = Math.asin(-m[4]) // m21
            if (Math.abs(rZ) > this.THRESHOLD) {
              rZ = rZ < 0 ? -this.THRESHOLD : this.THRESHOLD
            }
            let cosZ = Math.cos(rZ)
            if (cosZ !== 0) cosZ = 1 / cosZ
            rX = Math.atan2(m[6] * cosZ, m[5] * cosZ) // m23, m22
            rY = Math.atan2(m[8] * cosZ, m[0] * cosZ) // m31, m11

            rX = this.limitAngle(rX, chain.minimumAngle.x, chain.maximumAngle.x, useAxis)
            rY = this.limitAngle(rY, chain.minimumAngle.y, chain.maximumAngle.y, useAxis)
            rZ = this.limitAngle(rZ, chain.minimumAngle.z, chain.maximumAngle.z, useAxis)

            chainInfo.ikRotation = Quat.fromAxisAngle(new Vec3(1, 0, 0), rX)
            chainInfo.ikRotation = chainInfo.ikRotation.multiply(Quat.fromAxisAngle(new Vec3(0, 0, 1), rZ))
            chainInfo.ikRotation = chainInfo.ikRotation.multiply(Quat.fromAxisAngle(new Vec3(0, 1, 0), rY))
            break
          }
        }

        const invertedLocalRotation = localRot.conjugate().normalize()
        chainInfo.ikRotation = chainInfo.ikRotation.multiply(invertedLocalRotation)
      }
    }

    // Update world matrices for affected bones (using IK-modified rotations)
    for (let i = chainIndex; i >= 0; i--) {
      const link = solver.links[i]
      this.updateWorldMatrixWithIK(link.boneIndex, bones, localRotations, localTranslations, worldMatrices, ikChainInfo)
    }
    this.updateWorldMatrix(targetBoneIndex, bones, localRotations, localTranslations, worldMatrices)
  }

  private static limitAngle(angle: number, min: number, max: number, useAxis: boolean): number {
    if (angle < min) {
      const diff = 2 * min - angle
      return diff <= max && useAxis ? diff : min
    } else if (angle > max) {
      const diff = 2 * max - angle
      return diff >= min && useAxis ? diff : max
    } else {
      return angle
    }
  }

  private static getWorldTranslation(boneIndex: number, worldMatrices: Float32Array): Vec3 {
    const offset = boneIndex * 16
    return new Vec3(worldMatrices[offset + 12], worldMatrices[offset + 13], worldMatrices[offset + 14])
  }

  private static getParentWorldRotationMatrix(boneIndex: number, bones: Bone[], worldMatrices: Float32Array): Mat4 {
    const bone = bones[boneIndex]
    if (bone.parentIndex >= 0) {
      const parentOffset = bone.parentIndex * 16
      const parentMat = new Mat4(worldMatrices.subarray(parentOffset, parentOffset + 16))
      // Remove translation
      const rotMat = Mat4.identity()
      const m = parentMat.values
      rotMat.values.set([m[0], m[1], m[2], 0, m[4], m[5], m[6], 0, m[8], m[9], m[10], 0, 0, 0, 0, 1])
      return rotMat
    } else {
      return Mat4.identity()
    }
  }

  private static transformNormal(normal: Vec3, matrix: Mat4): Vec3 {
    const m = matrix.values
    return new Vec3(
      m[0] * normal.x + m[4] * normal.y + m[8] * normal.z,
      m[1] * normal.x + m[5] * normal.y + m[9] * normal.z,
      m[2] * normal.x + m[6] * normal.y + m[10] * normal.z
    )
  }

  private static updateWorldMatrixWithIK(
    boneIndex: number,
    bones: Bone[],
    localRotations: Float32Array,
    localTranslations: Float32Array,
    worldMatrices: Float32Array,
    ikChainInfo: IKChainInfo[]
  ): void {
    const bone = bones[boneIndex]
    const qi = boneIndex * 4
    const ti = boneIndex * 3

    // Use IK-modified rotation if available
    const localRot = new Quat(
      localRotations[qi],
      localRotations[qi + 1],
      localRotations[qi + 2],
      localRotations[qi + 3]
    )
    const chainInfo = ikChainInfo[boneIndex]
    let finalRot = localRot
    if (chainInfo && chainInfo.ikRotation) {
      finalRot = chainInfo.ikRotation.multiply(localRot).normalize()
    }
    const rotateM = Mat4.fromQuat(finalRot.x, finalRot.y, finalRot.z, finalRot.w)

    const localTx = localTranslations[ti]
    const localTy = localTranslations[ti + 1]
    const localTz = localTranslations[ti + 2]

    const localM = Mat4.identity()
      .translateInPlace(bone.bindTranslation[0], bone.bindTranslation[1], bone.bindTranslation[2])
      .multiply(rotateM)
      .translateInPlace(localTx, localTy, localTz)

    const worldOffset = boneIndex * 16
    if (bone.parentIndex >= 0) {
      const parentOffset = bone.parentIndex * 16
      const parentMat = new Mat4(worldMatrices.subarray(parentOffset, parentOffset + 16))
      const worldMat = parentMat.multiply(localM)
      worldMatrices.subarray(worldOffset, worldOffset + 16).set(worldMat.values)
    } else {
      worldMatrices.subarray(worldOffset, worldOffset + 16).set(localM.values)
    }
  }

  private static updateWorldMatrix(
    boneIndex: number,
    bones: Bone[],
    localRotations: Float32Array,
    localTranslations: Float32Array,
    worldMatrices: Float32Array
  ): void {
    const bone = bones[boneIndex]
    const qi = boneIndex * 4
    const ti = boneIndex * 3

    const localRot = new Quat(
      localRotations[qi],
      localRotations[qi + 1],
      localRotations[qi + 2],
      localRotations[qi + 3]
    )
    const rotateM = Mat4.fromQuat(localRot.x, localRot.y, localRot.z, localRot.w)

    const localTx = localTranslations[ti]
    const localTy = localTranslations[ti + 1]
    const localTz = localTranslations[ti + 2]

    const localM = Mat4.identity()
      .translateInPlace(bone.bindTranslation[0], bone.bindTranslation[1], bone.bindTranslation[2])
      .multiply(rotateM)
      .translateInPlace(localTx, localTy, localTz)

    const worldOffset = boneIndex * 16
    if (bone.parentIndex >= 0) {
      const parentOffset = bone.parentIndex * 16
      const parentMat = new Mat4(worldMatrices.subarray(parentOffset, parentOffset + 16))
      const worldMat = parentMat.multiply(localM)
      worldMatrices.subarray(worldOffset, worldOffset + 16).set(worldMat.values)
    } else {
      worldMatrices.subarray(worldOffset, worldOffset + 16).set(localM.values)
    }
  }
}
