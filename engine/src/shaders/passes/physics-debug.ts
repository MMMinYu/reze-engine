// Wireframe + solid overlay for physics rigid bodies (sphere / box / capsule).
// Rendered in its own pass after composite, straight to the swapchain — no
// MSAA, no depth, no MRT — so it sits cleanly on top of the tonemapped scene
// regardless of camera angle, model occlusion, or the composite alpha gate.
//
//   SHAPE_KIND   0 = sphere   → unit-sphere line/tri primitive scaled by size.x (radius)
//                1 = box      → unit cube ±1 scaled by size.xyz (half-extents)
//                2 = capsule  → unit cap+ring with per-vertex `axial` (-1/0/+1)
//                               that lifts cap rings/arcs ±halfHeight along Y;
//                               XZ scales by size.x (radius), Y by size.y/2.
//   SOLID_ALPHA  fragment alpha multiplier. Wireframe pipelines leave this at
//                1.0 for crisp edges; solid pipelines set it to ~0.2 so the fill
//                stays gentle under stacked bodies.

export const PHYSICS_DEBUG_SHADER_WGSL = /* wgsl */ `
struct CameraUniforms {
  view: mat4x4f,
  projection: mat4x4f,
  viewPos: vec3f,
  _pad: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;

override SHAPE_KIND: u32 = 0u;
override SOLID_ALPHA: f32 = 1.0;

struct VsIn {
  @location(0) unit: vec4f,       // xyz = unit pos; w = capsule axial anchor
  @location(1) modelCol0: vec4f,
  @location(2) modelCol1: vec4f,
  @location(3) modelCol2: vec4f,
  @location(4) modelCol3: vec4f,
  @location(5) size: vec4f,       // xyz = size; w unused
  @location(6) color: vec4f,
};

struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
};

@vertex
fn vsMain(in: VsIn) -> VsOut {
  let model = mat4x4f(in.modelCol0, in.modelCol1, in.modelCol2, in.modelCol3);
  var local: vec3f;
  if (SHAPE_KIND == 1u) {
    local = in.unit.xyz * in.size.xyz;
  } else if (SHAPE_KIND == 2u) {
    // PMX capsule: size.x = radius, size.y = full cylinder height. Bullet 2.x's
    // btCapsuleShape(radius, height) stores height/2 internally, so the actual
    // collision cylinder spans ±size.y/2 — halve here to match.
    let r = in.size.x;
    let halfH = in.size.y * 0.5;
    local = vec3f(in.unit.x * r, in.unit.y * r + halfH * in.unit.w, in.unit.z * r);
  } else {
    local = in.unit.xyz * in.size.x;
  }
  let world = model * vec4f(local, 1.0);
  var out: VsOut;
  out.pos = camera.projection * camera.view * world;
  out.color = in.color;
  return out;
}

@fragment
fn fsMain(in: VsOut) -> @location(0) vec4f {
  return vec4f(in.color.rgb, in.color.a * SOLID_ALPHA);
}
`
