// Linear mipmap generation via bilinear box filter. Reads srgb view — hardware linearizes
// on sample and re-encodes on write, so intensities are filtered in linear space (matches EEVEE).

export const MIPMAP_BLIT_SHADER_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
@vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32((vi & 1u) << 2u) - 1.0;
  let y = f32((vi & 2u) << 1u) - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}
@fragment fn fs(@builtin(position) p: vec4f) -> @location(0) vec4f {
  let dstDims = vec2f(textureDimensions(src)) * 0.5;
  let uv = p.xy / max(dstDims, vec2f(1.0));
  return textureSampleLevel(src, samp, uv, 0.0);
}
`
