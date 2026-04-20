// EEVEE 3.6 bloom pyramid: blit (Karis prefilter) → 13-tap downsamples → 9-tap tent upsamples.
// Mirrors source/blender/draw/engines/eevee/shaders/effect_bloom_frag.glsl. Firefly suppression
// lives in the blit (Karis luminance-weighted 4-tap average). A single-pass Gaussian cannot
// reproduce this — hot pixels dominate and produce the sparkle halo.

const FULLSCREEN_VS = /* wgsl */ `
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32((vi & 1u) << 2u) - 1.0;
  let y = f32((vi & 2u) << 1u) - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}
`

// Full-res HDR → half-res. Karis 4-tap firefly average + EEVEE quadratic knee threshold + clamp.
export const BLOOM_BLIT_SHADER_WGSL = `${FULLSCREEN_VS}
@group(0) @binding(0) var hdrTex: texture_2d<f32>;
@group(0) @binding(1) var<uniform> prefilter: vec4<f32>; // threshold, knee, clamp, _unused
@group(0) @binding(2) var maskTex: texture_2d<f32>;

fn luminance(c: vec3f) -> f32 {
  return dot(max(c, vec3f(0.0)), vec3f(0.2126, 0.7152, 0.0722));
}
fn fetch(c: vec2<i32>, clampV: f32) -> vec3f {
  let d = vec2<i32>(textureDimensions(hdrTex));
  let cc = clamp(c, vec2<i32>(0), d - vec2<i32>(1));
  let s = textureLoad(hdrTex, cc, 0);
  // hdrTex is rg11b10ufloat (no alpha channel). Alpha lives in maskTex.g, written
  // alongside the bloom mask in .r by the scene pass. Scene uses src-alpha blend
  // with clear alpha 0 → hdr rgb is premultiplied; divide by the aux alpha to
  // recover straight color before the Karis luminance weighting.
  let aux = textureLoad(maskTex, cc, 0);
  let mask = aux.r;
  let rgb = max(s.rgb / max(aux.g, 1e-6), vec3f(0.0));
  let masked = rgb * mask;
  // Blender clamps each tap BEFORE Karis average (eevee_bloom: color = min(clampIntensity, color)).
  return select(masked, min(masked, vec3f(clampV)), clampV > 0.0);
}

@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let dst = vec2<i32>(p.xy - vec2f(0.5));
  let base = dst * 2;
  let clampV = prefilter.z;
  let a = fetch(base + vec2<i32>(0, 0), clampV);
  let b = fetch(base + vec2<i32>(1, 0), clampV);
  let c = fetch(base + vec2<i32>(0, 1), clampV);
  let d = fetch(base + vec2<i32>(1, 1), clampV);
  // Karis partial average: weight each tap by 1/(1+luma) — suppresses fireflies.
  let wa = 1.0 / (1.0 + luminance(a));
  let wb = 1.0 / (1.0 + luminance(b));
  let wc = 1.0 / (1.0 + luminance(c));
  let wd = 1.0 / (1.0 + luminance(d));
  let avg = (a * wa + b * wb + c * wc + d * wd) / max(wa + wb + wc + wd, 1e-6);
  // EEVEE quadratic threshold (brightness = max-channel, then soft-knee curve).
  let bright = max(avg.r, max(avg.g, avg.b));
  let soft = clamp(bright - prefilter.x + prefilter.y, 0.0, 2.0 * prefilter.y);
  let q = (soft * soft) / (4.0 * max(prefilter.y, 1e-4) + 1e-6);
  let contrib = max(q, bright - prefilter.x) / max(bright, 1e-4);
  return vec4f(max(avg * contrib, vec3f(0.0)), 1.0);
}
`

// Jimenez/COD 13-tap dual-box — 5 weighted 2×2 averages, rejects nyquist ringing.
export const BLOOM_DOWNSAMPLE_SHADER_WGSL = `${FULLSCREEN_VS}
@group(0) @binding(0) var srcTex: texture_2d<f32>;
@group(0) @binding(1) var srcSamp: sampler;

fn samp(uv: vec2f, off: vec2f) -> vec3f {
  return textureSampleLevel(srcTex, srcSamp, uv + off, 0.0).rgb;
}

@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let srcDims = vec2f(textureDimensions(srcTex));
  let t = 1.0 / srcDims;
  // fragCoord.xy reports pixel centers (e.g. 0.5,0.5 for first pixel) — divide by dst dims directly.
  let dstDims = srcDims * 0.5;
  let uv = p.xy / max(dstDims, vec2f(1.0));
  let A = samp(uv, t * vec2f(-2.0, -2.0));
  let B = samp(uv, t * vec2f( 0.0, -2.0));
  let C = samp(uv, t * vec2f( 2.0, -2.0));
  let D = samp(uv, t * vec2f(-1.0, -1.0));
  let E = samp(uv, t * vec2f( 1.0, -1.0));
  let F = samp(uv, t * vec2f(-2.0,  0.0));
  let G = samp(uv, t * vec2f( 0.0,  0.0));
  let H = samp(uv, t * vec2f( 2.0,  0.0));
  let I = samp(uv, t * vec2f(-1.0,  1.0));
  let J = samp(uv, t * vec2f( 1.0,  1.0));
  let K = samp(uv, t * vec2f(-2.0,  2.0));
  let L = samp(uv, t * vec2f( 0.0,  2.0));
  let M = samp(uv, t * vec2f( 2.0,  2.0));
  var o = (D + E + I + J) * (0.5 / 4.0);
  o = o + (A + B + G + F) * (0.125 / 4.0);
  o = o + (B + C + H + G) * (0.125 / 4.0);
  o = o + (F + G + L + K) * (0.125 / 4.0);
  o = o + (G + H + M + L) * (0.125 / 4.0);
  return vec4f(o, 1.0);
}
`

// 9-tap tent, progressively added to matching downsample mip. Blender radius = sample scale.
export const BLOOM_UPSAMPLE_SHADER_WGSL = `${FULLSCREEN_VS}
@group(0) @binding(0) var srcTex: texture_2d<f32>;   // coarser accumulator
@group(0) @binding(1) var baseTex: texture_2d<f32>;  // matching downsample mip
@group(0) @binding(2) var srcSamp: sampler;
@group(0) @binding(3) var<uniform> upU: vec4<f32>;   // sampleScale, _, _, _

@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let srcDims = vec2f(textureDimensions(srcTex));
  let baseDims = vec2f(textureDimensions(baseTex));
  let uv = p.xy / max(baseDims, vec2f(1.0));
  let t = upU.x / srcDims;
  var o = textureSampleLevel(srcTex, srcSamp, uv + t * vec2f(-1.0, -1.0), 0.0).rgb * 1.0;
  o = o + textureSampleLevel(srcTex, srcSamp, uv + t * vec2f( 0.0, -1.0), 0.0).rgb * 2.0;
  o = o + textureSampleLevel(srcTex, srcSamp, uv + t * vec2f( 1.0, -1.0), 0.0).rgb * 1.0;
  o = o + textureSampleLevel(srcTex, srcSamp, uv + t * vec2f(-1.0,  0.0), 0.0).rgb * 2.0;
  o = o + textureSampleLevel(srcTex, srcSamp, uv + t * vec2f( 0.0,  0.0), 0.0).rgb * 4.0;
  o = o + textureSampleLevel(srcTex, srcSamp, uv + t * vec2f( 1.0,  0.0), 0.0).rgb * 2.0;
  o = o + textureSampleLevel(srcTex, srcSamp, uv + t * vec2f(-1.0,  1.0), 0.0).rgb * 1.0;
  o = o + textureSampleLevel(srcTex, srcSamp, uv + t * vec2f( 0.0,  1.0), 0.0).rgb * 2.0;
  o = o + textureSampleLevel(srcTex, srcSamp, uv + t * vec2f( 1.0,  1.0), 0.0).rgb * 1.0;
  o = o * (1.0 / 16.0);
  let base = textureSampleLevel(baseTex, srcSamp, uv, 0.0).rgb;
  return vec4f(o + base, 1.0);
}
`
