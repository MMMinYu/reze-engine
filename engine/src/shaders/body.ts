// M_Body — 仿深空之眼渲染预设v1.0_by_小绿毛猫_material_graph_dump.json "M_Body"; VALTORGB / math ops from m_graphs where dump omits them.

import { NODES_WGSL } from "./nodes"

export const BODY_SHADER_WGSL = /* wgsl */ `

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

const PI_B: f32 = 3.141592653589793;
const F0_BODY: f32 = 0.04;
const BODY_ROUGHNESS: f32 = 0.3;
// Dump: 层权重.002 Blend; 运算.007 POWER exponent Value_001; 背景 Color; 运算.004 after invert
const BODY_RIM2_LAYER_BLEND: f32 = 0.20000000298023224;
const BODY_RIM2_POW: f32 = 1.4300000667572021;
const BODY_RIM2_BG: vec3f = vec3f(1.0, 0.4303792119026184, 0.3315804898738861);
const BODY_WARM_AO_MUL: f32 = 0.30000001192092896;
const BODY_MIX_NPR: f32 = 0.5;
// EEVEE Light Clamp equivalent — caps firefly specular from noise-bumped NDF aliasing.
const BODY_SPEC_CLAMP: f32 = 10.0;

fn ggx_d_body(ndoth: f32, a2: f32) -> f32 {
  let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (PI_B * denom * denom);
}

fn smith_g1_body(ndotx: f32, a2: f32) -> f32 {
  return 2.0 * ndotx / (ndotx + sqrt(a2 + (1.0 - a2) * ndotx * ndotx));
}

fn fresnel_schlick_body(cosTheta: f32, f0: f32) -> f32 {
  let m = 1.0 - cosTheta;
  let m2 = m * m;
  return f0 + (1.0 - f0) * (m2 * m2 * m);
}

// smoothstep-based ramp: t*t*(3-2*t) between two color stops
fn ramp_ease(f: f32, p0: f32, c0: vec4f, p1: f32, c1: vec4f) -> vec4f {
  let t = saturate((f - p0) / max(p1 - p0, 1e-6));
  let ss = t * t * (3.0 - 2.0 * t);
  return mix(c0, c1, ss);
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
  @location(1) mask: f32,
};

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = material.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;
  let sun = light.lights[0].color.xyz * light.lights[0].color.w;

  let tex_color = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;
  let shadow = sampleShadow(input.worldPos, n);

  // ═══ TOON MASK: ShaderToRGB → ramp.008 CONSTANT [0→black, 0.2966→white] ═══
  let ndotl_raw = shader_to_rgb_diffuse(n, l, sun, light.ambientColor.xyz, shadow);
  let toon = ramp_constant(ndotl_raw, 0.0, vec4f(0,0,0,1), 0.2966, vec4f(1,1,1,1)).r;

  // ═══ TOON COLOR: Mix.004 A=HueSat, B=HueSat.001, Fac=ramp.008 (R) ═══
  let shadow_tint = hue_sat_id(2.0, 0.3499999940395355, 1.0, tex_color);
  let lit_tint = hue_sat_id(1.5, 1.0, 1.0, tex_color);
  let toon_color = mix_blend(toon, shadow_tint, lit_tint);
  let bc = bright_contrast(toon_color, 0.1, 0.2);

  // ═══ AO CHAIN: AO → ramp CONSTANT [0→white, 0.5995→black] → Mix.003 ═══
  let ao = 1.0; // ao_fake(n, v) — no SSAO yet; inline 1.0 so the ramp/mix chain folds at compile time.
  let ao_ramp = ramp_constant(ao, 0.0, vec4f(1,1,1,1), 0.5995, vec4f(0,0,0,1)).r;
  let ao_mixed = mix_blend(ao_ramp, bc, vec3f(0.8301780223846436, 0.3345769941806793, 0.27946099638938904));

  // ═══ EMISSION.003 (strength=4.0) ═══
  let emission3 = ao_mixed * 4.0;

  // ═══ WARM: 颜色渐变.008 → 运算.006 ADD +0.5 (m_graphs) → clamp → 颜色渐变.003 ═══
  let ao_inv = invert_f(1.0, ao_ramp);
  let warm_str = ao_inv * BODY_WARM_AO_MUL;
  let warm_input = clamp(toon + 0.5, 0.0, 1.0);
  let warm_color = ramp_cardinal(warm_input, 0.2409,
    vec4f(0.2426, 0.068, 0.0588, 1.0), 0.4663,
    vec4f(0.6677, 0.5024, 0.5126, 1.0)).rgb;
  let warm_emission = warm_color * warm_str;

  // ═══ RIM 1: 菲涅尔 × 层权重.001 Facing Blend=0.24 → 自发光 Strength ═══
  let rim1_str = fresnel(2.0, n, v) * layer_weight_facing(0.24000005424022675, n, v);
  let rim1 = vec3f(0.984157919883728, 0.6110184788703918, 0.5736401677131653) * rim1_str;

  // ═══ RIM 2: 层权重.002 Facing → 运算.007 POWER → 颜色渐变.010 EASE → MixShader.002 Fac ═══
  let facing_raw = layer_weight_facing(BODY_RIM2_LAYER_BLEND, n, v);
  let facing_pow = math_power(facing_raw, BODY_RIM2_POW);
  let rim2_fac = ramp_ease(facing_pow, 0.0, vec4f(0,0,0,1), 0.5052, vec4f(1,1,1,1)).r;
  let rim2_mixed = mix(emission3, BODY_RIM2_BG, rim2_fac);

  // ═══ NPR STACK: AddShader chain (no bright gate in body) ═══
  let add0 = rim1 + rim2_mixed;
  let npr_stack = add0 + warm_emission;

  // ═══ PRINCIPLED BSDF: noise bump, GGX specular, SSS from AO ═══
  // Mapping loc=rot=0 → plain scale multiply, inline.
  let noise_val = tex_noise_d2(input.worldPos * vec3f(1.0, 1.0, 1.5), 1.0);
  let noise_ramp = ramp_linear(noise_val, 0.0, vec4f(0,0,0,1), 1.0, vec4f(1,1,1,1)).r;
  let bumped_n = bump_lh(0.324644535779953, noise_ramp, n, input.worldPos);

  let principled_base = mix_blend(noise_ramp, bc, vec3f(0.6831911206245422, 0.19474034011363983, 0.13732507824897766));
  let p_emission = bc * 0.2;

  // Reuse 'ao' (ao_fake(n, v) above) — identical inputs, avoid a second procedural AO pass.
  let sss = ramp_linear(ao, 0.003, vec4f(0,0,0,1), 1.0, vec4f(0.0786, 0.0786, 0.0786, 1.0)).r;

  let p_ndotl = max(dot(bumped_n, l), 0.0);
  let p_ndotv = max(dot(bumped_n, v), 0.001);
  let h = normalize(l + v);
  let p_ndoth = max(dot(bumped_n, h), 0.0);
  let p_vdoth = max(dot(v, h), 0.0);
  let a2 = BODY_ROUGHNESS * BODY_ROUGHNESS;
  let D = ggx_d_body(p_ndoth, a2);
  let G = smith_g1_body(p_ndotl, a2) * smith_g1_body(p_ndotv, a2);
  let F = fresnel_schlick_body(p_vdoth, F0_BODY);
  let brdf_lut = brdf_lut_sample(p_ndotv, BODY_ROUGHNESS);
  let spec = (D * G * F) / max(4.0 * p_ndotl * p_ndotv, 0.001) * ltc_brdf_scale_from_lut(brdf_lut);
  let kd = (1.0 - F) * principled_base / PI_B;
  // Split so we can clamp only the spec firefly contribution (EEVEE Light Clamp).
  let spec_radiance = vec3f(spec) * sun * p_ndotl * shadow;
  let spec_clamped = min(spec_radiance, vec3f(BODY_SPEC_CLAMP));
  let direct = kd * sun * p_ndotl * shadow + spec_clamped;
  // Indirect diffuse = base_color × L_w per Blender closure_eval_surface_lib.glsl line 302;
  // probe_evaluate_world_diff returns radiance (SH-projected, not cosine-convolved).
  let ambient = principled_base * light.ambientColor.xyz;
  let principled = ambient + direct + p_emission + vec3f(sss);

  // 混合着色器.001: Shader=相加着色器.001, Shader_001=原理化BSDF
  let final_color = mix(npr_stack, principled, BODY_MIX_NPR);

  var out: FSOut;
  out.color = vec4f(final_color, alpha);
  out.mask = 1.0;
  return out;
}

`
