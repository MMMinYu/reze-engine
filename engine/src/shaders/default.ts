// Blender 3.6 Principled BSDF defaults + Filmic "Medium High Contrast" tone mapping.
// Metallic=0, Specular=0.5 (F0=0.04), Roughness=0.5.
// Tone mapping via LUT sampled from Blender's OCIO pipeline (exposure -0.3 baked in).

export const DEFAULT_SHADER_WGSL = /* wgsl */ `

const PI: f32 = 3.141592653589793;
const F0_DIELECTRIC: f32 = 0.04;
const ROUGHNESS: f32 = 0.5;

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

// Per-material uniforms. Add fields here only when a shader actually reads them;
// preset-specific shaders (face.ts, future hair.ts) share this struct so the
// engine can use one material bind-group layout.
struct MaterialUniforms {
  diffuseColor: vec3f,  // tint; multiplies sampled albedo (unused by current fs, reserved)
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

// ─── GGX specular helpers ───────────────────────────────────────────

fn ggx_d(ndoth: f32, a2: f32) -> f32 {
  let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom);
}

fn smith_g1(ndotx: f32, a2: f32) -> f32 {
  return 2.0 * ndotx / (ndotx + sqrt(a2 + (1.0 - a2) * ndotx * ndotx));
}

fn fresnel_schlick(cosTheta: f32, f0: f32) -> f32 {
  return f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0);
}

// ─── Filmic tone mapping (LUT extracted from Blender 3.6 OCIO) ─────
// View transform = Filmic, Look = Medium High Contrast, Exposure = -0.3.
// 14 samples at integer log2 stops from -10 to +3 (inclusive).
// Extracted via scripts/extract_filmic_lut.py → probe image through scene
// color management. Input: linear scene-referred. Output: sRGB display.

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

// ─── Shadow sampling (3×3 PCF) ──────────────────────────────────────

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

// ─── Vertex / Fragment ──────────────────────────────────────────────

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

struct FSOut {
  @location(0) color: vec4f,
  @location(1) mask: f32,
};

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = material.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let albedo = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;

  let l = -light.lights[0].direction.xyz;
  let sunColor = light.lights[0].color.xyz * light.lights[0].color.w;
  let h = normalize(l + v);

  let ndotl = max(dot(n, l), 0.0);
  let ndotv = max(dot(n, v), 0.001);
  let ndoth = max(dot(n, h), 0.0);
  let vdoth = max(dot(v, h), 0.0);

  let a2 = ROUGHNESS * ROUGHNESS;
  let D = ggx_d(ndoth, a2);
  let G = smith_g1(ndotl, a2) * smith_g1(ndotv, a2);
  let F = fresnel_schlick(vdoth, F0_DIELECTRIC);
  let spec = (D * G * F) / max(4.0 * ndotl * ndotv, 0.001);

  let shadow = sampleShadow(input.worldPos, n);
  let kd = (1.0 - F) * albedo / PI;
  let direct = (kd + spec) * sunColor * ndotl * shadow;
  let ambient = albedo * light.ambientColor.xyz;

  var out: FSOut;
  out.color = vec4f(ambient + direct, alpha);
  out.mask = 1.0;
  return out;
}

`
