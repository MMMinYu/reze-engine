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

// OCIO Filmic + High Contrast 256-point LUT (extracted from Blender 5.0).
// Pipeline: linear → Filmic Log [0,1] → look(HC: hc∘base_inv) → base_curve → sRGB display.
// Index maps log2(linear) from [-10, 4] → [0, 255] (14 stops).
fn filmic(x: f32) -> f32 {
  var lut = array<f32, 256>(
    0.000000, 0.000050, 0.000108, 0.000175, 0.000248, 0.000329, 0.000415, 0.000508, 0.000608, 0.000713, 0.000825, 0.000943, 0.001068, 0.001198, 0.001336, 0.001480,
    0.001630, 0.001788, 0.001953, 0.002125, 0.002304, 0.002492, 0.002687, 0.002891, 0.003103, 0.003324, 0.003554, 0.003794, 0.004043, 0.004303, 0.004573, 0.004854,
    0.005146, 0.005450, 0.005766, 0.006094, 0.006436, 0.006792, 0.007161, 0.007546, 0.007945, 0.008361, 0.008793, 0.009242, 0.009710, 0.010196, 0.010701, 0.011226,
    0.011773, 0.012341, 0.012932, 0.013546, 0.014186, 0.014850, 0.015542, 0.016261, 0.017009, 0.017787, 0.018597, 0.019439, 0.020315, 0.021226, 0.022174, 0.023160,
    0.024186, 0.025253, 0.026363, 0.027518, 0.028719, 0.029969, 0.031269, 0.032621, 0.034027, 0.035490, 0.037012, 0.038594, 0.040240, 0.041951, 0.043730, 0.045580,
    0.047503, 0.049503, 0.051581, 0.053741, 0.055985, 0.058318, 0.060741, 0.063257, 0.065871, 0.068585, 0.071403, 0.074328, 0.077364, 0.080513, 0.083780, 0.087169,
    0.090682, 0.094323, 0.098097, 0.102006, 0.106054, 0.110246, 0.114584, 0.119072, 0.123714, 0.128513, 0.133473, 0.138596, 0.143886, 0.149346, 0.154979, 0.160787,
    0.166774, 0.172941, 0.179290, 0.185824, 0.192543, 0.199450, 0.206545, 0.213829, 0.221303, 0.228966, 0.236818, 0.244857, 0.253084, 0.261496, 0.270091, 0.278866,
    0.287873, 0.297111, 0.306522, 0.316103, 0.325848, 0.335752, 0.345808, 0.356009, 0.366349, 0.376820, 0.387413, 0.398121, 0.408933, 0.419842, 0.430837, 0.441909,
    0.453046, 0.464239, 0.475477, 0.486749, 0.498044, 0.509222, 0.520375, 0.531516, 0.542637, 0.553726, 0.564772, 0.575765, 0.586694, 0.597550, 0.608323, 0.619003,
    0.629580, 0.640048, 0.650396, 0.660618, 0.670705, 0.680651, 0.690449, 0.700093, 0.709578, 0.718898, 0.728049, 0.737027, 0.745827, 0.754448, 0.762886, 0.771139,
    0.779205, 0.787084, 0.794773, 0.802272, 0.809582, 0.816702, 0.823633, 0.830376, 0.836931, 0.843301, 0.849488, 0.855492, 0.861316, 0.866963, 0.872435, 0.877735,
    0.882865, 0.887829, 0.892630, 0.897271, 0.901755, 0.906085, 0.910266, 0.914300, 0.918192, 0.921944, 0.925560, 0.929043, 0.932398, 0.935628, 0.938735, 0.941725,
    0.944599, 0.947362, 0.950017, 0.952567, 0.955015, 0.957366, 0.959621, 0.961783, 0.963857, 0.965845, 0.967749, 0.969573, 0.971319, 0.972990, 0.974589, 0.976119,
    0.977581, 0.978978, 0.980312, 0.981586, 0.982802, 0.983963, 0.985069, 0.986124, 0.987128, 0.988085, 0.988996, 0.989862, 0.990686, 0.991469, 0.992212, 0.992918,
    0.993587, 0.994220, 0.994821, 0.995389, 0.995925, 0.996432, 0.996909, 0.997359, 0.997782, 0.998178, 0.998548, 0.998893, 0.999212, 0.999506, 0.999770, 1.000000,
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
