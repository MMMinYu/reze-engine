// Hand-ported M_Smooth_Cloth material shader.
// Traced from m_graphs.json (M_Smooth_Cloth node graph).

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

const PI_C: f32 = 3.141592653589793;
const F0_CLOTH: f32 = 0.064; // Specular=0.8 → F0 = 0.08 * 0.8
const CLOTH_ROUGHNESS: f32 = 0.5;

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

// ─── Fragment: M_Smooth_Cloth NPR pipeline ──────────────────────────
// Signal flow:
//   tex_color → HueSat.002(V=0.2) = dark_tex
//   DiffuseBSDF(white) → ShaderToRGB → ramp.008 CONSTANT [0→black,0.2966→white] = toon
//   toon*0.5 → Mix.004(Factor, A=dark_tex, B=tex_color) = toon_mix
//   Bevel.Z → Mix.003(Factor=bevel_z, A=toon_mix, B=dark_tex) = edge_mixed
//   edge_mixed → HueSat.004(S=0.8,V=2.0) = bright_version
//   AO → ramp.001 LINEAR [0→white,0.8808→black] → ao_factor
//   Mix.002 OVERLAY(ao_factor, A=edge_mixed, B=bright_version) = npr_color
//   Emission.005(npr_color, Strength=18.2)
//   Principled: base=HueSat(V=0.8) on tex_color, roughness=0.5, specular=0.8, no bump, no emission
//   MixShader.001(Fac=0.9, First=Emission.005, Second=Principled) → OUTPUT
//   = 10% NPR emission + 90% Principled

@fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
  let alpha = material.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;
  let sun = light.lights[0].color.xyz * light.lights[0].color.w;

  let tex_color = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;
  let shadow = sampleShadow(input.worldPos, n);

  // ═══ 1. TOON MASK ═══
  let ndotl_raw = shader_to_rgb_diffuse(n, l) * shadow;
  let toon = ramp_constant(ndotl_raw, 0.0, vec4f(0,0,0,1), 0.2966, vec4f(1,1,1,1)).r;

  // ═══ 2. TOON COLOR ═══
  let dark_tex = hue_sat(0.5, 1.0, 0.2, 1.0, tex_color); // HueSat.002 — very dark variant
  let toon_fac = toon * 0.5; // 运算.004(MULTIPLY, default=0.5)
  let toon_mix = mix_blend(toon_fac, dark_tex, tex_color); // Mix.004: A=dark, B=original

  // ═══ 3. BEVEL / EDGE MIX ═══
  let bevel_z = clamp(n.z, 0.0, 1.0); // approximate bevel normal Z with geometric normal
  let edge_mixed = mix_blend(bevel_z, toon_mix, dark_tex); // Mix.003: A=toon_mix, B=dark_tex

  // ═══ 4. BRIGHT VERSION ═══
  let bright_version = hue_sat(0.5, 0.8, 2.0, 1.0, edge_mixed); // HueSat.004 — boosted value

  // ═══ 5. AO GATING ═══
  let ao = ao_fake(n, v);
  let ao_ramp = ramp_linear(ao, 0.0, vec4f(1,1,1,1), 0.8808, vec4f(0,0,0,1)).r; // ramp.001 LINEAR [0→white, 0.8808→black]
  let ao_factor = mix(1.0, 0.0, ao_ramp); // Mix.001: A=white(1.0), B=black(0.0)

  // ═══ 6. NPR COLOR (OVERLAY blend) ═══
  let npr_color = mix_overlay(ao_factor, edge_mixed, bright_version); // Mix.002 OVERLAY

  // ═══ 7. NPR EMISSION ═══
  let npr_emission = npr_color * 18.2; // Emission.005(Strength=18.2)

  // ═══ 8. PRINCIPLED BSDF (no bump, no emission) ═══
  let principled_base = hue_sat(0.5, 1.0, 0.8, 1.0, tex_color); // HueSat(V=0.8) — slightly dimmer

  let p_ndotl = max(dot(n, l), 0.0);
  let p_ndotv = max(dot(n, v), 0.001);
  let h = normalize(l + v);
  let p_ndoth = max(dot(n, h), 0.0);
  let p_vdoth = max(dot(v, h), 0.0);
  let a2 = CLOTH_ROUGHNESS * CLOTH_ROUGHNESS;
  let D = ggx_d_cloth(p_ndoth, a2);
  let G = smith_g1_cloth(p_ndotl, a2) * smith_g1_cloth(p_ndotv, a2);
  let F = fresnel_schlick_cloth(p_vdoth, F0_CLOTH);
  let spec = (D * G * F) / max(4.0 * p_ndotl * p_ndotv, 0.001);
  let kd = (1.0 - F) * principled_base / PI_C;
  let direct = (kd + spec) * sun * p_ndotl * shadow;
  let ambient = principled_base * light.ambientColor.xyz;
  let principled = ambient + direct; // no emission contribution (strength=0)

  // ═══ 9. FINAL MIX ═══
  // MixShader.001(Fac=0.9, First=NPR_emission, Second=Principled)
  // Blender: (1-Fac)*First + Fac*Second = 0.1*NPR_emission + 0.9*Principled
  let final_color = mix(npr_emission, principled, 0.9);

  return vec4f(tonemap(final_color), alpha);
}

`
