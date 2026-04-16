// Hand-ported M_Face material shader.
// Traced from M_Face.json Blender node graph with hardcoded parameters.

import { NODES_WGSL } from "./nodes"

export const FACE_SHADER_WGSL = /* wgsl */ `

${NODES_WGSL}

// ─── Shared structs & bindings (same layout as engine) ──────────────

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

// Per-material uniforms — shared struct matching default.ts so the engine
// can bind a single material layout for every preset pipeline.
struct MaterialUniforms {
  diffuseColor: vec3f,  // tint; multiplies sampled albedo (unused by face fs, reserved)
  alpha: f32,            // 0 → discard; <1 → transparent draw call
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

// ─── Vertex (identical to current engine VS) ────────────────────────

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

// ─── Fragment: M_Face NPR pipeline ──────────────────────────────────
//
// Signal flow (from M_Face.json graph):
//   1. Toon shadow — DiffuseBSDF → ShaderToRGB → constant ramp @ 0.297
//   2. Color tinting — face tex → lit HueSat + shadow HueSat → mix by toon
//   3. Brightness/contrast post-process
//   4. AO modulation (faked as 1.0, no darkening)
//   5. Fresnel rim emissions (2 layers, stacked via add)
//   6. AO-gated emission for warm skin tones
//   7. Principled BSDF with noise bump for subtle surface breakup
//   8. Final 50/50 mix of Principled vs NPR emission stack

@fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
  let alpha = material.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;
  let intensity = light.lights[0].color.w;
  let sun = light.lights[0].color.xyz * intensity;

  let tex_color = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;

  // ═══ 1. TOON SHADOW ═══
  // ShaderToRGB on white diffuse BSDF = raw N·L
  let ndotl = shader_to_rgb_diffuse(n, l);
  // Constant ramp: black below 0.297, white above → binary toon mask
  let toon = ramp_constant(ndotl, 0.0, vec4f(0,0,0,1), 0.2966, vec4f(1,1,1,1)).r;

  // ═══ 2. SHADOW/LIT COLOR TINTING ═══
  let lit_tint = hue_sat(0.46, 1.6, 1.5, 1.0, tex_color);
  let shadow_tint = hue_sat(0.46, 2.0, 0.35, 1.0, tex_color);
  // toon=0 → A (shadow), toon=1 → B (lit)
  let toon_color = mix_blend(toon, shadow_tint, lit_tint);

  // ═══ 3. BRIGHTNESS / CONTRAST ═══
  let bc = bright_contrast(toon_color, 0.1, 0.2);

  // ═══ 4. AO MODULATION (faked) ═══
  let ao = ao_fake(n, v);
  let ao_ramp = ramp_constant(ao, 0.0, vec4f(1,1,1,1), 0.5995, vec4f(0,0,0,1)).r;
  // mix.003: factor=ao_ramp, A=bc, B=warm fallback (0.830, 0.335, 0.279)
  let ao_mixed = mix_blend(ao_ramp, bc, vec3f(0.830, 0.335, 0.279));
  // With ao_fake=1.0, ao_ramp=0 → ao_mixed = bc (no effect, as expected)

  // ═══ 5. EMISSION 3: main lit face emission ═══
  // Color from AO-mixed base, strength 2.5
  let emission3 = ao_mixed * 2.5;

  // ═══ 6. FRESNEL RIM LAYER 1 ═══
  // 运算: fresnel(IOR=2) × layer_weight_facing(blend=0.24)
  let rim1 = fresnel(2.0, n, v) * layer_weight_facing(0.24, n, v);
  // Feeds emission.Strength with warm color (0.984, 0.611, 0.574)
  let emission_rim1_color = vec3f(0.984, 0.611, 0.574) * rim1;

  // ═══ 7. FRESNEL RIM LAYER 2 ═══
  // 运算.003: fresnel(IOR=1.45) × layer_weight_fresnel(blend=0.61)
  // 运算.007: pow(product, 0.63)
  let rim2_raw = fresnel(1.45, n, v) * layer_weight_fresnel(0.61, n, v);
  let rim2 = math_power(rim2_raw, 0.63);
  // MixShader.002: mix(rim2, emission3, background(1.0, 0.469, 0.370))
  let background_color = vec3f(1.0, 0.469, 0.370);
  let rim2_mixed = mix(emission3, background_color, rim2);

  // ═══ 8. AO-GATED WARM EMISSION ═══
  let ao_inv = 1.0 - ao_ramp;
  let ao_emission_str = ao_inv * 0.3;
  // Toon → ramp.009: warm skin tones
  let warm_ramp = ramp_constant(toon, 0.0,
    vec4f(1.0, 0.217, 0.114, 1.0), 0.275,
    vec4f(1.0, 0.653, 0.588, 1.0)).rgb;
  let emission1 = warm_ramp * ao_emission_str;

  // ═══ 9. STACKED EMISSIONS (AddShader chain) ═══
  // AddShader.002 = rim2_mixed + emission.002
  // emission.002: color from darkened tex (greater_than gate), strength 3.0
  let dark_tex = hue_sat(0.5, 1.0, 0.5, 1.0, tex_color);
  let dark_tex2 = hue_sat(0.48, 1.0, 0.5, 1.0, dark_tex);
  let tex_bright = math_greater_than(dark_tex2.r, 0.93);
  let emission2 = vec3f(tex_bright) * 3.0;
  let add2 = rim2_mixed + emission2;

  // AddShader = emission_rim1 + add2
  let add0 = emission_rim1_color + add2;
  // AddShader.001 = emission1 (AO-gated warm) + add0
  let npr_stack = emission1 + add0;

  // ═══ 10. PRINCIPLED BSDF (simplified) ═══
  // Noise bump for subtle surface texture
  let gen = mapping_point(input.worldPos, vec3f(0.0), vec3f(0.0), vec3f(1.0, 1.0, 1.5));
  let noise_val = tex_noise(gen, 1.0, 2.0, 0.5);
  let noise_ramp = ramp_linear(noise_val, 0.0, vec4f(0,0,0,1), 1.0, vec4f(1,1,1,1)).r;
  let bumped_n = bump(0.325, noise_ramp, n, input.worldPos);

  // Base color: mix(noise_ramp, bright_contrast, dark_default)
  let principled_base = mix_blend(noise_ramp, bc, vec3f(0.683, 0.195, 0.137));
  // Diffuse term with bumped normal
  let p_ndotl = max(dot(bumped_n, l), 0.0);
  let p_diffuse = principled_base * (light.ambientColor.xyz + sun * p_ndotl);

  // Specular (GGX-like, roughness 0.3)
  let h = normalize(l + v);
  let p_ndoth = max(dot(bumped_n, h), 0.0);
  let p_spec = pow(p_ndoth, 1.0 / max(0.3 * 0.3, 0.001)) * 0.04;

  // Emission from the bright base, strength 0.2
  let p_emission = bc * 0.2;

  // Subsurface from AO (faked: ramp.005 LINEAR (0.003→black, 1.0→0.079))
  let sss_factor = ramp_linear(ao, 0.003, vec4f(0,0,0,1), 1.0, vec4f(0.079, 0.079, 0.079, 1.0)).r;
  let principled = p_diffuse + vec3f(p_spec) * sun + p_emission + vec3f(sss_factor);

  // ═══ 11. FINAL MIX ═══
  // MixShader.001: 50/50 blend of Principled and NPR emission stack
  let final_color = mix(principled, npr_stack, 0.5);

  return vec4f(final_color, alpha);
}

`
