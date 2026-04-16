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

const PI_M: f32 = 3.141592653589793;
const METAL_ROUGHNESS: f32 = 0.3;
const METAL_SPECULAR_TINT: f32 = 0.114;
const METAL_TOON_EDGE: f32 = 0.2966;
const METAL_MIX04_MUL: f32 = 0.5;
const METAL_EMIT_STR: f32 = 8.100000381469727;
const METAL_MIX_SHADER_FAC: f32 = 0.6967;
const METAL_VORONOI_SCALE: f32 = 4.3;

fn ggx_d_m(ndoth: f32, a2: f32) -> f32 {
  let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (PI_M * denom * denom);
}

fn smith_g1_m(ndotx: f32, a2: f32) -> f32 {
  return 2.0 * ndotx / (ndotx + sqrt(a2 + (1.0 - a2) * ndotx * ndotx));
}

fn fresnel_schlick_rgb(cosTheta: f32, f0: vec3f) -> vec3f {
  return f0 + (vec3f(1.0) - f0) * pow(1.0 - cosTheta, 5.0);
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

  // ═══ NPR toon stack (图像 → HSV.007 Val=0.8 → 转接点.001) ═══
  let tex_tint = hue_sat(0.5, 1.0, 0.800000011920929, 1.0, tex_rgb);
  let lum_shade = shader_to_rgb_diffuse(n, l, sun, amb, shadow);
  let ramp008 = ramp_constant_edge_aa(lum_shade, METAL_TOON_EDGE, vec4f(0,0,0,1), vec4f(1,1,1,1));
  let mix04_fac = math_multiply(ramp008.r, METAL_MIX04_MUL);

  // 混合.004: A=HSV.002(Val=0.2 dark), B=tex_tint
  let dark_tex = hue_sat(0.5, 1.0, 0.19999998807907104, 1.0, tex_tint);
  let mix04 = mix_blend(mix04_fac, dark_tex, tex_tint);

  // AO white/black ramp → 混合.002 factor
  let ao = ao_fake(n, v);
  let ao_ramp_c = ramp_linear(ao, 0.0, vec4f(1,1,1,1), 0.8808, vec4f(0,0,0,1));
  let overlay_fac = mix(1.0, 0.0, ao_ramp_c.r);

  // 混合.002 OVERLAY: A=HSV.008(Val=1.0 identity) ← mix04, B=HSV.004(Val=2.0 bright) ← mix04
  let hue008 = mix04; // identity HSV
  let hue004 = hue_sat(0.5, 1.0, 2.0, 1.0, mix04);
  let npr_rgb = mix_overlay(overlay_fac, hue008, hue004);
  let npr_emission = npr_rgb * METAL_EMIT_STR;

  // ═══ Metallic Principled base color ═══
  // Reflection-coord Voronoi for metallic sparkle:
  //   纹理坐标.Reflection → 矢量运算 → 沃罗诺伊(Scale=4.3) → 颜色渐变 → 混合.005
  let refl_dir = reflect(-v, n);
  let voro = tex_voronoi_f1(refl_dir, METAL_VORONOI_SCALE);
  let voro_ramp = ramp_linear(voro, 0.0, vec4f(0,0,0,1), 1.0, vec4f(1,1,1,1)).r;
  // 混合.005: Fac=voro_ramp, A=voro_color(grayscale), B=HSV.006(Hue=0.5 Sat=1.5 Val=1.3)
  let hue006 = hue_sat(0.5, 1.5, 1.2999999523162842, 1.0, tex_tint);
  let albedo = mix_blend(voro_ramp, vec3f(voro_ramp), hue006);

  // Metallic BRDF: F0 = mix(vec3(1), albedo, specular_tint); no diffuse term.
  let F0_rgb = mix(vec3f(1.0), albedo, METAL_SPECULAR_TINT);
  let p_ndotl = max(dot(n, l), 0.0);
  let p_ndotv = max(dot(n, v), 0.001);
  let h = normalize(l + v);
  let p_ndoth = max(dot(n, h), 0.0);
  let p_vdoth = max(dot(v, h), 0.0);
  let a2 = METAL_ROUGHNESS * METAL_ROUGHNESS;
  let D = ggx_d_m(p_ndoth, a2);
  let G = smith_g1_m(p_ndotl, a2) * smith_g1_m(p_ndotv, a2);
  let F = fresnel_schlick_rgb(p_vdoth, F0_rgb);
  let spec = F * (D * G) / max(4.0 * p_ndotl * p_ndotv, 0.001);
  let direct = spec * sun * p_ndotl * shadow;
  // Metallic ambient specular via Karis split-sum DFG (no diffuse term for metals).
  let env_spec = env_brdf_approx(F0_rgb, METAL_ROUGHNESS, p_ndotv);
  let ambient = env_spec * amb;
  let principled = ambient + direct;

  // 混合着色器.001 Fac=0.6967: Shader=npr_emission, Shader_001=principled
  let final_color = mix(npr_emission, principled, METAL_MIX_SHADER_FAC);

  return vec4f(final_color, out_alpha);
}

`
