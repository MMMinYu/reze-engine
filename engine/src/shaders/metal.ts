// M_Metal — Metallic Principled (Metallic=1.0, Specular=1.0, Specular Tint=0.114, Roughness=0.3)
// + NPR toon/AO emission stack (Strength=8.1), MixShader Fac=0.6967.
// Base color uses a Voronoi pattern sampled in reflection-coord space (Blender 纹理坐标.Reflection)
// to add subtle metallic sparkle variation. No Normal link in the graph.

import { NODES_WGSL } from "./nodes"

export const METAL_SHADER_WGSL = /* wgsl */ `

${NODES_WGSL}

struct CameraUniforms {
  view: mat4x4f,
  projection: mat4x4f,
  viewPos: vec3f,
  _padding: f32,
};

struct Light {
  direction: vec4f,
  color: vec4f,
};

struct LightUniforms {
  ambientColor: vec4f,
  lights: array<Light, 4>,
};

struct MaterialUniforms {
  diffuseColor: vec3f,
  alpha: f32,
};

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
  @location(2) worldPos: vec3f,
};

struct LightVP { viewProj: mat4x4f, };

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> light: LightUniforms;
@group(0) @binding(2) var diffuseSampler: sampler;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowSampler: sampler_comparison;
@group(0) @binding(5) var<uniform> lightVP: LightVP;
@group(1) @binding(0) var<storage, read> skinMats: array<mat4x4f>;
@group(2) @binding(0) var diffuseTexture: texture_2d<f32>;
@group(2) @binding(1) var<uniform> material: MaterialUniforms;

fn sampleShadow(worldPos: vec3f, n: vec3f) -> f32 {
  // Back-facing to key light: direct contribution is zero anyway, skip 9 texture samples.
  if (dot(n, -light.lights[0].direction.xyz) <= 0.0) { return 0.0; }
  let biasedPos = worldPos + n * 0.08;
  let lclip = lightVP.viewProj * vec4f(biasedPos, 1.0);
  let ndc = lclip.xyz / max(lclip.w, 1e-6);
  let suv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let cmpZ = ndc.z - 0.001;
  let ts = 1.0 / 2048.0;
  // 3x3 PCF unrolled — Safari's Metal backend doesn't unroll nested shadow loops reliably.
  let s00 = textureSampleCompareLevel(shadowMap, shadowSampler, suv + vec2f(-ts, -ts), cmpZ);
  let s10 = textureSampleCompareLevel(shadowMap, shadowSampler, suv + vec2f(0.0, -ts), cmpZ);
  let s20 = textureSampleCompareLevel(shadowMap, shadowSampler, suv + vec2f( ts, -ts), cmpZ);
  let s01 = textureSampleCompareLevel(shadowMap, shadowSampler, suv + vec2f(-ts, 0.0), cmpZ);
  let s11 = textureSampleCompareLevel(shadowMap, shadowSampler, suv, cmpZ);
  let s21 = textureSampleCompareLevel(shadowMap, shadowSampler, suv + vec2f( ts, 0.0), cmpZ);
  let s02 = textureSampleCompareLevel(shadowMap, shadowSampler, suv + vec2f(-ts,  ts), cmpZ);
  let s12 = textureSampleCompareLevel(shadowMap, shadowSampler, suv + vec2f(0.0,  ts), cmpZ);
  let s22 = textureSampleCompareLevel(shadowMap, shadowSampler, suv + vec2f( ts,  ts), cmpZ);
  return (s00 + s10 + s20 + s01 + s11 + s21 + s02 + s12 + s22) * (1.0 / 9.0);
}

const PI_M: f32 = 3.141592653589793;
const METAL_SPECULAR: f32 = 1.0;
const METAL_METALLIC: f32 = 1.0;
const METAL_ROUGHNESS: f32 = 0.3;
const METAL_SPECULAR_TINT: f32 = 0.114;
const METAL_TOON_EDGE: f32 = 0.2966;
const METAL_MIX04_MUL: f32 = 0.5;
const METAL_EMIT_STR: f32 = 8.100000381469727;
const METAL_MIX_SHADER_FAC: f32 = 0.6967;
const METAL_VORONOI_SCALE: f32 = 4.3;

@vertex fn vs(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) uv: vec2f,
  @location(3) joints0: vec4<u32>,
  @location(4) weights0: vec4<f32>
) -> VertexOutput {
  var output: VertexOutput;
  let pos4 = vec4f(position, 1.0);
  let weightSum = weights0.x + weights0.y + weights0.z + weights0.w;
  let invWeightSum = select(1.0, 1.0 / weightSum, weightSum > 0.0001);
  let nw = select(vec4f(1.0, 0.0, 0.0, 0.0), weights0 * invWeightSum, weightSum > 0.0001);
  var skinnedPos = vec4f(0.0);
  var skinnedNrm = vec3f(0.0);
  for (var i = 0u; i < 4u; i++) {
    let m = skinMats[joints0[i]];
    let w = nw[i];
    skinnedPos += (m * pos4) * w;
    skinnedNrm += (mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz) * normal) * w;
  }
  output.position = camera.projection * camera.view * vec4f(skinnedPos.xyz, 1.0);
  // Skip VS normalize — interpolation denormalizes anyway, and FS always does normalize(input.normal).
  output.normal = skinnedNrm;
  output.uv = uv;
  output.worldPos = skinnedPos.xyz;
  return output;
}

struct FSOut {
  @location(0) color: vec4f,
  @location(1) mask: f32,
};

@fragment fn fs(input: VertexOutput) -> FSOut {
  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;
  let sun = light.lights[0].color.xyz * light.lights[0].color.w;
  let amb = light.ambientColor.xyz;
  let shadow = sampleShadow(input.worldPos, n);

  let tex_s = textureSample(diffuseTexture, diffuseSampler, input.uv);
  let tex_rgb = tex_s.rgb;
  let out_alpha = material.alpha * tex_s.a;
  if (out_alpha < 0.001) { discard; }

  // ═══ NPR toon stack (图像 → HSV.007 Val=0.8 → 转接点.001) ═══
  let tex_tint = hue_sat_id(1.0, 0.800000011920929, 1.0, tex_rgb);
  let lum_shade = shader_to_rgb_diffuse(n, l, sun, amb, shadow);
  let ramp008 = ramp_constant_edge_aa(lum_shade, METAL_TOON_EDGE, vec4f(0,0,0,1), vec4f(1,1,1,1));
  let mix04_fac = math_multiply(ramp008.r, METAL_MIX04_MUL);

  // 混合.004: A=HSV.002(Val=0.2 dark), B=tex_tint
  let dark_tex = hue_sat_id(1.0, 0.19999998807907104, 1.0, tex_tint);
  let mix04 = mix_blend(mix04_fac, dark_tex, tex_tint);

  // AO white/black ramp → 混合.002 factor
  let ao = 1.0; // ao_fake(n, v) — no SSAO yet; inline 1.0 so the ramp/mix chain folds at compile time.
  let ao_ramp_c = ramp_linear(ao, 0.0, vec4f(1,1,1,1), 0.8808, vec4f(0,0,0,1));
  let overlay_fac = mix(1.0, 0.0, ao_ramp_c.r);

  // 混合.002 OVERLAY: A=HSV.008(Val=1.0 identity) ← mix04, B=HSV.004(Val=2.0 bright) ← mix04
  let hue008 = mix04; // identity HSV
  let hue004 = hue_sat_id(1.0, 2.0, 1.0, mix04);
  let npr_rgb = mix_overlay(overlay_fac, hue008, hue004);
  let npr_emission = npr_rgb * METAL_EMIT_STR;

  // ═══ Metallic Principled base color ═══
  // Reflection-coord Voronoi for metallic sparkle:
  //   纹理坐标.Reflection → 矢量运算 → 沃罗诺伊(Scale=4.3) → 颜色渐变 → 混合.005
  let refl_dir = reflect(-v, n);
  let voro = tex_voronoi_f1(refl_dir, METAL_VORONOI_SCALE);
  let voro_ramp = ramp_linear(voro, 0.0, vec4f(0,0,0,1), 1.0, vec4f(1,1,1,1)).r;
  // 混合.005: Fac=voro_ramp, A=voro_color(grayscale), B=HSV.006(Hue=0.5 Sat=1.5 Val=1.3)
  let hue006 = hue_sat_id(1.5, 1.2999999523162842, 1.0, tex_tint);
  let albedo = mix_blend(voro_ramp, vec3f(voro_ramp), hue006);

  // 原理化BSDF (EEVEE port): metallic=1.0, specular=1.0, roughness=0.3.
  // Per Blender principled wiring: f0 = mix((0.08*spec)*dielectric, albedo, metallic) → with
  // metallic=1 this is just albedo (specular_tint is dielectric-only and ignored here).
  let f0 = albedo;
  let f90 = mix(f0, vec3f(1.0), sqrt(METAL_SPECULAR));
  let NL = max(dot(n, l), 0.0);
  let NV = max(dot(n, v), 1e-4);
  let brdf_lut = brdf_lut_sample(NV, METAL_ROUGHNESS);
  let reflection_color = F_brdf_multi_scatter(f0, f90, brdf_lut.xy);

  let spec_direct = bsdf_ggx(n, l, v, NL, NV, METAL_ROUGHNESS) * sun * shadow * ltc_brdf_scale_from_lut(brdf_lut);
  let spec_indirect = amb;
  let spec_radiance = (spec_direct + spec_indirect) * reflection_color;

  // Pure metal — no diffuse lobe (diffuse_weight = (1 - metallic) = 0).
  let principled = spec_radiance;

  // 混合着色器.001 Fac=0.6967: Shader=npr_emission, Shader_001=principled
  let final_color = mix(npr_emission, principled, METAL_MIX_SHADER_FAC);

  var out: FSOut;
  out.color = vec4f(final_color, out_alpha);
  out.mask = 1.0;
  return out;
}

`
