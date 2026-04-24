// Selection overlay — two screen-space passes that together draw a uniform
// pixel-thick outline around the selected material.
//
// Pass 1 (mask): render only the selected material's triangles into an r8
// texture (depth-always). Fragment outputs 1.0. No per-material uniforms;
// reuses camera + skinMats from the outline/main bind group layouts.
//
// Pass 2 (edge): fullscreen pass over the swapchain. For each pixel, sample
// the mask at center + 8 neighbours in a ring of `thickness` pixels. Emit
// yellow where center is empty but any neighbour is filled. Result: uniform
// screen-space thickness, traces the complete material boundary (including
// through-occluder regions), independent of mesh geometry or camera angle.

export const SELECTION_MASK_SHADER_WGSL = /* wgsl */ `
struct CameraUniforms { view: mat4x4f, projection: mat4x4f, viewPos: vec3f, _pad: f32 };
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<storage, read> skinMats: array<mat4x4f>;

@vertex fn vs(
  @location(0) position: vec3f,
  @location(3) joints0: vec4<u32>,
  @location(4) weights0: vec4<f32>
) -> @builtin(position) vec4f {
  let ws = weights0.x + weights0.y + weights0.z + weights0.w;
  let inv = select(1.0, 1.0 / ws, ws > 0.0001);
  let nw = select(vec4f(1.0, 0.0, 0.0, 0.0), weights0 * inv, ws > 0.0001);
  var sp = vec4f(0.0);
  for (var i = 0u; i < 4u; i++) {
    sp += (skinMats[joints0[i]] * vec4f(position, 1.0)) * nw[i];
  }
  return camera.projection * camera.view * vec4f(sp.xyz, 1.0);
}

@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0, 0.0, 0.0, 0.0); }
`

export const SELECTION_EDGE_SHADER_WGSL = /* wgsl */ `
@group(0) @binding(0) var maskTex: texture_2d<f32>;
@group(0) @binding(1) var maskSamp: sampler;
struct Params { thickness: f32, _pad0: f32, _pad1: f32, _pad2: f32 };
@group(0) @binding(2) var<uniform> params: Params;

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32((vi & 1u) << 2u) - 1.0;
  let y = f32((vi & 2u) << 1u) - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(maskTex));
  let uv = fragCoord.xy / dims;
  let center = textureSample(maskTex, maskSamp, uv).r;
  if (center > 0.5) { discard; }
  let t = params.thickness / dims;
  var m: f32 = 0.0;
  m = max(m, textureSample(maskTex, maskSamp, uv + vec2f(-t.x,  0.0)).r);
  m = max(m, textureSample(maskTex, maskSamp, uv + vec2f( t.x,  0.0)).r);
  m = max(m, textureSample(maskTex, maskSamp, uv + vec2f( 0.0, -t.y)).r);
  m = max(m, textureSample(maskTex, maskSamp, uv + vec2f( 0.0,  t.y)).r);
  m = max(m, textureSample(maskTex, maskSamp, uv + vec2f(-t.x, -t.y)).r);
  m = max(m, textureSample(maskTex, maskSamp, uv + vec2f( t.x, -t.y)).r);
  m = max(m, textureSample(maskTex, maskSamp, uv + vec2f(-t.x,  t.y)).r);
  m = max(m, textureSample(maskTex, maskSamp, uv + vec2f( t.x,  t.y)).r);
  if (m < 0.05) { discard; }
  return vec4f(1.0, 1.0, 0.0, m);
}
`
