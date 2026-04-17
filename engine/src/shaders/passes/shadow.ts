// Shadow map depth-only pass. Skinned VS, no FS (depth-only attachment).

export const SHADOW_DEPTH_SHADER_WGSL = /* wgsl */ `
struct LightVP { viewProj: mat4x4f, };
@group(0) @binding(0) var<uniform> lp: LightVP;
@group(0) @binding(1) var<storage, read> skinMats: array<mat4x4f>;
@vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f,
  @location(3) joints0: vec4<u32>, @location(4) weights0: vec4<f32>) -> @builtin(position) vec4f {
  let pos4 = vec4f(position, 1.0);
  let ws = weights0.x + weights0.y + weights0.z + weights0.w;
  let inv = select(1.0, 1.0 / ws, ws > 0.0001);
  let nw = select(vec4f(1.0,0.0,0.0,0.0), weights0 * inv, ws > 0.0001);
  var sp = vec4f(0.0);
  for (var i = 0u; i < 4u; i++) { sp += (skinMats[joints0[i]] * pos4) * nw[i]; }
  return lp.viewProj * vec4f(sp.xyz, 1.0);
}
`
