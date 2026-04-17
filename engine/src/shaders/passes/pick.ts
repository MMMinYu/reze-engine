// GPU picking pass: encodes (modelIndex, materialIndex) as RG8 into a 1×1 readback target.

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

@vertex fn vs(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) joints0: vec4<u32>,
  @location(4) weights0: vec4<f32>
) -> @builtin(position) vec4f {
  let pos4 = vec4f(position, 1.0);
  let weightSum = weights0.x + weights0.y + weights0.z + weights0.w;
  let invWeightSum = select(1.0, 1.0 / weightSum, weightSum > 0.0001);
  let nw = select(vec4f(1.0, 0.0, 0.0, 0.0), weights0 * invWeightSum, weightSum > 0.0001);
  var sp = vec4f(0.0);
  for (var i = 0u; i < 4u; i++) { sp += (skinMats[joints0[i]] * pos4) * nw[i]; }
  return camera.projection * camera.view * vec4f(sp.xyz, 1.0);
}

@fragment fn fs() -> @location(0) vec4f {
  return vec4f(pickId.modelId / 255.0, pickId.materialId / 255.0, 0.0, 1.0);
}
`
