// GPU picking pass: encodes (modelIndex, materialIndex, dominantBoneIndex) as RGB8
// into a 1×1 readback target. Dominant bone = the joint with the largest skinning
// weight for the provoking vertex of the triangle (flat-interpolated to fragments).
// 8-bit bone range (0..255) covers standard MMD skeletons (~100–200 bones).

export const PICK_SHADER_WGSL = /* wgsl */ `
struct CameraUniforms {
  view: mat4x4f,
  projection: mat4x4f,
  viewPos: vec3f,
  _padding: f32,
};
struct PickId {
  modelId: f32,
  materialId: f32,
  _p1: f32,
  _p2: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<storage, read> skinMats: array<mat4x4f>;
@group(2) @binding(0) var<uniform> pickId: PickId;

struct VSOut {
  @builtin(position) pos: vec4f,
  @interpolate(flat) @location(0) boneId: u32,
}

@vertex fn vs(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) joints0: vec4<u32>,
  @location(4) weights0: vec4<f32>
) -> VSOut {
  let pos4 = vec4f(position, 1.0);
  let weightSum = weights0.x + weights0.y + weights0.z + weights0.w;
  let invWeightSum = select(1.0, 1.0 / weightSum, weightSum > 0.0001);
  let nw = select(vec4f(1.0, 0.0, 0.0, 0.0), weights0 * invWeightSum, weightSum > 0.0001);
  var sp = vec4f(0.0);
  for (var i = 0u; i < 4u; i++) { sp += (skinMats[joints0[i]] * pos4) * nw[i]; }

  // Dominant joint for this vertex — index of max weight component.
  var maxW: f32 = nw.x;
  var idx: u32 = joints0.x;
  if (nw.y > maxW) { maxW = nw.y; idx = joints0.y; }
  if (nw.z > maxW) { maxW = nw.z; idx = joints0.z; }
  if (nw.w > maxW) { maxW = nw.w; idx = joints0.w; }

  var out: VSOut;
  out.pos = camera.projection * camera.view * vec4f(sp.xyz, 1.0);
  out.boneId = idx;
  return out;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  return vec4f(
    pickId.modelId / 255.0,
    pickId.materialId / 255.0,
    f32(in.boneId) / 255.0,
    1.0
  );
}
`
