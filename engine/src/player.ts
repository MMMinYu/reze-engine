import { bezierInterpolate } from "./bezier-interpolate"
import { Quat, Vec3 } from "./math"
import { BoneFrame, MorphFrame, VMDKeyFrame, VMDLoader } from "./vmd-loader"

export interface AnimationPose {
  boneRotations: Map<string, Quat>
  boneTranslations: Map<string, Vec3>
  morphWeights: Map<string, number>
}

export interface AnimationProgress {
  current: number
  duration: number
  percentage: number
}

export class Player {
  // Animation data
  private frames: VMDKeyFrame[] = []
  private boneTracks: Map<string, Array<{ boneFrame: BoneFrame; time: number }>> = new Map()
  private morphTracks: Map<string, Array<{ morphFrame: MorphFrame; time: number }>> = new Map()
  private duration: number = 0

  // Playback state
  private isPlaying: boolean = false
  private isPaused: boolean = false
  private currentTime: number = 0

  // Timing
  private startTime: number = 0 // Real-time when playback started
  private pausedTime: number = 0 // Accumulated paused duration
  private pauseStartTime: number = 0

  /**
   * Load VMD animation file
   */
  async loadVmd(vmdUrl: string): Promise<void> {
    // Load animation
    this.frames = await VMDLoader.load(vmdUrl)
    this.processFrames()
  }

  /**
   * Process frames into tracks
   */
  private processFrames(): void {
    // Process bone frames
    const allBoneKeyFrames: Array<{ boneFrame: BoneFrame; time: number }> = []
    for (const keyFrame of this.frames) {
      for (const boneFrame of keyFrame.boneFrames) {
        allBoneKeyFrames.push({
          boneFrame,
          time: keyFrame.time,
        })
      }
    }

    const boneKeyFramesByBone = new Map<string, Array<{ boneFrame: BoneFrame; time: number }>>()
    for (const { boneFrame, time } of allBoneKeyFrames) {
      if (!boneKeyFramesByBone.has(boneFrame.boneName)) {
        boneKeyFramesByBone.set(boneFrame.boneName, [])
      }
      boneKeyFramesByBone.get(boneFrame.boneName)!.push({ boneFrame, time })
    }

    for (const keyFrames of boneKeyFramesByBone.values()) {
      keyFrames.sort((a, b) => a.time - b.time)
    }

    // Process morph frames
    const allMorphKeyFrames: Array<{ morphFrame: MorphFrame; time: number }> = []
    for (const keyFrame of this.frames) {
      for (const morphFrame of keyFrame.morphFrames) {
        allMorphKeyFrames.push({
          morphFrame,
          time: keyFrame.time,
        })
      }
    }

    const morphKeyFramesByMorph = new Map<string, Array<{ morphFrame: MorphFrame; time: number }>>()
    for (const { morphFrame, time } of allMorphKeyFrames) {
      if (!morphKeyFramesByMorph.has(morphFrame.morphName)) {
        morphKeyFramesByMorph.set(morphFrame.morphName, [])
      }
      morphKeyFramesByMorph.get(morphFrame.morphName)!.push({ morphFrame, time })
    }

    for (const keyFrames of morphKeyFramesByMorph.values()) {
      keyFrames.sort((a, b) => a.time - b.time)
    }

    // Store tracks
    this.boneTracks = boneKeyFramesByBone
    this.morphTracks = morphKeyFramesByMorph

    // Calculate animation duration from max frame time
    let maxFrameTime = 0
    for (const keyFrames of this.boneTracks.values()) {
      if (keyFrames.length > 0) {
        const lastTime = keyFrames[keyFrames.length - 1].time
        if (lastTime > maxFrameTime) {
          maxFrameTime = lastTime
        }
      }
    }
    for (const keyFrames of this.morphTracks.values()) {
      if (keyFrames.length > 0) {
        const lastTime = keyFrames[keyFrames.length - 1].time
        if (lastTime > maxFrameTime) {
          maxFrameTime = lastTime
        }
      }
    }
    this.duration = maxFrameTime > 0 ? maxFrameTime : 0
  }

  /**
   * Start or resume playback
   * Note: For iOS, this should be called synchronously from a user interaction event
   */
  play(): void {
    if (this.frames.length === 0) return

    if (this.isPaused) {
      // Resume from paused position - don't adjust time, just continue from where we paused
      this.isPaused = false
      // Adjust start time so current time calculation continues smoothly
      this.startTime = performance.now() - this.currentTime * 1000
    } else {
      // Start from beginning or current seek position
      this.startTime = performance.now() - this.currentTime * 1000
      this.pausedTime = 0
    }

    this.isPlaying = true
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (!this.isPlaying || this.isPaused) return

    this.isPaused = true
    this.pauseStartTime = performance.now()
  }

  /**
   * Stop playback and reset to beginning
   */
  stop(): void {
    this.isPlaying = false
    this.isPaused = false
    this.currentTime = 0
    this.startTime = 0
    this.pausedTime = 0
  }

  /**
   * Seek to specific time
   */
  seek(time: number): void {
    const clampedTime = Math.max(0, Math.min(time, this.duration))
    this.currentTime = clampedTime

    // Adjust start time if playing
    if (this.isPlaying && !this.isPaused) {
      this.startTime = performance.now() - clampedTime * 1000
      this.pausedTime = 0
    }
  }

  /**
   * Update playback and return current pose
   * Returns null if not playing, but returns current pose if paused
   */
  update(currentRealTime: number): AnimationPose | null {
    if (!this.isPlaying || this.frames.length === 0) {
      return null
    }

    // If paused, return current pose at paused time (no time update)
    if (this.isPaused) {
      return this.getPoseAtTime(this.currentTime)
    }

    // Calculate current animation time
    const elapsedSeconds = (currentRealTime - this.startTime) / 1000
    this.currentTime = elapsedSeconds

    // Check if animation ended
    if (this.currentTime >= this.duration) {
      this.currentTime = this.duration
      this.pause() // Auto-pause at end
      return this.getPoseAtTime(this.currentTime)
    }

    return this.getPoseAtTime(this.currentTime)
  }

  /**
   * Get pose at specific time (pure function)
   */
  getPoseAtTime(time: number): AnimationPose {
    const pose: AnimationPose = {
      boneRotations: new Map(),
      boneTranslations: new Map(),
      morphWeights: new Map(),
    }

    // Helper to find upper bound index (binary search)
    const upperBoundFrameIndex = (time: number, keyFrames: Array<{ boneFrame: BoneFrame; time: number }>): number => {
      let left = 0
      let right = keyFrames.length
      while (left < right) {
        const mid = Math.floor((left + right) / 2)
        if (keyFrames[mid].time <= time) {
          left = mid + 1
        } else {
          right = mid
        }
      }
      return left
    }

    // Process each bone track
    for (const [boneName, keyFrames] of this.boneTracks.entries()) {
      if (keyFrames.length === 0) continue

      // Clamp frame time to track range
      const startTime = keyFrames[0].time
      const endTime = keyFrames[keyFrames.length - 1].time
      const clampedFrameTime = Math.max(startTime, Math.min(endTime, time))

      const upperBoundIndex = upperBoundFrameIndex(clampedFrameTime, keyFrames)
      const upperBoundIndexMinusOne = upperBoundIndex - 1

      if (upperBoundIndexMinusOne < 0) continue

      const timeB = keyFrames[upperBoundIndex]?.time
      const boneFrameA = keyFrames[upperBoundIndexMinusOne].boneFrame

      if (timeB === undefined) {
        // Last keyframe or beyond - use the last keyframe value
        pose.boneRotations.set(boneName, boneFrameA.rotation)
        pose.boneTranslations.set(boneName, boneFrameA.translation)
      } else {
        // Interpolate between two keyframes
        const timeA = keyFrames[upperBoundIndexMinusOne].time
        const boneFrameB = keyFrames[upperBoundIndex].boneFrame
        const gradient = (clampedFrameTime - timeA) / (timeB - timeA)

        // Interpolate rotation using Bezier
        const interp = boneFrameB.interpolation
        const rotWeight = bezierInterpolate(
          interp[0] / 127, // x1
          interp[1] / 127, // x2
          interp[2] / 127, // y1
          interp[3] / 127, // y2
          gradient
        )
        const interpolatedRotation = Quat.slerp(boneFrameA.rotation, boneFrameB.rotation, rotWeight)

        // Interpolate translation using Bezier (separate curves for X, Y, Z)
        const xWeight = bezierInterpolate(
          interp[0] / 127, // X_x1
          interp[8] / 127, // X_x2
          interp[4] / 127, // X_y1
          interp[12] / 127, // X_y2
          gradient
        )
        const yWeight = bezierInterpolate(
          interp[16] / 127, // Y_x1
          interp[24] / 127, // Y_x2
          interp[20] / 127, // Y_y1
          interp[28] / 127, // Y_y2
          gradient
        )
        const zWeight = bezierInterpolate(
          interp[32] / 127, // Z_x1
          interp[40] / 127, // Z_x2
          interp[36] / 127, // Z_y1
          interp[44] / 127, // Z_y2
          gradient
        )

        const interpolatedTranslation = new Vec3(
          boneFrameA.translation.x + (boneFrameB.translation.x - boneFrameA.translation.x) * xWeight,
          boneFrameA.translation.y + (boneFrameB.translation.y - boneFrameA.translation.y) * yWeight,
          boneFrameA.translation.z + (boneFrameB.translation.z - boneFrameA.translation.z) * zWeight
        )

        pose.boneRotations.set(boneName, interpolatedRotation)
        pose.boneTranslations.set(boneName, interpolatedTranslation)
      }
    }

    // Helper to find upper bound index for morph frames
    const upperBoundMorphIndex = (time: number, keyFrames: Array<{ morphFrame: MorphFrame; time: number }>): number => {
      let left = 0
      let right = keyFrames.length
      while (left < right) {
        const mid = Math.floor((left + right) / 2)
        if (keyFrames[mid].time <= time) {
          left = mid + 1
        } else {
          right = mid
        }
      }
      return left
    }

    // Process each morph track
    for (const [morphName, keyFrames] of this.morphTracks.entries()) {
      if (keyFrames.length === 0) continue

      // Clamp frame time to track range
      const startTime = keyFrames[0].time
      const endTime = keyFrames[keyFrames.length - 1].time
      const clampedFrameTime = Math.max(startTime, Math.min(endTime, time))

      const upperBoundIndex = upperBoundMorphIndex(clampedFrameTime, keyFrames)
      const upperBoundIndexMinusOne = upperBoundIndex - 1

      if (upperBoundIndexMinusOne < 0) continue

      const timeB = keyFrames[upperBoundIndex]?.time
      const morphFrameA = keyFrames[upperBoundIndexMinusOne].morphFrame

      if (timeB === undefined) {
        // Last keyframe or beyond - use the last keyframe value
        pose.morphWeights.set(morphName, morphFrameA.weight)
      } else {
        // Linear interpolation between two keyframes
        const timeA = keyFrames[upperBoundIndexMinusOne].time
        const morphFrameB = keyFrames[upperBoundIndex].morphFrame
        const gradient = (clampedFrameTime - timeA) / (timeB - timeA)
        const interpolatedWeight = morphFrameA.weight + (morphFrameB.weight - morphFrameA.weight) * gradient

        pose.morphWeights.set(morphName, interpolatedWeight)
      }
    }

    return pose
  }

  /**
   * Get current playback progress
   */
  getProgress(): AnimationProgress {
    return {
      current: this.currentTime,
      duration: this.duration,
      percentage: this.duration > 0 ? (this.currentTime / this.duration) * 100 : 0,
    }
  }

  /**
   * Get current time
   */
  getCurrentTime(): number {
    return this.currentTime
  }

  /**
   * Get animation duration
   */
  getDuration(): number {
    return this.duration
  }

  /**
   * Check if playing
   */
  isPlayingState(): boolean {
    return this.isPlaying && !this.isPaused
  }

  /**
   * Check if paused
   */
  isPausedState(): boolean {
    return this.isPaused
  }
}
