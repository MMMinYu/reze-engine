// M_Body material — hand-ported from Blender node graph trace.
// Facing-based rim2 with EASE ramp, no bright-texture gate, warm = toon+0.5.

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

const PI_B: f32 = 3.141592653589793;
const F0_BODY: f32 = 0.04;
const BODY_ROUGHNESS: f32 = 0.3;

fn ggx_d_body(ndoth: f32, a2: f32) -> f32 {
  let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (PI_B * denom * denom);
}

fn smith_g1_body(ndotx: f32, a2: f32) -> f32 {
  return 2.0 * ndotx / (ndotx + sqrt(a2 + (1.0 - a2) * ndotx * ndotx));
}

fn fresnel_schlick_body(cosTheta: f32, f0: f32) -> f32 {
  return f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0);
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

  let tex_color = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;
  let shadow = sampleShadow(input.worldPos, n);

  // ═══ TOON MASK: ShaderToRGB → ramp.008 CONSTANT [0→black, 0.2966→white] ═══
  let ndotl_raw = shader_to_rgb_diffuse(n, l) * shadow;
  let toon = ramp_constant(ndotl_raw, 0.0, vec4f(0,0,0,1), 0.2966, vec4f(1,1,1,1)).r;

  // ═══ TOON COLOR: HueSat shadow/lit → Mix.004 → BrightContrast ═══
  let shadow_tint = hue_sat(0.5, 2.0, 0.35, 1.0, tex_color);
  let lit_tint = hue_sat(0.5, 1.5, 1.0, 1.0, tex_color);
  let toon_color = mix_blend(toon, shadow_tint, lit_tint);
  let bc = bright_contrast(toon_color, 0.1, 0.2);

  // ═══ AO CHAIN: AO → ramp CONSTANT [0→white, 0.5995→black] → Mix.003 ═══
  let ao = ao_fake(n, v);
  let ao_ramp = ramp_constant(ao, 0.0, vec4f(1,1,1,1), 0.5995, vec4f(0,0,0,1)).r;
  let ao_mixed = mix_blend(ao_ramp, bc, vec3f(0.8302, 0.3346, 0.2795));

  // ═══ EMISSION.003 (strength=4.0) ═══
  let emission3 = ao_mixed * 4.0;

  // ═══ WARM EMISSION: AO-gated, body uses toon+0.5 directly (no *0.5) ═══
  let ao_inv = invert_f(1.0, ao_ramp);
  let warm_str = ao_inv * 0.5;
  let warm_input = clamp(toon + 0.5, 0.0, 1.0);
  let warm_color = ramp_cardinal(warm_input, 0.2409,
    vec4f(0.2426, 0.068, 0.0588, 1.0), 0.4663,
    vec4f(0.6677, 0.5024, 0.5126, 1.0)).rgb;
  let warm_emission = warm_color * warm_str;

  // ═══ RIM 1: Fresnel(2.0) × LayerWeight.Facing(0.24) ═══
  let rim1_str = fresnel(2.0, n, v) * layer_weight_facing(0.24, n, v);
  let rim1 = vec3f(0.9842, 0.611, 0.5736) * rim1_str;

  // ═══ RIM 2: Facing(0.2) → pow(0.5) → EASE ramp → MixShader ═══
  let facing_raw = layer_weight_facing(0.2, n, v);
  let facing_pow = math_power(facing_raw, 0.5);
  let rim2_ramp = ramp_ease(facing_pow, 0.0, vec4f(0,0,0,1), 0.5052, vec4f(1,1,1,1)).r;
  let rim2_mixed = mix(emission3, vec3f(1.0, 0.4304, 0.3316), rim2_ramp);

  // ═══ NPR STACK: AddShader chain (no bright gate in body) ═══
  let add0 = rim1 + rim2_mixed;
  let npr_stack = add0 + warm_emission;

  // ═══ PRINCIPLED BSDF: noise bump, GGX specular, SSS from AO ═══
  let gen = mapping_point(input.worldPos, vec3f(0.0), vec3f(0.0), vec3f(1.0, 1.0, 1.5));
  let noise_val = tex_noise(gen, 1.0, 2.0, 0.5);
  let noise_ramp = ramp_linear(noise_val, 0.0, vec4f(0,0,0,1), 1.0, vec4f(1,1,1,1)).r;
  let bumped_n = bump(0.3246, noise_ramp, n, input.worldPos);

  let principled_base = mix_blend(noise_ramp, bc, vec3f(0.6832, 0.1947, 0.1373));
  let p_emission = bc * 0.2;

  let ao2 = ao_fake(n, v);
  let sss = ramp_linear(ao2, 0.003, vec4f(0,0,0,1), 1.0, vec4f(0.0786, 0.0786, 0.0786, 1.0)).r;

  let p_ndotl = max(dot(bumped_n, l), 0.0);
  let p_ndotv = max(dot(bumped_n, v), 0.001);
  let h = normalize(l + v);
  let p_ndoth = max(dot(bumped_n, h), 0.0);
  let p_vdoth = max(dot(v, h), 0.0);
  let a2 = BODY_ROUGHNESS * BODY_ROUGHNESS;
  let D = ggx_d_body(p_ndoth, a2);
  let G = smith_g1_body(p_ndotl, a2) * smith_g1_body(p_ndotv, a2);
  let F = fresnel_schlick_body(p_vdoth, F0_BODY);
  let spec = (D * G * F) / max(4.0 * p_ndotl * p_ndotv, 0.001);
  let kd = (1.0 - F) * principled_base / PI_B;
  let direct = (kd + spec) * sun * p_ndotl * shadow;
  let ambient = principled_base * light.ambientColor.xyz;
  let principled = ambient + direct + p_emission + vec3f(sss);

  // ═══ FINAL: MixShader.001(Fac=0.5, Principled, NPR) ═══
  let final_color = mix(principled, npr_stack, 0.5);

  return vec4f(final_color, alpha);
}

`
