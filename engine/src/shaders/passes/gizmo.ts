// Transform gizmo overlay — 3 translation axes + 3 rotation rings drawn at the
// selected bone's world position. World-aligned (not bone-local) for now. Depth-
// always so the gizmo always renders on top; alpha-blended over the composite
// output. Shared per-frame transform (group 0) + per-draw color (group 1) keeps
// the six draw calls minimal.

export const GIZMO_SHADER_WGSL = /* wgsl */ `
struct CameraUniforms { view: mat4x4f, projection: mat4x4f, viewPos: vec3f, _pad: f32 };
struct Transform { model: mat4x4f };
struct Color { rgba: vec4f };

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> transform: Transform;
@group(1) @binding(0) var<uniform> col: Color;

@vertex fn vs(@location(0) position: vec3f) -> @builtin(position) vec4f {
  return camera.projection * camera.view * transform.model * vec4f(position, 1.0);
}

@fragment fn fs() -> @location(0) vec4f { return col.rgba; }
`
