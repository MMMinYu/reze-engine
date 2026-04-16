// M_Smooth_Cloth — dump socket order + m_graphs ramps/overlay/noise-bump (dump omits 噪波→凹凸 subtree).

import { NODES_WGSL } from "./nodes"

export const CLOTH_SMOOTH_SHADER_WGSL = /* wgsl */ `

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

const PI_C: f32 = 3.141592653589793;
const F0_CLOTH: f32 = 0.064; // Specular=0.8 → 0.08*0.8
const CLOTH_ROUGHNESS: f32 = 0.5;
const CLOTH_TOON_EDGE: f32 = 0.2966;
const CLOTH_MIX04_MUL: f32 = 0.5; // 运算.004 MULTIPLY Value_001 (dump)
const NPR_EMIT_STR: f32 = 18.200000762939453;
const NPR_MIX_SHADER_FAC: f32 = 0.8999999761581421;

fn ggx_d_cloth(ndoth: f32, a2: f32) -> f32 {
  let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (PI_C * denom * denom);
}

fn smith_g1_cloth(ndotx: f32, a2: f32) -> f32 {
  return 2.0 * ndotx / (ndotx + sqrt(a2 + (1.0 - a2) * ndotx * ndotx));
}

fn fresnel_schlick_cloth(cosTheta: f32, f0: f32) -> f32 {
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

  // Shader→RGB → 颜色渐变.008 CONSTANT — AA like face (same terminator artifact class)
  let lum_shade = shader_to_rgb_diffuse(n, l, sun, amb, shadow);
  let ramp008 = ramp_constant_edge_aa(lum_shade, CLOTH_TOON_EDGE, vec4f(0,0,0,1), vec4f(1,1,1,1));
  let toon_r = ramp008.r;
  // 颜色渐变.008 → 运算.004 MULTIPLY 0.5 → 混合.004 Factor
  let mix04_fac = math_multiply(toon_r, CLOTH_MIX04_MUL);

  // 混合.004: A=色相/饱和度/明度.002, B=纹理
  let dark_tex = hue_sat(0.5, 1.0, 0.19999998807907104, 1.0, tex_rgb);
  let mix04 = mix_blend(mix04_fac, dark_tex, tex_rgb);

  // 倒角.001→Z → 混合.003 Factor; A=混合.004, B=色相/饱和度/明度.002
  let bevel_z = clamp(n.y, 0.0, 1.0);
  let mix03 = mix_blend(bevel_z, mix04, dark_tex);

  // 环境光遮蔽 → 颜色渐变.001 LINEAR → 混合.001 (白/黑) → 混合.002 OVERLAY Fac
  let ao = ao_fake(n, v);
  let ao_ramp_c = ramp_linear(ao, 0.0, vec4f(1,1,1,1), 0.8808, vec4f(0,0,0,1));
  let mix01_fac = ao_ramp_c.r;
  let mix01_rgb = mix(vec3f(1.0), vec3f(0.0), mix01_fac);

  // 混合.002 OVERLAY: Fac=混合.001, A=混合.003, B=色相/饱和度/明度.004
  let hue004 = hue_sat(0.5, 0.800000011920929, 2.0, 1.0, mix03);
  let overlay_fac = mix01_rgb.r;
  let npr_rgb = mix_overlay(overlay_fac, mix03, hue004);
  let npr_emission = npr_rgb * NPR_EMIT_STR;

  // 原理化BSDF: 噪波(Scale=17.7)→颜色渐变→凹凸 Strength=1 → Normal (m_graphs; bump_lh)
  let principled_base = hue_sat(0.5, 1.0, 0.800000011920929, 1.0, tex_rgb);
  let noise_uv = mapping_point(vec3f(input.uv, 0.0), vec3f(0.0), vec3f(0.0), vec3f(1.0));
  let nv = tex_noise(noise_uv, 17.7, 2.0, 0.5, 0.0);
  let nh = ramp_linear(nv, 0.0, vec4f(0.6351, 0.6351, 0.6351, 1.0), 1.0, vec4f(0.5139, 0.5139, 0.5139, 1.0)).r;
  let pn = bump_lh(1.0, nh, n, input.worldPos);
  let p_ndotl = max(dot(pn, l), 0.0);
  let p_ndotv = max(dot(pn, v), 0.001);
  let h = normalize(l + v);
  let p_ndoth = max(dot(pn, h), 0.0);
  let p_vdoth = max(dot(v, h), 0.0);
  let a2 = CLOTH_ROUGHNESS * CLOTH_ROUGHNESS;
  let D = ggx_d_cloth(p_ndoth, a2);
  let G = smith_g1_cloth(p_ndotl, a2) * smith_g1_cloth(p_ndotv, a2);
  let F = fresnel_schlick_cloth(p_vdoth, F0_CLOTH);
  let spec_vis = smoothstep(0.0, 0.06, p_ndotl);
  let spec = (D * G * F) / max(4.0 * p_ndotl * p_ndotv, 0.02) * spec_vis;
  let kd = (1.0 - F) * principled_base / PI_C;
  let direct = (kd + spec) * sun * p_ndotl * shadow;
  let ambient = principled_base * amb;
  let principled = ambient + direct;

  // 混合着色器.001: Shader=自发光.005, Shader_001=原理化BSDF, Fac=0.9
  let final_color = mix(npr_emission, principled, NPR_MIX_SHADER_FAC);

  return vec4f(final_color, out_alpha);
}

`
