/**
 * IK Solver implementation
 * Based on reference from babylon-mmd and Saba MMD library
 * https://github.com/benikabocha/saba/blob/master/src/Saba/Model/MMD/MMDIkSolver.cpp
 */

import { Mat4, Quat, Vec3 } from "./math"
import { Bone, IKLink, IKSolver, IKChainInfo } from "./model"

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
    localRotations: Quat[],
    localTranslations: Vec3[],
    worldMatrices: Mat4[],
    ikChainInfo: IKChainInfo[]
  ): void {
    for (const solver of ikSolvers) {
      this.solveIK(solver, bones, localRotations, localTranslations, worldMatrices, ikChainInfo)
    }
  }

  private static solveIK(
    solver: IKSolver,
    bones: Bone[],
    localRotations: Quat[],
    localTranslations: Vec3[],
    worldMatrices: Mat4[],
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

    if (this.getDistance(ikBoneIndex, targetBoneIndex, worldMatrices) < this.EPSILON) return

    // Build IK chains
    const chains: IKChain[] = []
    for (const link of solver.links) {
      chains.push(new IKChain(link.boneIndex, link))
    }

    // Update chain bones and target bone world matrices (initial state, no IK yet)
    for (let i = chains.length - 1; i >= 0; i--) {
      this.updateWorldMatrix(chains[i].boneIndex, bones, localRotations, localTranslations, worldMatrices, undefined)
    }
    this.updateWorldMatrix(targetBoneIndex, bones, localRotations, localTranslations, worldMatrices, undefined)

    if (this.getDistance(ikBoneIndex, targetBoneIndex, worldMatrices) < this.EPSILON) return

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

      if (this.getDistance(ikBoneIndex, targetBoneIndex, worldMatrices) < this.EPSILON) break
    }

    // Apply IK rotations to local rotations
    for (const link of solver.links) {
      const chainInfo = ikChainInfo[link.boneIndex]
      if (chainInfo?.ikRotation) {
        const localRot = localRotations[link.boneIndex]
        const finalRot = chainInfo.ikRotation.multiply(localRot).normalize()
        localRot.set(finalRot)
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
    localRotations: Quat[],
    localTranslations: Vec3[],
    worldMatrices: Mat4[],
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
        case InternalSolveAxis.X:
        case InternalSolveAxis.Y:
        case InternalSolveAxis.Z: {
          const m = parentWorldRotMatrix.values
          const axisOffset = (chain.solveAxis - InternalSolveAxis.X) * 4
          const axis = new Vec3(m[axisOffset], m[axisOffset + 1], m[axisOffset + 2])
          const dot = chainRotationAxis.dot(axis)
          const sign = dot >= 0 ? 1 : -1
          finalRotationAxis =
            chain.solveAxis === InternalSolveAxis.X
              ? new Vec3(sign, 0, 0)
              : chain.solveAxis === InternalSolveAxis.Y
              ? new Vec3(0, sign, 0)
              : new Vec3(0, 0, sign)
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
      if (chain.minimumAngle && chain.maximumAngle) {
        const localRot = localRotations[chainBoneIndex]
        chainInfo.localRotation = localRot.clone()

        const combinedRot = chainInfo.ikRotation.multiply(localRot)
        const euler = this.extractEulerAngles(combinedRot, chain.rotationOrder)
        const limited = this.limitEulerAngles(euler, chain.minimumAngle, chain.maximumAngle, useAxis)
        chainInfo.ikRotation = this.reconstructQuatFromEuler(limited, chain.rotationOrder)
        // Clone localRot to avoid mutating, then conjugate and normalize
        chainInfo.ikRotation = chainInfo.ikRotation.multiply(localRot.clone().conjugate().normalize())
      }
    }

    // Update world matrices for affected bones (using IK-modified rotations)
    for (let i = chainIndex; i >= 0; i--) {
      const link = solver.links[i]
      this.updateWorldMatrix(link.boneIndex, bones, localRotations, localTranslations, worldMatrices, ikChainInfo)
    }
    this.updateWorldMatrix(targetBoneIndex, bones, localRotations, localTranslations, worldMatrices, undefined)
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

  private static getDistance(boneIndex1: number, boneIndex2: number, worldMatrices: Mat4[]): number {
    const pos1 = this.getWorldTranslation(boneIndex1, worldMatrices)
    const pos2 = this.getWorldTranslation(boneIndex2, worldMatrices)
    return pos1.subtract(pos2).length()
  }

  private static getWorldTranslation(boneIndex: number, worldMatrices: Mat4[]): Vec3 {
    const mat = worldMatrices[boneIndex]
    return new Vec3(mat.values[12], mat.values[13], mat.values[14])
  }

  private static extractEulerAngles(quat: Quat, order: InternalEulerRotationOrder): Vec3 {
    const rotMatrix = Mat4.fromQuat(quat.x, quat.y, quat.z, quat.w)
    const m = rotMatrix.values

    switch (order) {
      case InternalEulerRotationOrder.YXZ: {
        let rX = Math.asin(-m[9])
        if (Math.abs(rX) > this.THRESHOLD) rX = rX < 0 ? -this.THRESHOLD : this.THRESHOLD
        let cosX = Math.cos(rX)
        if (cosX !== 0) cosX = 1 / cosX
        const rY = Math.atan2(m[8] * cosX, m[10] * cosX)
        const rZ = Math.atan2(m[1] * cosX, m[5] * cosX)
        return new Vec3(rX, rY, rZ)
      }
      case InternalEulerRotationOrder.ZYX: {
        let rY = Math.asin(-m[2])
        if (Math.abs(rY) > this.THRESHOLD) rY = rY < 0 ? -this.THRESHOLD : this.THRESHOLD
        let cosY = Math.cos(rY)
        if (cosY !== 0) cosY = 1 / cosY
        const rX = Math.atan2(m[6] * cosY, m[10] * cosY)
        const rZ = Math.atan2(m[1] * cosY, m[0] * cosY)
        return new Vec3(rX, rY, rZ)
      }
      case InternalEulerRotationOrder.XZY: {
        let rZ = Math.asin(-m[4])
        if (Math.abs(rZ) > this.THRESHOLD) rZ = rZ < 0 ? -this.THRESHOLD : this.THRESHOLD
        let cosZ = Math.cos(rZ)
        if (cosZ !== 0) cosZ = 1 / cosZ
        const rX = Math.atan2(m[6] * cosZ, m[5] * cosZ)
        const rY = Math.atan2(m[8] * cosZ, m[0] * cosZ)
        return new Vec3(rX, rY, rZ)
      }
    }
  }

  private static limitEulerAngles(euler: Vec3, min: Vec3, max: Vec3, useAxis: boolean): Vec3 {
    return new Vec3(
      this.limitAngle(euler.x, min.x, max.x, useAxis),
      this.limitAngle(euler.y, min.y, max.y, useAxis),
      this.limitAngle(euler.z, min.z, max.z, useAxis)
    )
  }

  private static reconstructQuatFromEuler(euler: Vec3, order: InternalEulerRotationOrder): Quat {
    const axes = [
      [new Vec3(1, 0, 0), new Vec3(0, 1, 0), new Vec3(0, 0, 1)],
      [new Vec3(0, 0, 1), new Vec3(0, 1, 0), new Vec3(1, 0, 0)],
      [new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(0, 0, 1)],
    ]

    const [axis1, axis2, axis3] = axes[order]
    const [angle1, angle2, angle3] =
      order === InternalEulerRotationOrder.YXZ
        ? [euler.y, euler.x, euler.z]
        : order === InternalEulerRotationOrder.ZYX
        ? [euler.z, euler.y, euler.x]
        : [euler.x, euler.z, euler.y]

    let result = Quat.fromAxisAngle(axis1, angle1)
    result = result.multiply(Quat.fromAxisAngle(axis2, angle2))
    result = result.multiply(Quat.fromAxisAngle(axis3, angle3))
    return result
  }

  private static getParentWorldRotationMatrix(boneIndex: number, bones: Bone[], worldMatrices: Mat4[]): Mat4 {
    const bone = bones[boneIndex]
    if (bone.parentIndex >= 0) {
      const parentMat = worldMatrices[bone.parentIndex]
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

  private static updateWorldMatrix(
    boneIndex: number,
    bones: Bone[],
    localRotations: Quat[],
    localTranslations: Vec3[],
    worldMatrices: Mat4[],
    ikChainInfo?: IKChainInfo[]
  ): void {
    const bone = bones[boneIndex]
    const localRot = localRotations[boneIndex]
    const localTrans = localTranslations[boneIndex]

    // Apply IK rotation if available
    let finalRot = localRot
    if (ikChainInfo) {
      const chainInfo = ikChainInfo[boneIndex]
      if (chainInfo && chainInfo.ikRotation) {
        finalRot = chainInfo.ikRotation.multiply(localRot).normalize()
      }
    }
    const rotateM = Mat4.fromQuat(finalRot.x, finalRot.y, finalRot.z, finalRot.w)

    const localM = Mat4.identity()
      .translateInPlace(bone.bindTranslation[0], bone.bindTranslation[1], bone.bindTranslation[2])
      .multiply(rotateM)
      .translateInPlace(localTrans.x, localTrans.y, localTrans.z)

    const worldMat = worldMatrices[boneIndex]
    if (bone.parentIndex >= 0) {
      const parentMat = worldMatrices[bone.parentIndex]
      const result = parentMat.multiply(localM)
      worldMat.values.set(result.values)
    } else {
      worldMat.values.set(localM.values)
    }
  }
}
