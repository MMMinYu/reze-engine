// Composite: HDR scene + bloom pyramid → Filmic tone map → gamma → swapchain.
// Bloom tint/intensity applied at combine (EEVEE treats them as combine-stage params, not prefilter).

export const COMPOSITE_SHADER_WGSL = /* wgsl */ `
// Pipeline-override constant: the engine creates two composite pipelines, one
// with APPLY_GAMMA=false (gamma=1 fast path) and one with APPLY_GAMMA=true.
// The 'if (APPLY_GAMMA)' below is resolved at pipeline-compile time — the
// dead branch is dropped by the shader compiler (no runtime branch, no pow
// invocation on Safari's Metal backend in the common case).
override APPLY_GAMMA: bool = true;

// Pipeline-override constant for filmic mode:
//   FILMIC_MODE=0 → Filmic (medium contrast, default)
//   FILMIC_MODE=1 → Filmic + High Contrast (StarRail MHC)
override FILMIC_MODE: f32 = 0.0;

@group(0) @binding(0) var hdrTex: texture_2d<f32>;
@group(0) @binding(1) var bloomTex: texture_2d<f32>;
@group(0) @binding(2) var bloomSamp: sampler;
@group(0) @binding(3) var<uniform> viewU: array<vec4<f32>, 2>;
// Aux mask/alpha texture. .r = bloom mask (unused here; bloom blit uses it).
// .g = accumulated canvas alpha (what hdr.a carried before the HDR format
// became rg11b10ufloat). We unpremultiply HDR by this alpha for tonemap, then
// re-premultiply the tonemapped color for output so the premultiplied canvas
// alphaMode composites the WebGPU surface over the page background correctly.
@group(0) @binding(4) var maskTex: texture_2d<f32>;
// viewU[0] = (exposure, invGamma, _, _);  viewU[1] = (tint.rgb, intensity)
// invGamma = 1/gamma precomputed on CPU — avoids a per-pixel divide.

// OCIO Filmic + High Contrast 256-point LUT (extracted from Blender 5.0 via OCIO 2.4 API).
// Pipeline: scene_linear → reference → Filmic Log → look(HC) → reference → Filmic view → sRGB display.
// Index maps log2(linear) from [-10, 4] → [0, 255] (14 stops).
fn filmic(x: f32) -> f32 {
  var lut = array<f32, 256>(
    0.004462, 0.004671, 0.004888, 0.005113, 0.005346, 0.005589, 0.005840, 0.006101, 0.006372, 0.006653, 0.006945, 0.007248, 0.007562, 0.007889, 0.008227, 0.008578,
    0.008943, 0.009321, 0.009713, 0.010121, 0.010543, 0.010981, 0.011436, 0.011908, 0.012398, 0.012905, 0.013432, 0.013979, 0.014545, 0.015133, 0.015743, 0.016376,
    0.017032, 0.017712, 0.018417, 0.019149, 0.019907, 0.020694, 0.021509, 0.022354, 0.023231, 0.024140, 0.025081, 0.026057, 0.027068, 0.028117, 0.029203, 0.030328,
    0.031494, 0.032703, 0.033954, 0.035251, 0.036593, 0.037983, 0.039423, 0.040914, 0.042457, 0.044055, 0.045709, 0.047420, 0.049192, 0.051024, 0.052920, 0.054880,
    0.056908, 0.059006, 0.061175, 0.063417, 0.065735, 0.068130, 0.070604, 0.073160, 0.075800, 0.078528, 0.081343, 0.084249, 0.087249, 0.090345, 0.093539, 0.096832,
    0.100228, 0.103728, 0.107336, 0.111053, 0.114883, 0.118827, 0.122888, 0.127068, 0.131367, 0.135788, 0.140334, 0.145010, 0.149812, 0.154745, 0.159812, 0.165013,
    0.170349, 0.175822, 0.181432, 0.187182, 0.193072, 0.199104, 0.205278, 0.211595, 0.218056, 0.224659, 0.231404, 0.238290, 0.245318, 0.252490, 0.259801, 0.267250,
    0.274839, 0.282564, 0.290422, 0.298411, 0.306529, 0.314772, 0.323138, 0.331624, 0.340227, 0.348943, 0.357767, 0.366695, 0.375721, 0.384839, 0.394045, 0.403336,
    0.412705, 0.422144, 0.431650, 0.441217, 0.450836, 0.460500, 0.470204, 0.479939, 0.489699, 0.499479, 0.509252, 0.519030, 0.528806, 0.538572, 0.548321, 0.558043,
    0.567733, 0.577387, 0.586999, 0.596555, 0.606056, 0.615493, 0.624859, 0.634148, 0.643353, 0.652469, 0.661491, 0.670414, 0.679234, 0.687946, 0.696545, 0.705028,
    0.713389, 0.721624, 0.729730, 0.737704, 0.745550, 0.753253, 0.760820, 0.768248, 0.775534, 0.782675, 0.789671, 0.796521, 0.803223, 0.809779, 0.816189, 0.822451,
    0.828567, 0.834537, 0.840361, 0.846038, 0.851571, 0.856960, 0.862210, 0.867317, 0.872285, 0.877117, 0.881814, 0.886376, 0.890806, 0.895106, 0.899278, 0.903324,
    0.907248, 0.911050, 0.914734, 0.918301, 0.921755, 0.925095, 0.928327, 0.931451, 0.934471, 0.937389, 0.940208, 0.942929, 0.945556, 0.948091, 0.950535, 0.952891,
    0.955162, 0.957349, 0.959456, 0.961485, 0.963437, 0.965315, 0.967121, 0.968857, 0.970524, 0.972126, 0.973664, 0.975140, 0.976555, 0.977913, 0.979214, 0.980461,
    0.981654, 0.982796, 0.983888, 0.984933, 0.985930, 0.986883, 0.987792, 0.988659, 0.989486, 0.990273, 0.991022, 0.991734, 0.992410, 0.993053, 0.993662, 0.994239,
    0.994785, 0.995301, 0.995789, 0.996248, 0.996681, 0.997088, 0.997470, 0.997827, 0.998161, 0.998473, 0.998763, 0.999033, 0.999282, 0.999511, 0.999722, 0.999915,
  );
  let t = clamp((log2(max(x, 1e-10)) + 10.0) * (255.0 / 14.0), 0.0, 255.0);
  let i = u32(t);
  let j = min(i + 1u, 255u);
  return mix(lut[i], lut[j], t - f32(i));
}

@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32((vi & 1u) << 2u) - 1.0;
  let y = f32((vi & 2u) << 1u) - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

@fragment fn fs(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  let coord = vec2<i32>(fragCoord.xy);
  let hdr = textureLoad(hdrTex, coord, 0);
  let alpha = textureLoad(maskTex, coord, 0).g;
  let a = max(alpha, 1e-6);
  let straight = hdr.rgb / a;
  let fullSz = vec2f(textureDimensions(hdrTex));
  // Bloom is at half-res (pyramid mip 0). Sampler interpolates back to full-res UVs.
  // fragCoord.xy is already at pixel center (e.g. 0.5, 0.5 for first pixel).
  let bloomUv = fragCoord.xy / max(fullSz, vec2f(1.0));
  let tint = viewU[1].xyz;
  let intensity = viewU[1].w;
  let bloom = textureSampleLevel(bloomTex, bloomSamp, bloomUv, 0.0).rgb * tint * intensity;
  let combined = straight + bloom;
  let exposed = combined * exp2(viewU[0].x);
  let tm = vec3f(filmic(exposed.r), filmic(exposed.g), filmic(exposed.b));
  var disp = max(tm, vec3f(0.0));
  if (APPLY_GAMMA) {
    disp = pow(disp, vec3f(viewU[0].y));
  }
  return vec4f(disp * alpha, alpha);
}
`
