// Composite: HDR scene + bloom pyramid → Filmic tone map → gamma → swapchain.
// Bloom tint/intensity applied at combine (EEVEE treats them as combine-stage params, not prefilter).

export const COMPOSITE_SHADER_WGSL = /* wgsl */ `
// Pipeline-override constant: the engine creates two composite pipelines, one
// with APPLY_GAMMA=false (gamma=1 fast path) and one with APPLY_GAMMA=true.
// The 'if (APPLY_GAMMA)' below is resolved at pipeline-compile time — the
// dead branch is dropped by the shader compiler (no runtime branch, no pow
// invocation on Safari's Metal backend in the common case).
override APPLY_GAMMA: bool = true;

@group(0) @binding(0) var hdrTex: texture_2d<f32>;
@group(0) @binding(1) var bloomTex: texture_2d<f32>;   // bloomUpTexture mip 0 (full pyramid top)
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

fn filmic(x: f32) -> f32 {
  // Re-fit against Blender 3.6 Filmic MHC anchors (sobotka/filmic-blender
  // look_medium-high-contrast.spi1d). Previous curve was compressed:
  // midtones too bright, highlights too dim — flattened contrast, read
  // as "washed-out" on saturated surfaces (hair especially).
  // Reference checkpoints: linear 0.18 → ~0.395, linear 1.0 → ~0.83.
  var lut = array<f32, 14>(
    0.0028, 0.0068, 0.0151, 0.0313, 0.0610, 0.1120, 0.1920,
    0.3060, 0.4590, 0.6310, 0.8200, 0.9070, 0.9620, 0.9890
  );
  let t = clamp(log2(max(x, 1e-10)) + 10.0, 0.0, 13.0);
  let i = u32(t);
  let j = min(i + 1u, 13u);
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
