// Transform gizmo — 3 translation axes + 3 rotation rings, drawn as thick
// ribbons. Per-segment perpendicular (no miter) → the "tick" look at each ring
// vertex is intentional.
//
// axisT per-vertex: 0 at the bone origin, 1 at the axis tip. For ring verts it
// is set to -1 as a "not an axis" flag. The FS uses axisT to:
//   • fade + dash the inside-ring portion of each axis (not hittable, so the
//     user can tell to only grab the outer stub for translation).
//   • leave rings and the outer axis stub fully solid with only the edge-to-
//     center alpha falloff.

export const GIZMO_SHADER_WGSL = /* wgsl */ `
struct CameraUniforms { view: mat4x4f, projection: mat4x4f, viewPos: vec3f, _pad: f32 };
struct Transform {
  model: mat4x4f,
  viewport: vec2f,
  thicknessPx: f32,
  _pad: f32,
};
struct Color { rgba: vec4f };

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> transform: Transform;
@group(1) @binding(0) var<uniform> col: Color;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) side: f32,
  @location(1) axisT: f32,
}

@vertex fn vs(
  @location(0) position: vec3f,
  @location(1) segDir: vec3f,
  @location(2) side: f32,
  @location(3) axisT: f32,
) -> VSOut {
  let vp = camera.projection * camera.view * transform.model;
  let c0 = vp * vec4f(position, 1.0);
  let c1 = vp * vec4f(position + segDir, 1.0);
  let w0 = max(abs(c0.w), 1e-6);
  let w1 = max(abs(c1.w), 1e-6);
  let s0 = (c0.xy / w0) * 0.5 * transform.viewport;
  let s1 = (c1.xy / w1) * 0.5 * transform.viewport;
  let tangent = normalize(s1 - s0);
  let normalPx = vec2f(-tangent.y, tangent.x);
  // Axes render thinner than rings. axisT < 0 → ring (full thickness); else → axis (reduced).
  let thicknessMul = select(0.60, 1.0, axisT < 0.0);
  let offsetPx = normalPx * side * transform.thicknessPx * 0.5 * thicknessMul;
  let offsetClip = (offsetPx / (0.5 * transform.viewport)) * c0.w;
  var out: VSOut;
  out.pos = vec4f(c0.xy + offsetClip, c0.z, c0.w);
  out.side = side;
  out.axisT = axisT;
  return out;
}

@fragment fn fs(in: VSOut) -> @location(0) vec4f {
  // Center-bright, edges fade. abs(side) is 0 at ribbon center, 1 at ribbon edges.
  let edge = 1.0 - smoothstep(0.55, 1.0, abs(in.side));
  var alpha = col.rgba.a * edge;

  // Dash + dim the inside-ring portion of axes. axisT is -1 for ring fragments,
  // 0..1 along axes (0 at bone center, 1 at axis tip). Boundary 0.63 ≈ where the
  // hit zone starts (ring radius 0.8 + 0.05 margin, over axis length 1.35).
  let isInsideRingAxis = in.axisT >= 0.0 && in.axisT < 0.63;
  if (isInsideRingAxis) {
    // ~8 dash cycles inside the ring — readable without feeling busy.
    let phase = fract(in.axisT * 12.0);
    if (phase > 0.55) { discard; }
    alpha = alpha * 0.40;
  }

  return vec4f(col.rgba.rgb, alpha);
}
`
