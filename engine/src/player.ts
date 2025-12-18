import { Quat, Vec3, bezierInterpolate } from "./math"
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
  private _duration: number = 0

  // Playback state
  private isPlaying: boolean = false
  private isPaused: boolean = false
  private _currentTime: number = 0

  // Timing
  private startTime: number = 0 // Real-time when playback started

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

    for (const keyFrame of this.frames) {
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

    // Calculate duration from all tracks
    const allTracks = [...this.boneTracks.values(), ...this.morphTracks.values()]
    this._duration = allTracks.reduce((max, keyFrames) => {
      const lastTime = keyFrames[keyFrames.length - 1]?.time ?? 0
      return Math.max(max, lastTime)
    }, 0)
  }

  /**
   * Start or resume playback
   * Note: For iOS, this should be called synchronously from a user interaction event
   */
  play(): void {
    if (this.frames.length === 0) return

    this.isPaused = false
    this.startTime = performance.now() - this._currentTime * 1000

    this.isPlaying = true
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (!this.isPlaying || this.isPaused) return
    this.isPaused = true
  }

  /**
   * Stop playback and reset to beginning
   */
  stop(): void {
    this.isPlaying = false
    this.isPaused = false
    this._currentTime = 0
    this.startTime = 0
  }

  /**
   * Seek to specific time
   */
  seek(time: number): void {
    const clampedTime = Math.max(0, Math.min(time, this._duration))
    this._currentTime = clampedTime

    if (this.isPlaying && !this.isPaused) {
      this.startTime = performance.now() - clampedTime * 1000
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
      return this.getPoseAtTime(this._currentTime)
    }

    // Calculate current animation time
    const elapsedSeconds = (currentRealTime - this.startTime) / 1000
    this._currentTime = elapsedSeconds

    // Check if animation ended
    if (this._currentTime >= this._duration) {
      this._currentTime = this._duration
      this.pause() // Auto-pause at end
      return this.getPoseAtTime(this._currentTime)
    }

    return this.getPoseAtTime(this._currentTime)
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

    // Generic binary search for upper bound
    const upperBound = <T extends { time: number }>(time: number, keyFrames: T[]): number => {
      let left = 0,
        right = keyFrames.length
      while (left < right) {
        const mid = Math.floor((left + right) / 2)
        if (keyFrames[mid].time <= time) left = mid + 1
        else right = mid
      }
      return left
    }

    // Process bone tracks
    for (const [boneName, keyFrames] of this.boneTracks.entries()) {
      if (keyFrames.length === 0) continue

      const clampedTime = Math.max(keyFrames[0].time, Math.min(keyFrames[keyFrames.length - 1].time, time))
      const idx = upperBound(clampedTime, keyFrames) - 1
      if (idx < 0) continue

      const frameA = keyFrames[idx].boneFrame
      const frameB = keyFrames[idx + 1]?.boneFrame

      if (!frameB) {
        pose.boneRotations.set(boneName, frameA.rotation)
        pose.boneTranslations.set(boneName, frameA.translation)
      } else {
        const timeA = keyFrames[idx].time
        const timeB = keyFrames[idx + 1].time
        const gradient = (clampedTime - timeA) / (timeB - timeA)
        const interp = frameB.interpolation

        pose.boneRotations.set(
          boneName,
          Quat.slerp(
            frameA.rotation,
            frameB.rotation,
            bezierInterpolate(interp[0] / 127, interp[1] / 127, interp[2] / 127, interp[3] / 127, gradient)
          )
        )

        const lerp = (a: number, b: number, w: number) => a + (b - a) * w
        const getWeight = (offset: number) =>
          bezierInterpolate(
            interp[offset] / 127,
            interp[offset + 8] / 127,
            interp[offset + 4] / 127,
            interp[offset + 12] / 127,
            gradient
          )

        pose.boneTranslations.set(
          boneName,
          new Vec3(
            lerp(frameA.translation.x, frameB.translation.x, getWeight(0)),
            lerp(frameA.translation.y, frameB.translation.y, getWeight(16)),
            lerp(frameA.translation.z, frameB.translation.z, getWeight(32))
          )
        )
      }
    }

    // Process morph tracks
    for (const [morphName, keyFrames] of this.morphTracks.entries()) {
      if (keyFrames.length === 0) continue

      const clampedTime = Math.max(keyFrames[0].time, Math.min(keyFrames[keyFrames.length - 1].time, time))
      const idx = upperBound(clampedTime, keyFrames) - 1
      if (idx < 0) continue

      const frameA = keyFrames[idx].morphFrame
      const frameB = keyFrames[idx + 1]?.morphFrame

      if (!frameB) {
        pose.morphWeights.set(morphName, frameA.weight)
      } else {
        const timeA = keyFrames[idx].time
        const timeB = keyFrames[idx + 1].time
        const gradient = (clampedTime - timeA) / (timeB - timeA)
        pose.morphWeights.set(morphName, frameA.weight + (frameB.weight - frameA.weight) * gradient)
      }
    }

    return pose
  }

  /**
   * Get current playback progress
   */
  getProgress(): AnimationProgress {
    return {
      current: this._currentTime,
      duration: this._duration,
      percentage: this._duration > 0 ? (this._currentTime / this._duration) * 100 : 0,
    }
  }

  get currentTime(): number {
    return this._currentTime
  }

  get duration(): number {
    return this._duration
  }

  get isPlayingState(): boolean {
    return this.isPlaying && !this.isPaused
  }

  get isPausedState(): boolean {
    return this.isPaused
  }
}
