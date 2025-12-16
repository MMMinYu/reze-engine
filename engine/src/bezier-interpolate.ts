/**
 * Bezier interpolation for VMD animations
 * Based on the reference implementation from babylon-mmd
 */

/**
 * Bezier interpolation function
 * @param x1 First control point X (0-127, normalized to 0-1)
 * @param x2 Second control point X (0-127, normalized to 0-1)
 * @param y1 First control point Y (0-127, normalized to 0-1)
 * @param y2 Second control point Y (0-127, normalized to 0-1)
 * @param t Interpolation parameter (0-1)
 * @returns Interpolated value (0-1)
 */
export function bezierInterpolate(x1: number, x2: number, y1: number, y2: number, t: number): number {
  // Clamp t to [0, 1]
  t = Math.max(0, Math.min(1, t))

  // Binary search for the t value that gives us the desired x
  // We're solving for t in the Bezier curve: x(t) = 3*(1-t)^2*t*x1 + 3*(1-t)*t^2*x2 + t^3
  let start = 0
  let end = 1
  let mid = 0.5

  // Iterate until we find the t value that gives us the desired x
  for (let i = 0; i < 15; i++) {
    // Evaluate Bezier curve at mid point
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

  // Now evaluate the y value at this t
  const y = 3 * (1 - mid) * (1 - mid) * mid * y1 + 3 * (1 - mid) * mid * mid * y2 + mid * mid * mid

  return y
}
