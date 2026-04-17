// Eye preset — default Principled BSDF (F0=0.04, Roughness=0.5) + Emission socket set to albedo × 1.5.
// Matches the published preset's instruction: "keep eyes in the default nodegraph, add emission 1.5".
// Blender's Principled BSDF Emission socket is added on top of the shaded output (pre-tonemap, feeds bloom).

export const EYE_SHADER_WGSL = /* wgsl */ `

const PI: f32 = 3.141592653589793;
const F0_DIELECTRIC: f32 = 0.04;
const ROUGHNESS: f32 = 0.5;
const EYE_EMISSION_STRENGTH: f32 = 1.5;

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

fn ggx_d(ndoth: f32, a2: f32) -> f32 {
  let denom = ndoth * ndoth * (a2 - 1.0) + 1.0;
  return a2 / (PI * denom * denom);
}

fn smith_g1(ndotx: f32, a2: f32) -> f32 {
  return 2.0 * ndotx / (ndotx + sqrt(a2 + (1.0 - a2) * ndotx * ndotx));
}

fn fresnel_schlick(cosTheta: f32, f0: f32) -> f32 {
  let m = 1.0 - cosTheta;
  let m2 = m * m;
  return f0 + (1.0 - f0) * (m2 * m2 * m);
}

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

  // Principled Emission socket: emissive = emission_color × strength, added on top of shading.
  let emission = albedo * EYE_EMISSION_STRENGTH;

  var out: FSOut;
  out.color = vec4f(ambient + direct + emission, alpha);
  out.mask = 1.0;
  return out;
}

`
