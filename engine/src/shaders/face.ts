// M_Face — WGSL trace of 仿深空之眼渲染预设v1.0_by_小绿毛猫_material_graph_dump.json "M_Face"; VALTORGB stops from m_graphs (dump omits curve keys).

import { NODES_WGSL } from "./nodes"

export const FACE_SHADER_WGSL = /* wgsl */ `

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

// 3x3 PCF shadow sampling, 4096 map, normal-bias 0.08, depth-bias 0.001
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

const PI_F: f32 = 3.141592653589793;
const F0_FACE: f32 = 0.04; // specular=0.5 → F0 = 0.08*0.5 = 0.04
const FACE_ROUGHNESS: f32 = 0.3;
// Dump M_Face unlinked defaults (math op enum not serialized — warm clamp chain still from m_graphs)
const FACE_RIM2_POW: f32 = 0.6300000548362732;
const FACE_RIM2_BG: vec3f = vec3f(1.0, 0.4684903025627136, 0.3698573112487793);
const FACE_WARM_AO_MUL: f32 = 0.30000001192092896; // 运算.004 MULTIPLY after invert (was 0.5 in older trace)
const FACE_BRIGHT_TEX_THRESH: f32 = 0.9300000071525574; // 运算.005 GREATER_THAN Value_001
const FACE_MIX_NPR: f32 = 0.5; // 混合着色器.001 Fac

fn ggx_d_face(ndoth: f32, a2: f32) -> f32 {
  let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (PI_F * denom * denom);
}

fn smith_g1_face(ndotx: f32, a2: f32) -> f32 {
  return 2.0 * ndotx / (ndotx + sqrt(a2 + (1.0 - a2) * ndotx * ndotx));
}

fn fresnel_schlick_face(cosTheta: f32, f0: f32) -> f32 {
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

// Fragment: M_Face NPR + Principled hybrid
// TEX → HueSat shadow/lit → toon gate → BrightContrast → AO chain → emission stack
// Fresnel rims, warm AO emission, bright-texture gate, noise-bumped Principled
// Final = mix(Principled, NPR, 0.5)
@fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
  let alpha = material.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;
  let intensity = light.lights[0].color.w;
  let sun = light.lights[0].color.xyz * intensity;

  let tex_color = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;
  let shadow = sampleShadow(input.worldPos, n);

  // ═══ SOURCES ═══
  // DiffuseBSDF(white) → ShaderToRGB (energy-matched); shadow on direct only
  let ndotl_raw = shader_to_rgb_diffuse(n, l, sun, light.ambientColor.xyz, shadow);
  // ramp.008 CONSTANT — edge AA avoids binary fac shimmer / white specks on terminator (fwidth + smoothstep)
  let toon = ramp_constant_edge_aa(ndotl_raw, 0.2966, vec4f(0,0,0,1), vec4f(1,1,1,1)).r;
  let ao = ao_fake(n, v);

  // ═══ TOON COLOR ═══
  let shadow_tint = hue_sat(0.46000000834465027, 2.0, 0.3499999940395355, 1.0, tex_color); // HueSat.002
  let lit_tint = hue_sat(0.46000000834465027, 1.600000023841858, 1.5, 1.0, tex_color); // HueSat.001
  let toon_color = mix_blend(toon, shadow_tint, lit_tint); // Mix.004
  let bc = bright_contrast(toon_color, 0.1, 0.2);

  // ═══ AO CHAIN ═══
  // ramp CONSTANT [0→white, 0.5995→black]
  let ao_ramp = ramp_constant(ao, 0.0, vec4f(1,1,1,1), 0.5995, vec4f(0,0,0,1)).r;
  // Mix.003(Factor=ao_ramp, A=bc, B=reddish tint)
  let ao_mixed = mix_blend(ao_ramp, bc, vec3f(0.8302, 0.3346, 0.2795));

  // ═══ EMISSION 3 ═══
  let emission3 = ao_mixed * 2.5; // Emission.003(Strength=2.5)

  // ═══ WARM EMISSION ═══
  let ao_inv = invert_f(1.0, ao_ramp);
  let warm_str = ao_inv * FACE_WARM_AO_MUL; // 反转 → 运算.004 MULTIPLY Value_001
  let warm_input = clamp(toon * 0.5 + 0.5, 0.0, 1.0); // 运算.001→运算.006→Clamp
  // ramp.003 CARDINAL [0.2409→warm dark, 0.4663→warm light]
  let warm_color = ramp_cardinal(warm_input, 0.2409,
    vec4f(0.2426, 0.068, 0.0588, 1.0), 0.4663,
    vec4f(0.6677, 0.5024, 0.5126, 1.0)).rgb;
  let warm_emission = warm_color * warm_str; // Emission.001

  // ═══ RIM 1 ═══
  // Fresnel(IOR=2.0) × LayerWeight.001(Facing, Blend=0.24)
  let rim1_str = fresnel(2.0, n, v) * layer_weight_facing(0.24, n, v);
  let rim1 = vec3f(0.984157919883728, 0.6110184788703918, 0.5736401677131653) * rim1_str;

  // ═══ RIM 2 ═══
  // Fresnel.001(IOR=1.45) × LayerWeight.002(Fresnel output, Blend=0.61)
  let rim2_raw = fresnel(1.45, n, v) * layer_weight_fresnel(0.61, n, v);
  let rim2_fac = math_power(rim2_raw, FACE_RIM2_POW);
  // MixShader.002: Shader=Emission.003, Shader_001=背景
  let rim2_mixed = mix(emission3, FACE_RIM2_BG, rim2_fac);

  // 转接点.005(tex) → 运算.005 GREATER_THAN Value_001
  let tex_gate = math_greater_than(tex_color.r, FACE_BRIGHT_TEX_THRESH);
  let bright_emit = vec3f(tex_gate) * 3.0; // Emission.002(Strength=3.0)

  // ═══ NPR STACK (AddShader chain) ═══
  let add2 = rim2_mixed + bright_emit; // AddShader.002
  let add0 = rim1 + add2; // AddShader
  let npr_stack = add0 + warm_emission; // AddShader.001

  // ═══ PRINCIPLED BSDF ═══
  // Noise-based bump normal
  let gen = mapping_point(input.worldPos, vec3f(0.0), vec3f(0.0), vec3f(1.0, 1.0, 1.5));
  let noise_val = tex_noise(gen, 1.0, 2.0, 0.5, 0.0);
  let noise_ramp = ramp_linear(noise_val, 0.0, vec4f(0,0,0,1), 1.0, vec4f(1,1,1,1)).r;
  let bumped_n = bump_lh(0.324644535779953, noise_ramp, n, input.worldPos); // 凹凸 Strength; LH bump

  // Mix.001(Factor=noise_ramp, A=bc, B=dark red)
  let principled_base = mix_blend(noise_ramp, bc, vec3f(0.6832, 0.1947, 0.1373));
  // Emission input from reroute.011 (bc), Strength=0.2
  let p_emission = bc * 0.2;
  // AO.002 → ramp.005 LINEAR [0.003→black, 1.0→gray] for subsurface approx
  let ao2 = ao_fake(n, v);
  let sss = ramp_linear(ao2, 0.003, vec4f(0,0,0,1), 1.0, vec4f(0.0786, 0.0786, 0.0786, 1.0)).r;

  // GGX PBR: Metallic=0, Roughness=0.3, Specular=0.5
  let p_ndotl = max(dot(bumped_n, l), 0.0);
  let p_ndotv = max(dot(bumped_n, v), 0.001);
  let h = normalize(l + v);
  let p_ndoth = max(dot(bumped_n, h), 0.0);
  let p_vdoth = max(dot(v, h), 0.0);
  let a2 = FACE_ROUGHNESS * FACE_ROUGHNESS;
  let D = ggx_d_face(p_ndoth, a2);
  let G = smith_g1_face(p_ndotl, a2) * smith_g1_face(p_ndotv, a2);
  let F = fresnel_schlick_face(p_vdoth, F0_FACE);
  // Kill GGX fireflies when N·L→0 (bump + hard cel boundary); smoothstep barely widens dark region
  let spec_vis = smoothstep(0.0, 0.06, p_ndotl);
  let spec = (D * G * F) / max(4.0 * p_ndotl * p_ndotv, 0.02) * spec_vis;
  let kd = (1.0 - F) * principled_base / PI_F;
  let direct = (kd + spec) * sun * p_ndotl * shadow;
  let ambient = principled_base * light.ambientColor.xyz;
  let principled = ambient + direct + p_emission + vec3f(sss);

  // 混合着色器.001: Shader=相加着色器.001, Shader_001=原理化BSDF — Fac blends toward second
  let final_color = mix(npr_stack, principled, FACE_MIX_NPR);

  return vec4f(final_color, alpha);
}

`
