// MMD-style screen-space outline via normal-extrusion in clip space.
// Aspect-compensated so pixel thickness stays stable across viewport sizes.

export const OUTLINE_SHADER_WGSL = /* wgsl */ `
struct CameraUniforms {
  view: mat4x4f,
  projection: mat4x4f,
  viewPos: vec3f,
  _padding: f32,
};

struct MaterialUniforms {
  edgeColor: vec4f,
  edgeSize: f32,
  _padding1: f32,
  _padding2: f32,
  _padding3: f32,
};

@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(1) @binding(0) var<storage, read> skinMats: array<mat4x4f>;
@group(2) @binding(0) var<uniform> material: MaterialUniforms;

struct VertexOutput {
  @builtin(position) position: vec4f,
};

@vertex fn vs(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(3) joints0: vec4<u32>,
  @location(4) weights0: vec4<f32>
) -> VertexOutput {
  var output: VertexOutput;
  let pos4 = vec4f(position, 1.0);

  let weightSum = weights0.x + weights0.y + weights0.z + weights0.w;
  let invWeightSum = select(1.0, 1.0 / weightSum, weightSum > 0.0001);
  let normalizedWeights = select(vec4f(1.0, 0.0, 0.0, 0.0), weights0 * invWeightSum, weightSum > 0.0001);

  var skinnedPos = vec4f(0.0, 0.0, 0.0, 0.0);
  var skinnedNrm = vec3f(0.0, 0.0, 0.0);
  for (var i = 0u; i < 4u; i++) {
    let j = joints0[i];
    let w = normalizedWeights[i];
    let m = skinMats[j];
    skinnedPos += (m * pos4) * w;
    let r3 = mat3x3f(m[0].xyz, m[1].xyz, m[2].xyz);
    skinnedNrm += (r3 * normal) * w;
  }
  let worldPos = skinnedPos.xyz;
  let worldNormal = normalize(skinnedNrm);

  // Screen-space outline extrusion — MMD-style pixel-stable edge line.
  // 1. Project position and normal-as-direction to clip space.
  // 2. Normalize the 2D clip-space normal, aspect-compensated so "one pixel horizontally"
  //    matches "one pixel vertically" (otherwise wide viewports squash the outline in X).
  // 3. Offset clip-space xy by (normal * edgeSize * edgeScale), then multiply by w
  //    so the perspective divide cancels out → offset stays constant in NDC regardless
  //    of depth, matching how MMD / babylon-mmd style outlines look identical when zooming.
  // 4. edgeScale is in NDC-y units per PMX edgeSize. ≈ 0.006 gives ~3px at 1080p; it's
  //    tied to viewport HEIGHT so resizing the window keeps pixel thickness stable.
  let viewProj = camera.projection * camera.view;
  let clipPos = viewProj * vec4f(worldPos, 1.0);
  let clipNormal = (viewProj * vec4f(worldNormal, 0.0)).xy;
  // projection is column-major: proj[0][0] = 1/(aspect·tan(fov/2)), proj[1][1] = 1/tan(fov/2).
  // Ratio proj[1][1]/proj[0][0] recovers the viewport aspect (width/height).
  let aspect = camera.projection[1][1] / camera.projection[0][0];
  let pixelDir = normalize(vec2f(clipNormal.x * aspect, clipNormal.y));
  let ndcDir = vec2f(pixelDir.x / aspect, pixelDir.y);
  let edgeScale = 0.0016;
  let offset = ndcDir * material.edgeSize * edgeScale * clipPos.w;
  output.position = vec4f(clipPos.xy + offset, clipPos.z, clipPos.w);
  return output;
}

struct FSOut { @location(0) color: vec4f, @location(1) mask: vec4f };
@fragment fn fs() -> FSOut {
  var out: FSOut;
  out.color = material.edgeColor;
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}
`
