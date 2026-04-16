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

const PI_H: f32 = 3.141592653589793;
const F0_HAIR: f32 = 0.08;
const HAIR_ROUGHNESS: f32 = 0.3;
// Dump M_Hair: 运算.004 GREATER_THAN second operand Value_001; 运算.007 POWER exponent Value_001; 背景 Color
const HAIR_TEX_GATE_THRESH: f32 = 0.15000000596046448;
const HAIR_RIM2_POW: f32 = 0.6300000548362732;
const HAIR_MIX_BG: vec3f = vec3f(0.1673291176557541);

fn ggx_d_hair(ndoth: f32, a2: f32) -> f32 {
  let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (PI_H * denom * denom);
}

fn smith_g1_hair(ndotx: f32, a2: f32) -> f32 {
  return 2.0 * ndotx / (ndotx + sqrt(a2 + (1.0 - a2) * ndotx * ndotx));
}

fn fresnel_schlick_hair(cosTheta: f32, f0: f32) -> f32 {
  return f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0);
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
  output.normal = normalize(skinnedNrm);
  output.uv = uv;
  output.worldPos = skinnedPos.xyz;
  return output;
}

@fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
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
  let hue_sat_shadow = hue_sat(0.5, 1.2, 0.5, 1.0, tex_color);
  // 色相/饱和度/明度.002 (0.48, 1.2, 0.7, 1) ← previous
  let hue_sat_002 = hue_sat(0.48, 1.2, 0.7, 1.0, hue_sat_shadow);
  // 色相/饱和度/明度.001 (0.5, 1.5, 1.0, 1) ← image reroute (lit path)
  let hue_sat_001 = hue_sat(0.5, 1.5, 1.0, 1.0, tex_color);

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

  // 环境光遮蔽 (AO).001 → 颜色渐变.001 CONSTANT [0→1, 0.3756→0] → 混合.001 → ao_factor
  let ao = ao_fake(n, v);
  let ramp_001 = ramp_constant(ao, 0.0, vec4f(1,1,1,1), 0.3756, vec4f(0,0,0,1)).r;
  let ao_factor = mix(1.0, 0.0, ramp_001);

  // 色相/饱和度/明度.004 (0.5, 0.8, 0.1, 1) ← mix_003
  let hue_sat_004 = hue_sat(0.5, 0.8, 0.1, 1.0, mix_003);

  // 混合.002 MIX Fac=ao_factor, A=hue_sat_004, B=mix_003
  let mix_002 = mix_blend(ao_factor, hue_sat_004, mix_003);

  // 自发光(发射).003 Strength=1.0 ← mix_002
  let emission3 = mix_002 * 1.0;

  // 菲涅尔.001 × 层权重.002 → 运算.003 MULTIPLY → 运算.007 POWER(exponent Value_001) → MixShader.002 Fac
  let rim2_raw = fresnel(1.45, n, v) * layer_weight_fresnel(0.61, n, v);
  let rim2_fac = math_power(rim2_raw, HAIR_RIM2_POW);
  // MixShader.002: Shader=Emission.003, Shader_001=背景 — (1-Fac)*emission + Fac*bg
  let mix_shader_002 = mix(emission3, HAIR_MIX_BG, rim2_fac);

  // 运算.004 GREATER_THAN: 图像→Value, threshold Value_001 (R when Color plugs float socket)
  let tex_gate = math_greater_than(tex_color.r, HAIR_TEX_GATE_THRESH);
  let gate_emit = vec3f(tex_gate) * 0.1;

  // 相加着色器: MixShader.002 + gate emission (color sum in linear space)
  let add_shader = mix_shader_002 + gate_emit;

  // Blender graph: 噪波纹理.002.Color → 法线贴图(Strength=0.1).Color → 原理化BSDF.Normal.
  // NORMAL_MAP with a scalar noise broadcast to vec3 + Strength=0.1 produces a near-identity
  // perturbation in Blender; using plain geometry normal for GGX matches visually and avoids
  // the wrong-algorithm bump_lh divergence (BUMP ≠ NORMAL_MAP).
  let p_ndotl = max(dot(n, l), 0.0);
  let p_ndotv = max(dot(n, v), 0.001);
  let h = normalize(l + v);
  let p_ndoth = max(dot(n, h), 0.0);
  let p_vdoth = max(dot(v, h), 0.0);
  let a2 = HAIR_ROUGHNESS * HAIR_ROUGHNESS;
  let D = ggx_d_hair(p_ndoth, a2);
  let G = smith_g1_hair(p_ndotl, a2) * smith_g1_hair(p_ndotv, a2);
  let F = fresnel_schlick_hair(p_vdoth, F0_HAIR);
  let spec = (D * G * F) / max(4.0 * p_ndotl * p_ndotv, 0.001);
  let kd = (1.0 - F) * bc / PI_H;
  let direct = (kd + spec) * sun * p_ndotl * shadow;
  let ambient = bc * light.ambientColor.xyz;
  let principled = ambient + direct;

  // 混合着色器.001 Fac=0.2: first socket=相加着色器, second=原理化BSDF
  let final_color = mix(add_shader, principled, 0.2);

  return vec4f(final_color, alpha);
}

`
