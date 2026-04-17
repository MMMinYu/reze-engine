// M_Hair — WGSL trace of 仿深空之眼渲染预设v1.0_by_小绿毛猫_material_graph_dump.json "M_Hair" (socket ids + defaults).
// MixShader.001: Add→Shader (first), Principled→Shader_001 (second) → out = mix(first, second, Fac).

import { NODES_WGSL } from "./nodes"

export const HAIR_SHADER_WGSL = /* wgsl */ `

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

const PI_H: f32 = 3.141592653589793;
const HAIR_SPECULAR: f32 = 1.0;
const HAIR_ROUGHNESS: f32 = 0.3;
// Dump M_Hair: 运算.004 GREATER_THAN second operand Value_001; 运算.007 POWER exponent Value_001; 背景 Color
const HAIR_TEX_GATE_THRESH: f32 = 0.15000000596046448;
const HAIR_RIM2_POW: f32 = 0.6300000548362732;
const HAIR_MIX_BG: vec3f = vec3f(0.1673291176557541);

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
  let alpha = material.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;
  let sun = light.lights[0].color.xyz * light.lights[0].color.w;

  // 图像纹理 ← 纹理坐标.UV → 映射 (default 1,1,1 scale per JSON)
  let tex_color = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;
  let shadow = sampleShadow(input.worldPos, n);

  // 色相/饱和度/明度 (Hue=0.5 Sat=1.2 Val=0.5 Fac=1) ← reroute from image
  let hue_sat_shadow = hue_sat_id(1.2, 0.5, 1.0, tex_color);
  // 色相/饱和度/明度.002 (0.48, 1.2, 0.7, 1) ← previous
  let hue_sat_002 = hue_sat(0.48, 1.2, 0.7, 1.0, hue_sat_shadow);
  // 色相/饱和度/明度.001 (0.5, 1.5, 1.0, 1) ← image reroute (lit path)
  let hue_sat_001 = hue_sat_id(1.5, 1.0, 1.0, tex_color);

  // 漫射 BSDF.002 → Shader --> RGB → 颜色渐变.008 CONSTANT [0→0, 0.2966→1]
  let ndotl_raw = shader_to_rgb_diffuse(n, l, sun, light.ambientColor.xyz, shadow);
  let ramp_008 = ramp_constant(ndotl_raw, 0.0, vec4f(0,0,0,1), 0.2966, vec4f(1,1,1,1)).r;

  // 混合.004 MIX Fac=ramp_008, A=hue_sat_002, B=hue_sat_001
  let mix_004 = mix_blend(ramp_008, hue_sat_002, hue_sat_001);

  // 亮度/对比度 (Bright=0.1 Contrast=0.2) ← mix_004 only (links: not bevel path)
  let bc = bright_contrast(mix_004, 0.1, 0.2);

  // 倒角.001 → 分离 XYZ.001 → Z → 混合.003 Factor; A=bc, B=hue_sat_002
  let bevel_z = clamp(n.y, 0.0, 1.0);
  let mix_003 = mix_blend(bevel_z, bc, hue_sat_002);

  // 环境光遮蔽 (AO).001 → 颜色渐变.001 → 混合.001 → 混合.002 chain collapses with fake AO=1:
  //   ramp_constant(1, 0→white, 0.3756→black).r = 0 → ao_factor = mix(1,0,0) = 1 → mix_002 = mix_003.
  //   hue_sat_004 becomes unreachable. When real SSAO lands, restore the original 5-line port.
  let emission3 = mix_003; // Emission.003 Strength=1.0 (×1 omitted)

  // 菲涅尔.001 × 层权重.002 → 运算.003 MULTIPLY → 运算.007 POWER(exponent Value_001) → MixShader.002 Fac
  let rim2_raw = fresnel(1.45, n, v) * layer_weight_fresnel(0.61, n, v);
  let rim2_fac = math_power(rim2_raw, HAIR_RIM2_POW);
  // MixShader.002: Shader=Emission.003, Shader_001=背景 — (1-Fac)*emission + Fac*bg
  let mix_shader_002 = mix(emission3, HAIR_MIX_BG, rim2_fac);

  // 运算.004 GREATER_THAN: 图像→Value, threshold Value_001. Blender converts Color→Float
  // via BT.601 luminance, not raw R — same socket-semantic fix as M_Face.
  let tex_gate = math_greater_than(color_to_value(tex_color), HAIR_TEX_GATE_THRESH);
  let gate_emit = vec3f(tex_gate) * 0.1;

  // 相加着色器: MixShader.002 + gate emission (color sum in linear space)
  let add_shader = mix_shader_002 + gate_emit;

  // 原理化BSDF (EEVEE port): metallic=0, specular=1.0, roughness=0.3, specular_tint=0.
  // Blender graph has 噪波→法线贴图 Strength=0.1 on Principled.Normal, but MixShader.001
  // weights Principled at only 0.2; spec contribution × that weight is imperceptible in
  // A/B with the noise-bump port enabled, so we drop it and keep plain n — saves a full
  // tex_noise + bump_lh per hair fragment.
  let NL = max(dot(n, l), 0.0);
  let NV = max(dot(n, v), 1e-4);

  let f0 = vec3f(0.08 * HAIR_SPECULAR);
  let f90 = mix(f0, vec3f(1.0), sqrt(HAIR_SPECULAR));
  let brdf_lut = brdf_lut_sample(NV, HAIR_ROUGHNESS);
  let reflection_color = F_brdf_multi_scatter(f0, f90, brdf_lut.xy);

  let spec_direct = bsdf_ggx(n, l, v, NL, NV, HAIR_ROUGHNESS) * sun * shadow * ltc_brdf_scale_from_lut(brdf_lut);
  let spec_indirect = light.ambientColor.xyz;
  let spec_radiance = (spec_direct + spec_indirect) * reflection_color;

  // Indirect diffuse = base_color × L_w per Blender closure_eval_surface_lib.glsl line 302;
  // probe_evaluate_world_diff returns radiance (SH-projected, not cosine-convolved).
  let diffuse_radiance = bc * (sun * NL * shadow / PI_H + light.ambientColor.xyz);
  let principled = diffuse_radiance + spec_radiance;

  // 混合着色器.001 Fac=0.2: first socket=相加着色器, second=原理化BSDF
  let final_color = mix(add_shader, principled, 0.2);

  var out: FSOut;
  out.color = vec4f(final_color, alpha);
  out.mask = 1.0;
  return out;
}

`
