// M_Hair material — rewritten from exact node-graph evaluation trace.

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

fn filmic(x: f32) -> f32 {
  var lut = array<f32, 14>(
    0.0067, 0.0141, 0.0272, 0.0499, 0.0885, 0.1512, 0.2462,
    0.3753, 0.5273, 0.6776, 0.8031, 0.8929, 0.9495, 0.9814
  );
  let t = clamp(log2(max(x, 1e-10)) + 10.0, 0.0, 13.0);
  let i = u32(t);
  let j = min(i + 1u, 13u);
  return mix(lut[i], lut[j], t - f32(i));
}

fn tonemap(hdr: vec3f) -> vec3f {
  return vec3f(filmic(hdr.x), filmic(hdr.y), filmic(hdr.z));
}

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
const F0_HAIR: f32 = 0.08; // Specular=1.0 → F0 = 0.08
const HAIR_ROUGHNESS: f32 = 0.3;

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

// Fragment: M_Hair — NPR toon + principled hybrid
// HueSat chain: tex → HueSat(0.5,1.2,0.5) → HueSat.002(0.48,1.2,0.7) = adjusted_tint
// Separate lit path: tex → HueSat.001(0.5,1.5,1.0) = lit_tint
// Mix.004(toon, adjusted_tint, lit_tint) → BrightContrast(0.1,0.2) = bc
// Bevel.Z → Mix.003(bevel_z, bc, adjusted_tint) = edge_mix
// AO → ramp.001 → Mix.001 = ao_factor; edge_mix → HueSat.004(0.5,0.8,0.1) = dark_version
// Mix.002(ao_factor, dark_version, edge_mix) → Emission.003(1.0) = emission3
// Fresnel.001(1.45) × LayerWeight.002(Fresnel,0.61) → pow(0.5) = rim2_fac
// MixShader.002(rim2_fac, emission3, grey(0.1673))
// tex_color.r > 0.5 → Emission(0.1) = gate_emission
// AddShader(rim2_mixed + gate_emission) = npr_stack
// Principled(bc, roughness=0.3, specular=1.0, normal from noise bump)
// MixShader.001(0.2, principled, npr_stack)

@fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
  let alpha = material.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;
  let sun = light.lights[0].color.xyz * light.lights[0].color.w;

  let tex_color = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;
  let shadow = sampleShadow(input.worldPos, n);

  // ═══ 1. TOON MASK — DiffuseBSDF → ShaderToRGB → ramp.008 CONSTANT [0→black, 0.2966→white] ═══
  let ndotl_raw = shader_to_rgb_diffuse(n, l) * shadow;
  let toon = ramp_constant(ndotl_raw, 0.0, vec4f(0,0,0,1), 0.2966, vec4f(1,1,1,1)).r;

  // ═══ 2. TOON COLOR — chained HueSat nodes ═══
  // HueSat feeds into HueSat.002 (shadow path); HueSat.001 is the lit path from tex directly
  let base_tint = hue_sat(0.5, 1.2, 0.5, 1.0, tex_color);
  let adjusted_tint = hue_sat(0.48, 1.2, 0.7, 1.0, base_tint);
  let lit_tint = hue_sat(0.5, 1.5, 1.0, 1.0, tex_color);
  // Mix.004(Factor=toon, A=adjusted_tint, B=lit_tint)
  let toon_color = mix_blend(toon, adjusted_tint, lit_tint);
  let bc = bright_contrast(toon_color, 0.1, 0.2);

  // ═══ 3. BEVEL / EDGE DARKENING — Bevel.001→SeparateXYZ→Z approximated as n.z ═══
  let bevel_z = clamp(n.z, 0.0, 1.0);
  // Mix.003(Factor=bevel_z, A=bc, B=adjusted_tint)
  let edge_mix = mix_blend(bevel_z, bc, adjusted_tint);

  // ═══ 4. AO-GATED DARK VERSION ═══
  let ao = ao_fake(n, v);
  // ramp.001 CONSTANT [0→white, 0.3756→black]
  let ao_ramp = ramp_constant(ao, 0.0, vec4f(1,1,1,1), 0.3756, vec4f(0,0,0,1)).r;
  // Mix.001(Factor=ao_ramp, A=white, B=black) → mix(1,0,ao_ramp) = 1-ao_ramp
  let ao_factor = mix(1.0, 0.0, ao_ramp);
  // HueSat.004 darkens edge_mix heavily
  let dark_version = hue_sat(0.5, 0.8, 0.1, 1.0, edge_mix);
  // Mix.002(Factor=ao_factor, A=dark_version, B=edge_mix)
  let emission3_color = mix_blend(ao_factor, dark_version, edge_mix);

  // ═══ 5. EMISSION 3 — Emission.003(Strength=1.0) ═══
  let emission3 = emission3_color * 1.0;

  // ═══ 6. RIM 2 — Fresnel.001(1.45) × LayerWeight.002(Fresnel, 0.61) → pow(0.5) ═══
  let rim2_raw = fresnel(1.45, n, v) * layer_weight_fresnel(0.61, n, v);
  let rim2_fac = math_power(rim2_raw, 0.5);
  // MixShader.002(Fac=rim2_fac, Shader1=emission3, Shader2=Background(0.1673))
  let rim2_mixed = mix(emission3, vec3f(0.1673), rim2_fac);

  // ═══ 7. BRIGHT GATE — tex_color.r > 0.5 → Emission(Strength=0.1) ═══
  let tex_gate = math_greater_than(tex_color.r, 0.5);
  let gate_emission = vec3f(tex_gate) * 0.1;

  // ═══ 8. NPR STACK — AddShader(MixShader.002 + gate_emission) ═══
  let npr_stack = rim2_mixed + gate_emission;

  // ═══ 9. PRINCIPLED BSDF — base=bc, roughness=0.3, specular=1.0 ═══
  // Noise normal map: UV → Mapping.004(Scale=20,1.8,1) → TexNoise.002(scale=5,detail=2,roughness=0.5,distortion=0.1)
  let noise_uv = mapping_point(vec3f(input.uv, 0.0), vec3f(0.0), vec3f(0.0), vec3f(20.0, 1.8, 1.0));
  let noise_val = tex_noise(noise_uv, 5.0, 2.0, 0.5);
  // NormalMap(Strength=0.1) — approximate as bump since we lack tangent data
  let bumped_n = bump(0.1, noise_val, n, input.worldPos);

  let p_ndotl = max(dot(bumped_n, l), 0.0);
  let p_ndotv = max(dot(bumped_n, v), 0.001);
  let h = normalize(l + v);
  let p_ndoth = max(dot(bumped_n, h), 0.0);
  let p_vdoth = max(dot(v, h), 0.0);
  let a2 = HAIR_ROUGHNESS * HAIR_ROUGHNESS;
  let D = ggx_d_hair(p_ndoth, a2);
  let G = smith_g1_hair(p_ndotl, a2) * smith_g1_hair(p_ndotv, a2);
  let F = fresnel_schlick_hair(p_vdoth, F0_HAIR);
  let spec = (D * G * F) / max(4.0 * p_ndotl * p_ndotv, 0.001);
  // No emission contribution from Principled (Emission Strength=0.0)
  let kd = (1.0 - F) * bc / PI_H;
  let direct = (kd + spec) * sun * p_ndotl * shadow;
  let ambient = bc * light.ambientColor.xyz;
  let principled = ambient + direct;

  // ═══ 10. FINAL MIX — MixShader.001(Fac=0.2, first=Principled, second=NPR) ═══
  let final_color = mix(principled, npr_stack, 0.2);

  return vec4f(tonemap(final_color), alpha);
}

`
