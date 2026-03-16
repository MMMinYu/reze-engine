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

// Keyframe types for animation clips (used by Model and AnimationState)
export interface BoneKeyframe {
  boneName: string
  frame: number
  rotation: Quat
  translation: Vec3
  interpolation: BoneInterpolation
  time: number
}

export interface MorphKeyframe {
  morphName: string
  frame: number
  weight: number
  time: number
}

/** Immutable clip data for one animation (e.g. one VMD). */
export interface AnimationClip {
  boneTracks: Map<string, BoneKeyframe[]>
  morphTracks: Map<string, MorphKeyframe[]>
  duration: number
  /** When true, clip loops at end. When false, playback stops and onEnd fires. Default false. */
  loop?: boolean
}

/**
 * Per-model animation state: multiple animations, non-interruptible playback.
 * While one is playing, play(name) queues it to start when the current one finishes.
 */
export class AnimationState {
  private animations = new Map<string, AnimationClip>()
  private currentAnimationName: string | null = null
  private currentTime = 0
  private isPlaying = false
  private isPaused = false
  /** When current (non-loop) ends, play this next. Cleared when started. */
  private nextAnimationName: string | null = null
  private onEnd: ((animationName: string) => void) | null = null

  /** Add or replace an animation by name. Does not start playback. */
  loadAnimation(name: string, clip: AnimationClip): void {
    this.animations.set(name, clip)
  }

  /** Remove an animation. If it was current, state is cleared. */
  removeAnimation(name: string): void {
    this.animations.delete(name)
    if (this.currentAnimationName === name) {
      this.currentAnimationName = null
      this.currentTime = 0
      this.isPlaying = false
      this.nextAnimationName = this.nextAnimationName === name ? null : this.nextAnimationName
    } else if (this.nextAnimationName === name) {
      this.nextAnimationName = null
    }
  }

  /**
   * Start playing an animation by name. Non-interruptible: if one is already playing,
   * this animation is queued to start when the current one finishes.
   */
  play(name: string): boolean
  /** Resume current animation (no-op if none). */
  play(): void
  play(name?: string): boolean | void {
    if (name === undefined) {
      if (this.currentAnimationName && this.animations.has(this.currentAnimationName)) {
        this.isPaused = false
        this.isPlaying = true
      }
      return
    }
    if (!this.animations.has(name)) return false
    if (this.isPlaying && !this.isPaused) {
      this.nextAnimationName = name
      return true
    }
    this.currentAnimationName = name
    this.currentTime = 0
    this.isPlaying = true
    this.isPaused = false
    this.nextAnimationName = null
    return true
  }

  /** Advance time. When a non-loop clip ends, starts nextAnimationName if set. */
  update(deltaTime: number): { ended: boolean; animationName: string | null } {
    if (!this.isPlaying || this.isPaused || this.currentAnimationName === null) {
      return { ended: false, animationName: this.currentAnimationName }
    }
    const clip = this.animations.get(this.currentAnimationName)
    if (!clip) return { ended: false, animationName: this.currentAnimationName }

    this.currentTime += deltaTime
    const duration = clip.duration

    if (this.currentTime >= duration) {
      this.currentTime = duration
      if (clip.loop) {
        this.currentTime = 0
        return { ended: false, animationName: this.currentAnimationName }
      }
      const finishedName = this.currentAnimationName
      this.onEnd?.(finishedName)
      if (this.nextAnimationName !== null) {
        const next = this.nextAnimationName
        this.nextAnimationName = null
        this.currentAnimationName = next
        this.currentTime = 0
        this.isPlaying = true
        this.isPaused = false
        return { ended: true, animationName: finishedName }
      }
      this.isPlaying = false
      return { ended: true, animationName: finishedName }
    }
    return { ended: false, animationName: this.currentAnimationName }
  }

  pause(): void {
    this.isPaused = true
  }

  stop(): void {
    this.isPlaying = false
    this.isPaused = false
    this.currentTime = 0
    this.nextAnimationName = null
  }

  seek(time: number): void {
    const clip = this.getCurrentClip()
    if (!clip) return
    this.currentTime = Math.max(0, Math.min(time, clip.duration))
  }

  getCurrentClip(): AnimationClip | null {
    return this.currentAnimationName !== null ? this.animations.get(this.currentAnimationName) ?? null : null
  }

  getCurrentAnimation(): string | null {
    return this.currentAnimationName
  }

  getCurrentTime(): number {
    return this.currentTime
  }

  getDuration(): number {
    const clip = this.getCurrentClip()
    return clip ? clip.duration : 0
  }

  /** Progress of the current animation (time, duration, percentage). */
  getProgress(): { animationName: string | null; current: number; duration: number; percentage: number } {
    const clip = this.getCurrentClip()
    const duration = clip ? clip.duration : 0
    const percentage = duration > 0 ? (this.currentTime / duration) * 100 : 0
    return {
      animationName: this.currentAnimationName,
      current: this.currentTime,
      duration,
      percentage,
    }
  }

  getAnimationNames(): string[] {
    return Array.from(this.animations.keys())
  }

  hasAnimation(name: string): boolean {
    return this.animations.has(name)
  }

  /** Show animation at time 0 without playing. Use after load when you want to play later (e.g. dance visualization). */
  show(name: string): void {
    if (!this.animations.has(name)) return
    this.currentAnimationName = name
    this.currentTime = 0
    this.isPlaying = false
    this.isPaused = false
    this.nextAnimationName = null
  }

  setOnEnd(callback: ((animationName: string) => void) | null): void {
    this.onEnd = callback
  }

  getPlaying(): boolean {
    return this.isPlaying
  }

  getPaused(): boolean {
    return this.isPaused
  }
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
