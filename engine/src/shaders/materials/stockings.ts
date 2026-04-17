// M_Stockings — 仿深空之眼渲染预设v1.0_by_小绿毛猫_material_graph_dump.json "M_Stockings".
// NPR mask (bbox gradient × facing rim) drives Mix Shader between an Emission (HSV-boosted texture)
// and a Principled BSDF with sheen. Mapping rotation + Generated-like coord approximated via UV,
// since our Y-up PMX engine has no object bbox; the gradient is a soft mask, not a hard landmark.

import { NODES_WGSL } from "./nodes"

export const STOCKINGS_SHADER_WGSL = /* wgsl */ `

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

const PI_S: f32 = 3.141592653589793;
// Principled BSDF params from dump (Alpha=0.95 is intentionally dropped — see alpha-hash note below)
const STOCK_METALLIC: f32 = 0.1;
const STOCK_SPECULAR: f32 = 1.0;
const STOCK_ROUGHNESS: f32 = 0.5;
const STOCK_SHEEN: f32 = 0.7017999887466431;
const STOCK_SHEEN_TINT: f32 = 0.5;
// NPR mask ramps
const STOCK_RAMP002_P1: f32 = 0.9565;  // EASE [0→black, 0.9565→white]
const STOCK_RAMPFACE_P1: f32 = 0.5435; // EASE [0→black, 0.5435→white]
const STOCK_LW_BLEND: f32 = 0.4;       // Layer Weight Blend

// principled_sheen (gpu_shader_material_principled.glsl:8-14) — empirical NV curve
fn principled_sheen(NV: f32) -> f32 {
  let f = 1.0 - NV;
  return f * f * f * 0.077 + f * 0.01 + 0.00026;
}

// Wyman & McGuire "Hashed Alpha Testing" (2017) — world-space hash with derivative-aware
// pixel-scale selection, matches Blender EEVEE prepass_frag.glsl::hashed_alpha_threshold.
// Key property: dither pattern is stable in object/world space (doesn't swim) and stays
// at one-pixel frequency regardless of view distance, which makes it tolerable without TAA.
fn _hash_wm(a: vec2f) -> f32 {
  return fract(1e4 * sin(17.0 * a.x + 0.1 * a.y) * (0.1 + abs(sin(13.0 * a.y + a.x))));
}
fn _hash3d_wm(a: vec3f) -> f32 {
  return _hash_wm(vec2f(_hash_wm(a.xy), a.z));
}
fn hashed_alpha_threshold(co: vec3f) -> f32 {
  let alphaHashScale: f32 = 1.0;
  let max_deriv = max(length(dpdx(co)), length(dpdy(co)));
  let pix_scale = 1.0 / max(alphaHashScale * max_deriv, 1e-6);
  let pix_scale_log = log2(pix_scale);
  let px_lo = exp2(floor(pix_scale_log));
  let px_hi = exp2(ceil(pix_scale_log));
  let a_lo = _hash3d_wm(floor(px_lo * co));
  let a_hi = _hash3d_wm(floor(px_hi * co));
  let fac = fract(pix_scale_log);
  let x = mix(a_lo, a_hi, fac);
  // CDF remap so that discard-probability = (1 - alpha) uniformly across scale transitions
  let a = min(fac, 1.0 - fac);
  let one_a = 1.0 - a;
  let denom = 1.0 / max(2.0 * a * one_a, 1e-6);
  let one_x = 1.0 - x;
  let case_lo = (x * x) * denom;
  let case_mid = (x - 0.5 * a) / max(one_a, 1e-6);
  let case_hi = 1.0 - (one_x * one_x) * denom;
  var threshold = select(case_hi, select(case_lo, case_mid, x >= a), x < one_a);
  return clamp(threshold, 1e-6, 1.0);
}

// Smoothstep-based EASE ramp (Blender VALTORGB EASE) — 2 stops, saturate+smoothstep between
fn ramp_ease_s(f: f32, p0: f32, p1: f32) -> f32 {
  let t = saturate((f - p0) / max(p1 - p0, 1e-6));
  return t * t * (3.0 - 2.0 * t);
}

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
  @location(1) bloom_mask: f32,
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
  // Alpha HASHED (Blender EEVEE "Hashed" blend mode) per preset author's note —
  // self-overlap on the stockings produces sort cracks under alpha blend. Wyman-style
  // worldPos hash + depth-write is sort-independent. NOTE: Principled.Alpha=0.95 from
  // the dump is DROPPED here — it relies on TAA to smooth the resulting 5%-everywhere
  // dither, and without TAA it shows as a pervasive dot pattern. Hash now gates only
  // on texture/material alpha, so solid stockings regions stay fully opaque.
  let combined_alpha = material.alpha * tex_s.a;
  if (combined_alpha < hashed_alpha_threshold(input.worldPos)) { discard; }
  let out_alpha = 1.0;

  // ═══ NPR MASK: TEX_COORD.Generated → Mapping(Rot=0,π/2,π/2, Loc=(1,1,1)) → Gradient Texture
  // The Blender mapping reduces to gradient.x = 1 - input.y (rot swaps axes, loc offsets by 1).
  // We approximate Generated with UV since Y-up PMX has no object bbox in pipeline state.
  let gen_coord = vec3f(input.uv, 0.0);
  let mapped = mapping_point(gen_coord, vec3f(1.0), vec3f(0.0, 1.5708, 1.5708), vec3f(1.0));
  let gradient = tex_gradient_linear(mapped);

  // Ramp.001 LINEAR [0→black, 0.5→white, 1.0→black] — triangular peak at 0.5
  let ramp001 = 1.0 - abs(2.0 * gradient - 1.0);
  // Ramp.002 EASE [0→black, 0.9565→white]
  let ramp002 = ramp_ease_s(ramp001, 0.0, STOCK_RAMP002_P1);

  // Layer Weight.Facing (Blend=0.4) → Ramp EASE [0→black, 0.5435→white]
  let facing = layer_weight_facing(STOCK_LW_BLEND, n, v);
  let ramp_face = ramp_ease_s(facing, 0.0, STOCK_RAMPFACE_P1);

  // Mix.001: MIX blend Fac=0.5, A=white, B=ramp_face → (A,B) averaged 50/50
  let mix001 = mix(1.0, ramp_face, 0.5);
  // Mix: LIGHTEN blend Fac=0.5, A=mix001, B=ramp002 → A smoothly lightens toward max(A,B)
  let lighten = max(mix001, ramp002);
  let mask = mix(mix001, lighten, 0.5);

  // ═══ EMISSION SHADER ═══
  // Hue=0.5 (identity rotation), Sat=1.0, Val=5.0 (5× brightness boost), Fac=1; Strength=1
  let emission = hue_sat_id(1.0, 5.0, 1.0, tex_rgb);

  // ═══ PRINCIPLED BSDF (EEVEE port) ═══
  // base_color_tint, metallic f0, sheen coarse approx (scales diffuse radiance).
  let NL = max(dot(n, l), 0.0);
  let NV = max(dot(n, v), 1e-4);

  // f0 = mix((0.08*spec)*dielectric_tint, base, metallic); dielectric_tint=1 since specular_tint=0.
  let dielectric_f0 = vec3f(0.08 * STOCK_SPECULAR);
  let f0 = mix(dielectric_f0, tex_rgb, STOCK_METALLIC);
  let f90 = mix(f0, vec3f(1.0), sqrt(STOCK_SPECULAR));
  let brdf_lut = brdf_lut_sample(NV, STOCK_ROUGHNESS);
  let reflection_color = F_brdf_multi_scatter(f0, f90, brdf_lut.xy);

  let spec_direct = bsdf_ggx(n, l, v, NL, NV, STOCK_ROUGHNESS) * sun * shadow * ltc_brdf_scale_from_lut(brdf_lut);
  let spec_indirect = amb;
  let spec_radiance = (spec_direct + spec_indirect) * reflection_color;

  // Sheen coarse: diffuse_color += sheen * sheen_color * principled_sheen(NV).
  let base_tint = tint_from_color(tex_rgb);
  let sheen_color = mix(vec3f(1.0), base_tint, STOCK_SHEEN_TINT);
  let diffuse_color = tex_rgb + STOCK_SHEEN * sheen_color * principled_sheen(NV);

  // diffuse_weight = (1 - metallic). Indirect diffuse uses L_w (no π; see closure_eval_surface_lib:302).
  let diffuse_weight = 1.0 - STOCK_METALLIC;
  let diffuse_radiance = diffuse_color * (sun * NL * shadow / PI_S + amb) * diffuse_weight;
  let principled = diffuse_radiance + spec_radiance;

  // ═══ MIX SHADER: Shader=Emission, Shader_001=Principled, Fac=mask ═══
  let final_color = mix(emission, principled, mask);

  var out: FSOut;
  out.color = vec4f(final_color, out_alpha);
  out.bloom_mask = 1.0;
  return out;
}

`
