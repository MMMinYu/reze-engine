import { AnimationClip, BoneInterpolation } from "./animation"

const VMD_HEADER = "Vocaloid Motion Data 0002"
const HEADER_SIZE = 30
const MODEL_NAME_SIZE = 20
const BONE_NAME_SIZE = 15
const MORPH_NAME_SIZE = 15
const BONE_FRAME_SIZE = BONE_NAME_SIZE + 4 + 12 + 16 + 64 // 111 bytes
const MORPH_FRAME_SIZE = MORPH_NAME_SIZE + 4 + 4 // 23 bytes

// Build a Unicode-to-Shift-JIS lookup by inverting the TextDecoder mapping.
let shiftJISTable: Map<string, number[]> | null = null

function getShiftJISTable(): Map<string, number[]> {
  if (shiftJISTable) return shiftJISTable
  const decoder = new TextDecoder("shift-jis")
  const map = new Map<string, number[]>()
  // Single-byte range
  for (let i = 0; i < 256; i++) {
    const char = decoder.decode(new Uint8Array([i]))
    if (char !== "\ufffd") map.set(char, [i])
  }
  // Two-byte range (JIS X 0208)
  for (let hi = 0x81; hi <= 0xfc; hi++) {
    if (hi >= 0xa0 && hi <= 0xdf) continue
    for (let lo = 0x40; lo <= 0xfc; lo++) {
      if (lo === 0x7f) continue
      const char = decoder.decode(new Uint8Array([hi, lo]))
      if (char !== "\ufffd" && !map.has(char)) {
        map.set(char, [hi, lo])
      }
    }
  }
  shiftJISTable = map
  return map
}

function encodeShiftJIS(str: string): Uint8Array {
  const table = getShiftJISTable()
  const bytes: number[] = []
  for (const char of str) {
    const b = table.get(char)
    if (b) bytes.push(...b)
  }
  return new Uint8Array(bytes)
}

export class VMDWriter {
  write(clip: AnimationClip): ArrayBuffer {
    let totalBoneFrames = 0
    for (const frames of clip.boneTracks.values()) {
      totalBoneFrames += frames.length
    }
    let totalMorphFrames = 0
    for (const frames of clip.morphTracks.values()) {
      totalMorphFrames += frames.length
    }

    const size =
      HEADER_SIZE +
      MODEL_NAME_SIZE +
      4 + totalBoneFrames * BONE_FRAME_SIZE +
      4 + totalMorphFrames * MORPH_FRAME_SIZE

    const buffer = new ArrayBuffer(size)
    const view = new DataView(buffer)
    let offset = 0

    // Header (30 bytes, ASCII)
    offset = writeFixedString(buffer, offset, VMD_HEADER, HEADER_SIZE)

    // Model name (20 bytes, zeroed)
    offset += MODEL_NAME_SIZE

    // Bone frame count
    view.setUint32(offset, totalBoneFrames, true)
    offset += 4

    // Bone frames
    for (const frames of clip.boneTracks.values()) {
      for (const kf of frames) {
        // Bone name (15 bytes, Shift-JIS)
        offset = writeFixedShiftJIS(buffer, offset, kf.boneName, BONE_NAME_SIZE)

        // Frame number (u32 LE)
        view.setUint32(offset, kf.frame, true)
        offset += 4

        // Translation (3 x f32 LE)
        view.setFloat32(offset, kf.translation.x, true); offset += 4
        view.setFloat32(offset, kf.translation.y, true); offset += 4
        view.setFloat32(offset, kf.translation.z, true); offset += 4

        // Rotation quaternion (4 x f32 LE)
        view.setFloat32(offset, kf.rotation.x, true); offset += 4
        view.setFloat32(offset, kf.rotation.y, true); offset += 4
        view.setFloat32(offset, kf.rotation.z, true); offset += 4
        view.setFloat32(offset, kf.rotation.w, true); offset += 4

        // Interpolation (64 bytes)
        const raw = boneInterpolationToRaw(kf.interpolation)
        new Uint8Array(buffer, offset, 64).set(raw)
        offset += 64
      }
    }

    // Morph frame count
    view.setUint32(offset, totalMorphFrames, true)
    offset += 4

    // Morph frames
    for (const frames of clip.morphTracks.values()) {
      for (const kf of frames) {
        // Morph name (15 bytes, Shift-JIS)
        offset = writeFixedShiftJIS(buffer, offset, kf.morphName, MORPH_NAME_SIZE)

        // Frame number (u32 LE)
        view.setUint32(offset, kf.frame, true)
        offset += 4

        // Weight (f32 LE)
        view.setFloat32(offset, kf.weight, true)
        offset += 4
      }
    }

    return buffer
  }
}

function writeFixedString(buffer: ArrayBuffer, offset: number, str: string, maxBytes: number): number {
  const bytes = new Uint8Array(buffer, offset, maxBytes)
  bytes.fill(0)
  for (let i = 0; i < str.length && i < maxBytes; i++) {
    bytes[i] = str.charCodeAt(i) & 0xff
  }
  return offset + maxBytes
}

function writeFixedShiftJIS(buffer: ArrayBuffer, offset: number, str: string, maxBytes: number): number {
  const target = new Uint8Array(buffer, offset, maxBytes)
  target.fill(0)
  const encoded = encodeShiftJIS(str)
  target.set(encoded.subarray(0, maxBytes))
  return offset + maxBytes
}

/**
 * Convert BoneInterpolation back to the 64-byte raw VMD interpolation table.
 * Exact inverse of rawInterpolationToBoneInterpolation in animation.ts.
 */
function boneInterpolationToRaw(interp: BoneInterpolation): Uint8Array {
  const raw = new Uint8Array(64)

  // Rotation: [{x: raw[0], y: raw[2]}, {x: raw[1], y: raw[3]}]
  raw[0] = interp.rotation[0].x
  raw[1] = interp.rotation[1].x
  raw[2] = interp.rotation[0].y
  raw[3] = interp.rotation[1].y

  // TranslationX: [{x: raw[0], y: raw[4]}, {x: raw[8], y: raw[12]}]
  // raw[0] already set by rotation (shared byte)
  raw[4] = interp.translationX[0].y
  raw[8] = interp.translationX[1].x
  raw[12] = interp.translationX[1].y

  // TranslationY: [{x: raw[16], y: raw[20]}, {x: raw[24], y: raw[28]}]
  raw[16] = interp.translationY[0].x
  raw[20] = interp.translationY[0].y
  raw[24] = interp.translationY[1].x
  raw[28] = interp.translationY[1].y

  // TranslationZ: [{x: raw[32], y: raw[36]}, {x: raw[40], y: raw[44]}]
  raw[32] = interp.translationZ[0].x
  raw[36] = interp.translationZ[0].y
  raw[40] = interp.translationZ[1].x
  raw[44] = interp.translationZ[1].y

  return raw
}
