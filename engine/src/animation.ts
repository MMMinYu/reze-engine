import { Quat, Vec3 } from "./math"

export interface ControlPoint {
  x: number
  y: number
}

export interface BoneInterpolation {
  rotation: ControlPoint[]
  translationX: ControlPoint[]
  translationY: ControlPoint[]
  translationZ: ControlPoint[]
}

export const LINEAR_INTERPOLATION: BoneInterpolation = {
  rotation: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
  translationX: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
  translationY: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
  translationZ: [{ x: 20, y: 20 }, { x: 107, y: 107 }],
}

export interface BoneKeyframe {
  frame: number
  rotation: Quat
  translation: Vec3
  interpolation: BoneInterpolation
}

export interface MorphKeyframe {
  frame: number
  weight: number
}

export interface AnimationData {
  boneTracks: Record<string, BoneKeyframe[]>
  morphTracks: Record<string, MorphKeyframe[]>
}

/**
 * Cubic bezier interpolation using binary search.
 * Control points define the curve shape in 0-1 normalized space.
 */
export function bezierInterpolate(x1: number, x2: number, y1: number, y2: number, t: number): number {
  t = Math.max(0, Math.min(1, t))

  let start = 0
  let end = 1
  let mid = 0.5

  for (let i = 0; i < 15; i++) {
    const x = 3 * (1 - mid) * (1 - mid) * mid * x1 + 3 * (1 - mid) * mid * mid * x2 + mid * mid * mid

    if (Math.abs(x - t) < 0.0001) {
      break
    }

    if (x < t) {
      start = mid
    } else {
      end = mid
    }

    mid = (start + end) / 2
  }

  const y = 3 * (1 - mid) * (1 - mid) * mid * y1 + 3 * (1 - mid) * mid * mid * y2 + mid * mid * mid

  return y
}

const INV_127 = 1 / 127

/**
 * Convert raw VMD interpolation bytes (64-byte Uint8Array) to structured BoneInterpolation.
 */
export function rawInterpolationToBoneInterpolation(raw: Uint8Array): BoneInterpolation {
  return {
    rotation: [
      { x: raw[0], y: raw[2] },
      { x: raw[1], y: raw[3] },
    ],
    translationX: [
      { x: raw[0], y: raw[4] },
      { x: raw[8], y: raw[12] },
    ],
    translationY: [
      { x: raw[16], y: raw[20] },
      { x: raw[24], y: raw[28] },
    ],
    translationZ: [
      { x: raw[32], y: raw[36] },
      { x: raw[40], y: raw[44] },
    ],
  }
}

/**
 * Compute bezier-interpolated weight for a pair of control points.
 * Control point values are in 0-127 range.
 */
export function interpolateControlPoints(cp: ControlPoint[], t: number): number {
  return bezierInterpolate(
    cp[0].x * INV_127,
    cp[1].x * INV_127,
    cp[0].y * INV_127,
    cp[1].y * INV_127,
    t
  )
}
