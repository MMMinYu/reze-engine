import { Quat, Vec3 } from "./math"

export interface BoneFrame {
  boneName: string
  frame: number
  rotation: Quat
  translation: Vec3
  interpolation: Uint8Array // 64 bytes of interpolation parameters
}

export interface MorphFrame {
  morphName: string
  frame: number
  weight: number // 0.0 to 1.0
}

export interface VMDKeyFrame {
  time: number // in seconds
  boneFrames: BoneFrame[]
  morphFrames: MorphFrame[]
}

export class VMDLoader {
  private view: DataView
  private offset = 0
  private decoder: TextDecoder

  private constructor(buffer: ArrayBuffer) {
    this.view = new DataView(buffer)
    // Try to use Shift-JIS decoder, fallback to UTF-8 if not available
    try {
      this.decoder = new TextDecoder("shift-jis")
    } catch {
      // Fallback to UTF-8 if Shift-JIS is not supported
      this.decoder = new TextDecoder("utf-8")
    }
  }

  static async load(url: string): Promise<VMDKeyFrame[]> {
    const loader = new VMDLoader(await fetch(url).then((r) => r.arrayBuffer()))
    return loader.parse()
  }

  static loadFromBuffer(buffer: ArrayBuffer): VMDKeyFrame[] {
    const loader = new VMDLoader(buffer)
    return loader.parse()
  }

  private parse(): VMDKeyFrame[] {
    // Read header (30 bytes)
    const header = this.getString(30)
    if (!header.startsWith("Vocaloid Motion Data")) {
      throw new Error("Invalid VMD file header")
    }

    // Skip model name (20 bytes)
    this.skip(20)

    // Read bone frame count (4 bytes, u32 little endian)
    const boneFrameCount = this.getUint32()

    // Read all bone frames
    const allBoneFrames: Array<{ time: number; boneFrame: BoneFrame }> = []

    for (let i = 0; i < boneFrameCount; i++) {
      const boneFrame = this.readBoneFrame()

      // Convert frame number to time (30 FPS)
      const FRAME_RATE = 30.0
      const time = boneFrame.frame / FRAME_RATE

      allBoneFrames.push({ time, boneFrame })
    }

    // Read morph frame count (4 bytes, u32 little endian)
    const morphFrameCount = this.getUint32()

    // Read all morph frames
    const allMorphFrames: Array<{ time: number; morphFrame: MorphFrame }> = []

    for (let i = 0; i < morphFrameCount; i++) {
      const morphFrame = this.readMorphFrame()

      // Convert frame number to time (30 FPS)
      const FRAME_RATE = 30.0
      const time = morphFrame.frame / FRAME_RATE

      allMorphFrames.push({ time, morphFrame })
    }

    // Combine all frames and group by time
    const allFrames: Array<{ time: number; boneFrame?: BoneFrame; morphFrame?: MorphFrame }> = []
    for (const { time, boneFrame } of allBoneFrames) {
      allFrames.push({ time, boneFrame })
    }
    for (const { time, morphFrame } of allMorphFrames) {
      allFrames.push({ time, morphFrame })
    }

    // Sort by time
    allFrames.sort((a, b) => a.time - b.time)

    // Group by time and convert to VMDKeyFrame format
    const keyFrames: VMDKeyFrame[] = []
    let currentTime = -1.0
    let currentBoneFrames: BoneFrame[] = []
    let currentMorphFrames: MorphFrame[] = []

    for (const frame of allFrames) {
      if (Math.abs(frame.time - currentTime) > 0.001) {
        // New time frame
        if (currentBoneFrames.length > 0 || currentMorphFrames.length > 0) {
          keyFrames.push({
            time: currentTime,
            boneFrames: currentBoneFrames,
            morphFrames: currentMorphFrames,
          })
        }
        currentTime = frame.time
        currentBoneFrames = frame.boneFrame ? [frame.boneFrame] : []
        currentMorphFrames = frame.morphFrame ? [frame.morphFrame] : []
      } else {
        // Same time frame
        if (frame.boneFrame) {
          currentBoneFrames.push(frame.boneFrame)
        }
        if (frame.morphFrame) {
          currentMorphFrames.push(frame.morphFrame)
        }
      }
    }

    // Add the last frame
    if (currentBoneFrames.length > 0 || currentMorphFrames.length > 0) {
      keyFrames.push({
        time: currentTime,
        boneFrames: currentBoneFrames,
        morphFrames: currentMorphFrames,
      })
    }

    return keyFrames
  }

  private readBoneFrame(): BoneFrame {
    // Read bone name (15 bytes)
    const nameBuffer = new Uint8Array(this.view.buffer, this.offset, 15)
    this.offset += 15

    // Find the actual length of the bone name (stop at first null byte)
    let nameLength = 15
    for (let i = 0; i < 15; i++) {
      if (nameBuffer[i] === 0) {
        nameLength = i
        break
      }
    }

    // Decode Shift-JIS bone name
    let boneName: string
    try {
      const nameSlice = nameBuffer.slice(0, nameLength)
      boneName = this.decoder.decode(nameSlice)
    } catch {
      // Fallback to lossy decoding if there were encoding errors
      boneName = String.fromCharCode(...nameBuffer.slice(0, nameLength))
    }

    // Read frame number (4 bytes, little endian)
    const frame = this.getUint32()

    // Read position/translation (12 bytes: 3 x f32, little endian)
    const posX = this.getFloat32()
    const posY = this.getFloat32()
    const posZ = this.getFloat32()
    const translation = new Vec3(posX, posY, posZ)

    // Read rotation quaternion (16 bytes: 4 x f32, little endian)
    const rotX = this.getFloat32()
    const rotY = this.getFloat32()
    const rotZ = this.getFloat32()
    const rotW = this.getFloat32()
    const rotation = new Quat(rotX, rotY, rotZ, rotW)

    // Read interpolation parameters (64 bytes)
    const interpolation = new Uint8Array(64)
    for (let i = 0; i < 64; i++) {
      interpolation[i] = this.getUint8()
    }

    return {
      boneName,
      frame,
      rotation,
      translation,
      interpolation,
    }
  }

  private readMorphFrame(): MorphFrame {
    // Read morph name (15 bytes)
    const nameBuffer = new Uint8Array(this.view.buffer, this.offset, 15)
    this.offset += 15

    // Find the actual length of the morph name (stop at first null byte)
    let nameLength = 15
    for (let i = 0; i < 15; i++) {
      if (nameBuffer[i] === 0) {
        nameLength = i
        break
      }
    }

    // Decode Shift-JIS morph name
    let morphName: string
    try {
      const nameSlice = nameBuffer.slice(0, nameLength)
      morphName = this.decoder.decode(nameSlice)
    } catch {
      // Fallback to lossy decoding if there were encoding errors
      morphName = String.fromCharCode(...nameBuffer.slice(0, nameLength))
    }

    // Read frame number (4 bytes, little endian)
    const frame = this.getUint32()

    // Read weight (4 bytes, f32, little endian)
    const weight = this.getFloat32()

    return {
      morphName,
      frame,
      weight,
    }
  }

  private getUint8(): number {
    if (this.offset + 1 > this.view.buffer.byteLength) {
      throw new RangeError(`Offset ${this.offset} + 1 exceeds buffer bounds ${this.view.buffer.byteLength}`)
    }
    const v = this.view.getUint8(this.offset)
    this.offset += 1
    return v
  }

  private getUint32(): number {
    if (this.offset + 4 > this.view.buffer.byteLength) {
      throw new RangeError(`Offset ${this.offset} + 4 exceeds buffer bounds ${this.view.buffer.byteLength}`)
    }
    const v = this.view.getUint32(this.offset, true) // true = little endian
    this.offset += 4
    return v
  }

  private getFloat32(): number {
    if (this.offset + 4 > this.view.buffer.byteLength) {
      throw new RangeError(`Offset ${this.offset} + 4 exceeds buffer bounds ${this.view.buffer.byteLength}`)
    }
    const v = this.view.getFloat32(this.offset, true) // true = little endian
    this.offset += 4
    return v
  }

  private getString(len: number): string {
    const bytes = new Uint8Array(this.view.buffer, this.offset, len)
    this.offset += len
    return String.fromCharCode(...bytes)
  }

  private skip(bytes: number): void {
    if (this.offset + bytes > this.view.buffer.byteLength) {
      throw new RangeError(`Offset ${this.offset} + ${bytes} exceeds buffer bounds ${this.view.buffer.byteLength}`)
    }
    this.offset += bytes
  }
}
