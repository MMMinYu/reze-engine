// M_Rough_Cloth — NPR graph identical to M_Smooth_Cloth but bump chain IS live
// (噪波→渐变→凹凸.Normal → 原理化BSDF.Normal in m_graphs) and Roughness=0.8187.

import { NODES_WGSL } from "./nodes"

export const CLOTH_ROUGH_SHADER_WGSL = /* wgsl */ `

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
  let biasedPos = worldPos + n * 0.08;
  let lclip = lightVP.viewProj * vec4f(biasedPos, 1.0);
  let ndc = lclip.xyz / max(lclip.w, 1e-6);
  let suv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
  let cmpZ = ndc.z - 0.001;
  let ts = 1.0 / 4096.0;
  var vis = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      vis += textureSampleCompare(shadowMap, shadowSampler, suv + vec2f(f32(x), f32(y)) * ts, cmpZ);
    }
  }
  return vis / 9.0;
}

const PI_CR: f32 = 3.141592653589793;
const CLOTH_R_SPECULAR: f32 = 0.8;
const CLOTH_R_ROUGHNESS: f32 = 0.8187;
const CLOTH_R_TOON_EDGE: f32 = 0.2966;
const CLOTH_R_MIX04_MUL: f32 = 0.5;
const CLOTH_R_EMIT_STR: f32 = 18.200000762939453;
const CLOTH_R_MIX_SHADER_FAC: f32 = 0.8999999761581421;
const CLOTH_R_NOISE_SCALE: f32 = 17.7;
const CLOTH_R_BUMP_STR: f32 = 1.0;
// EEVEE Light Clamp equivalent — caps firefly specular from noise-bumped NDF aliasing.
const CLOTH_R_SPEC_CLAMP: f32 = 10.0;

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
  output.normal = normalize(skinnedNrm);
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

  // Shader→RGB → 颜色渐变.008 CONSTANT (edge AA terminator)
  let lum_shade = shader_to_rgb_diffuse(n, l, sun, amb, shadow);
  let ramp008 = ramp_constant_edge_aa(lum_shade, CLOTH_R_TOON_EDGE, vec4f(0,0,0,1), vec4f(1,1,1,1));
  let toon_r = ramp008.r;
  let mix04_fac = math_multiply(toon_r, CLOTH_R_MIX04_MUL);

  // 混合.004: A=色相/饱和度/明度.002(Hue=0.5 Sat=1.0 Val=0.2), B=纹理
  let dark_tex = hue_sat(0.5, 1.0, 0.19999998807907104, 1.0, tex_rgb);
  let mix04 = mix_blend(mix04_fac, dark_tex, tex_rgb);

  // 倒角.001.Z → 混合.003: A=混合.004, B=色相/饱和度/明度.002
  let bevel_z = clamp(n.y, 0.0, 1.0);
  let mix03 = mix_blend(bevel_z, mix04, dark_tex);

  // 环境光遮蔽 → 颜色渐变.001 LINEAR → 混合.001 (white/black) → 混合.002 OVERLAY Fac
  let ao = ao_fake(n, v);
  let ao_ramp_c = ramp_linear(ao, 0.0, vec4f(1,1,1,1), 0.8808, vec4f(0,0,0,1));
  let mix01_fac = ao_ramp_c.r;
  let mix01_rgb = mix(vec3f(1.0), vec3f(0.0), mix01_fac);

  // 混合.002 OVERLAY: Fac=混合.001, A=混合.003, B=色相/饱和度/明度.004
  let hue004 = hue_sat(0.5, 0.800000011920929, 2.0, 1.0, mix03);
  let overlay_fac = mix01_rgb.r;
  let npr_rgb = mix_overlay(overlay_fac, mix03, hue004);
  let npr_emission = npr_rgb * CLOTH_R_EMIT_STR;

  // 噪波→渐变→凹凸 (LIVE in M_Rough_Cloth — unlike Smooth Cloth): Strength=1.0, noise Scale=17.7.
  let noise_uv = mapping_point(input.worldPos, vec3f(0.0), vec3f(0.0), vec3f(1.0));
  let noise_val = tex_noise(noise_uv, CLOTH_R_NOISE_SCALE, 2.0, 0.5, 0.0);
  let noise_ramp = ramp_linear(noise_val, 0.0, vec4f(0,0,0,1), 1.0, vec4f(1,1,1,1)).r;
  let bumped_n = bump_lh(CLOTH_R_BUMP_STR, noise_ramp, n, input.worldPos);

  // 原理化BSDF (EEVEE port): metallic=0, specular=0.8, roughness=0.8187, specular_tint=0.
  let principled_base = hue_sat(0.5, 1.0, 0.800000011920929, 1.0, tex_rgb);
  let NL = max(dot(bumped_n, l), 0.0);
  let NV = max(dot(bumped_n, v), 1e-4);

  let f0 = vec3f(0.08 * CLOTH_R_SPECULAR);
  let f90 = mix(f0, vec3f(1.0), sqrt(CLOTH_R_SPECULAR));
  let brdf_lut = brdf_lut_sample(NV, CLOTH_R_ROUGHNESS);
  let reflection_color = F_brdf_multi_scatter(f0, f90, brdf_lut.xy);

  let spec_direct_raw = bsdf_ggx(bumped_n, l, v, CLOTH_R_ROUGHNESS) * sun * shadow * ltc_brdf_scale_from_lut(brdf_lut);
  let spec_direct = min(spec_direct_raw, vec3f(CLOTH_R_SPEC_CLAMP));
  let spec_indirect = amb;
  let spec_radiance = (spec_direct + spec_indirect) * reflection_color;

  // Indirect diffuse = base_color × L_w per Blender closure_eval_surface_lib.glsl line 302;
  // probe_evaluate_world_diff returns radiance (SH-projected, not cosine-convolved).
  let diffuse_radiance = principled_base * (sun * NL * shadow / PI_CR + amb);
  let principled = diffuse_radiance + spec_radiance;

  // 混合着色器.001 Fac=0.9: Shader=自发光.005, Shader_001=原理化BSDF
  let final_color = mix(npr_emission, principled, CLOTH_R_MIX_SHADER_FAC);

  var out: FSOut;
  out.color = vec4f(final_color, out_alpha);
  out.mask = 1.0;
  return out;
}

`
