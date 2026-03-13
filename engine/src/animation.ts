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

// Cubic bezier in normalized 0–1 space (binary search on x)
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

// VMD 64-byte interpolation blob → BoneInterpolation
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

// Control points are 0–127 VMD bytes
export function interpolateControlPoints(cp: ControlPoint[], t: number): number {
  return bezierInterpolate(
    cp[0].x * INV_127,
    cp[1].x * INV_127,
    cp[0].y * INV_127,
    cp[1].y * INV_127,
    t
  )
}
