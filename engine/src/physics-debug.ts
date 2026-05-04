// Debug overlay drawing every rigidbody as a wireframe + semitransparent solid
// primitive (sphere / box / capsule), color-coded by type:
//   yellow = static (FollowBone)
//   cyan   = kinematic
//   red    = dynamic
//
// Rendered in its own swapchain pass AFTER composite (see Engine.renderPhysicsDebug),
// so it sits cleanly on top of the final tonemapped image. No depth, no MSAA,
// no MRT, no interaction with the HDR alpha gate — bodies are always fully
// visible regardless of camera angle, model occlusion, or stacking. Reads body
// transforms straight from RezePhysics' SoA store — zero per-frame allocations.

import { Mat4 } from "./math"
import type { RezePhysics } from "./physics"
import { RigidbodyShape, RigidbodyType } from "./physics"
import { PHYSICS_DEBUG_SHADER_WGSL } from "./shaders/passes/physics-debug"

const STRIDE_BYTES = 96 // 4 mat4 cols + size+pad + color = 6 vec4
const STRIDE_FLOATS = STRIDE_BYTES / 4

// Per-instance color.alpha is the WIREFRAME alpha (1.0 for crisp edges). Solid
// pipelines override the SOLID_ALPHA shader constant to ~0.20 so the fill stays
// gentle where many bodies overlap.
// Hues chosen so wire+solid both read against the typical pink/grey reze studio
// scene background. Red [1, 0.3, 0.3] sat too close to the pink bg's hue —
// solid fill (α≈0.2) blended into the bg and the wire didn't separate from it.
// Orange-red shifts ~30° on the hue wheel, giving real chroma against pink.
const COLOR_STATIC: [number, number, number, number] = [1.0, 0.85, 0.15, 1.0]    // yellow
const COLOR_KINEMATIC: [number, number, number, number] = [0.25, 0.7, 1.0, 1.0]  // cyan-blue
const COLOR_DYNAMIC: [number, number, number, number] = [1.0, 0.35, 0.0, 1.0]    // orange-red
const SOLID_ALPHA = 0.2

export class PhysicsDebugRenderer {
  private device: GPUDevice
  private bindGroup: GPUBindGroup

  // Wireframe (line-list) pipelines + geometry.
  private wirePipelineSphere: GPURenderPipeline
  private wirePipelineBox: GPURenderPipeline
  private wirePipelineCapsule: GPURenderPipeline
  private wireSphereBuffer: GPUBuffer
  private wireBoxBuffer: GPUBuffer
  private wireCapsuleBuffer: GPUBuffer
  private wireSphereCount: number
  private wireBoxCount: number
  private wireCapsuleCount: number

  // Solid (triangle-list) pipelines + geometry. Drawn before the wireframes so
  // edges sit on top of the gentle fill.
  private solidPipelineSphere: GPURenderPipeline
  private solidPipelineBox: GPURenderPipeline
  private solidPipelineCapsule: GPURenderPipeline
  private solidSphereBuffer: GPUBuffer
  private solidBoxBuffer: GPUBuffer
  private solidCapsuleBuffer: GPUBuffer
  private solidSphereCount: number
  private solidBoxCount: number
  private solidCapsuleCount: number

  private instanceBuffer: GPUBuffer
  private instanceData: Float32Array
  private instanceCapacity: number

  constructor(
    device: GPUDevice,
    cameraUniformBuffer: GPUBuffer,
    presentationFormat: GPUTextureFormat,
  ) {
    this.device = device

    const wireSphere = buildSphereWireGeometry()
    const wireBox = buildBoxWireGeometry()
    const wireCapsule = buildCapsuleWireGeometry()
    this.wireSphereCount = wireSphere.length / 4
    this.wireBoxCount = wireBox.length / 4
    this.wireCapsuleCount = wireCapsule.length / 4

    const solidSphere = buildSphereSolidGeometry()
    const solidBox = buildBoxSolidGeometry()
    const solidCapsule = buildCapsuleSolidGeometry()
    this.solidSphereCount = solidSphere.length / 4
    this.solidBoxCount = solidBox.length / 4
    this.solidCapsuleCount = solidCapsule.length / 4

    const upload = (label: string, data: Float32Array): GPUBuffer => {
      const buf = device.createBuffer({
        label,
        size: data.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(buf, 0, data.buffer, data.byteOffset, data.byteLength)
      return buf
    }
    this.wireSphereBuffer = upload("physics-debug wire sphere", wireSphere)
    this.wireBoxBuffer = upload("physics-debug wire box", wireBox)
    this.wireCapsuleBuffer = upload("physics-debug wire capsule", wireCapsule)
    this.solidSphereBuffer = upload("physics-debug solid sphere", solidSphere)
    this.solidBoxBuffer = upload("physics-debug solid box", solidBox)
    this.solidCapsuleBuffer = upload("physics-debug solid capsule", solidCapsule)

    this.instanceCapacity = 512
    this.instanceData = new Float32Array(this.instanceCapacity * STRIDE_FLOATS)
    this.instanceBuffer = device.createBuffer({
      label: "physics-debug instances",
      size: this.instanceCapacity * STRIDE_BYTES,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })

    const bgl = device.createBindGroupLayout({
      label: "physics-debug bgl",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    })
    this.bindGroup = device.createBindGroup({
      label: "physics-debug bg",
      layout: bgl,
      entries: [{ binding: 0, resource: { buffer: cameraUniformBuffer } }],
    })

    const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [bgl] })
    const shader = device.createShaderModule({
      label: "physics-debug shader",
      code: PHYSICS_DEBUG_SHADER_WGSL,
    })

    const vertexBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: 16,
        attributes: [{ shaderLocation: 0, offset: 0, format: "float32x4" }],
      },
      {
        arrayStride: STRIDE_BYTES,
        stepMode: "instance",
        attributes: [
          { shaderLocation: 1, offset: 0, format: "float32x4" },
          { shaderLocation: 2, offset: 16, format: "float32x4" },
          { shaderLocation: 3, offset: 32, format: "float32x4" },
          { shaderLocation: 4, offset: 48, format: "float32x4" },
          { shaderLocation: 5, offset: 64, format: "float32x4" },
          { shaderLocation: 6, offset: 80, format: "float32x4" },
        ],
      },
    ]

    const targets: GPUColorTargetState[] = [
      {
        format: presentationFormat,
        blend: {
          color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
          alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha", operation: "add" },
        },
      },
    ]

    const buildPipeline = (
      label: string,
      kind: number,
      topology: GPUPrimitiveTopology,
      solidAlpha: number,
    ): GPURenderPipeline =>
      device.createRenderPipeline({
        label,
        layout: pipelineLayout,
        vertex: {
          module: shader,
          entryPoint: "vsMain",
          buffers: vertexBuffers,
          constants: { SHAPE_KIND: kind },
        },
        fragment: {
          module: shader,
          entryPoint: "fsMain",
          targets,
          constants: { SOLID_ALPHA: solidAlpha },
        },
        primitive: { topology, cullMode: "none" },
        // No depth attachment, single multisample — pass renders straight to
        // the swapchain after composite, so the overlay sits on top of the
        // tonemapped scene without interacting with depth/stencil/MSAA.
        multisample: { count: 1 },
      })

    this.wirePipelineSphere = buildPipeline("physics-debug wire sphere", 0, "line-list", 1.0)
    this.wirePipelineBox = buildPipeline("physics-debug wire box", 1, "line-list", 1.0)
    this.wirePipelineCapsule = buildPipeline("physics-debug wire capsule", 2, "line-list", 1.0)
    this.solidPipelineSphere = buildPipeline("physics-debug solid sphere", 0, "triangle-list", SOLID_ALPHA)
    this.solidPipelineBox = buildPipeline("physics-debug solid box", 1, "triangle-list", SOLID_ALPHA)
    this.solidPipelineCapsule = buildPipeline("physics-debug solid capsule", 2, "triangle-list", SOLID_ALPHA)
  }

  render(pass: GPURenderPassEncoder, physics: RezePhysics): void {
    const rigidbodies = physics.getRigidbodies()
    const N = rigidbodies.length
    if (N === 0) return

    const store = physics.getStore()
    const positions = store.positions
    const orientations = store.orientations

    if (N > this.instanceCapacity) {
      this.instanceCapacity = Math.max(N, this.instanceCapacity * 2)
      this.instanceData = new Float32Array(this.instanceCapacity * STRIDE_FLOATS)
      this.instanceBuffer.destroy()
      this.instanceBuffer = this.device.createBuffer({
        label: "physics-debug instances",
        size: this.instanceCapacity * STRIDE_BYTES,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }

    // Two passes: count per-shape, then fill packed by shape so we can issue
    // 3 instanced draws with vertex-buffer offsets.
    let sphereCount = 0
    let boxCount = 0
    let capsuleCount = 0
    for (let i = 0; i < N; i++) {
      const s = rigidbodies[i].shape
      if (s === RigidbodyShape.Sphere) sphereCount++
      else if (s === RigidbodyShape.Box) boxCount++
      else capsuleCount++
    }

    const sphereOffset = 0
    const boxOffset = sphereCount
    const capsuleOffset = sphereCount + boxCount

    const data = this.instanceData
    let sIdx = sphereOffset
    let bIdx = boxOffset
    let cIdx = capsuleOffset

    for (let i = 0; i < N; i++) {
      const rb = rigidbodies[i]
      const i3 = i * 3
      const i4 = i * 4

      let slot: number
      if (rb.shape === RigidbodyShape.Sphere) slot = sIdx++
      else if (rb.shape === RigidbodyShape.Box) slot = bIdx++
      else slot = cIdx++

      const dst = slot * STRIDE_FLOATS

      // Model matrix: rotation from quat into [dst..dst+15], then translation.
      Mat4.fromQuatInto(
        orientations[i4 + 0],
        orientations[i4 + 1],
        orientations[i4 + 2],
        orientations[i4 + 3],
        data,
        dst,
      )
      data[dst + 12] = positions[i3 + 0]
      data[dst + 13] = positions[i3 + 1]
      data[dst + 14] = positions[i3 + 2]

      // size + pad
      data[dst + 16] = rb.size.x
      data[dst + 17] = rb.size.y
      data[dst + 18] = rb.size.z
      data[dst + 19] = 0

      const c =
        rb.type === RigidbodyType.Static
          ? COLOR_STATIC
          : rb.type === RigidbodyType.Kinematic
            ? COLOR_KINEMATIC
            : COLOR_DYNAMIC
      data[dst + 20] = c[0]
      data[dst + 21] = c[1]
      data[dst + 22] = c[2]
      data[dst + 23] = c[3]
    }

    this.device.queue.writeBuffer(this.instanceBuffer, 0, data.buffer, data.byteOffset, N * STRIDE_BYTES)

    pass.setBindGroup(0, this.bindGroup)

    // Solid fills first (gentle ~20% alpha for shape ID), wireframe edges on top
    // (95% alpha for crisp silhouette).
    if (sphereCount > 0) {
      const off = sphereOffset * STRIDE_BYTES
      const size = sphereCount * STRIDE_BYTES
      pass.setPipeline(this.solidPipelineSphere)
      pass.setVertexBuffer(0, this.solidSphereBuffer)
      pass.setVertexBuffer(1, this.instanceBuffer, off, size)
      pass.draw(this.solidSphereCount, sphereCount)

      pass.setPipeline(this.wirePipelineSphere)
      pass.setVertexBuffer(0, this.wireSphereBuffer)
      pass.setVertexBuffer(1, this.instanceBuffer, off, size)
      pass.draw(this.wireSphereCount, sphereCount)
    }
    if (boxCount > 0) {
      const off = boxOffset * STRIDE_BYTES
      const size = boxCount * STRIDE_BYTES
      pass.setPipeline(this.solidPipelineBox)
      pass.setVertexBuffer(0, this.solidBoxBuffer)
      pass.setVertexBuffer(1, this.instanceBuffer, off, size)
      pass.draw(this.solidBoxCount, boxCount)

      pass.setPipeline(this.wirePipelineBox)
      pass.setVertexBuffer(0, this.wireBoxBuffer)
      pass.setVertexBuffer(1, this.instanceBuffer, off, size)
      pass.draw(this.wireBoxCount, boxCount)
    }
    if (capsuleCount > 0) {
      const off = capsuleOffset * STRIDE_BYTES
      const size = capsuleCount * STRIDE_BYTES
      pass.setPipeline(this.solidPipelineCapsule)
      pass.setVertexBuffer(0, this.solidCapsuleBuffer)
      pass.setVertexBuffer(1, this.instanceBuffer, off, size)
      pass.draw(this.solidCapsuleCount, capsuleCount)

      pass.setPipeline(this.wirePipelineCapsule)
      pass.setVertexBuffer(0, this.wireCapsuleBuffer)
      pass.setVertexBuffer(1, this.instanceBuffer, off, size)
      pass.draw(this.wireCapsuleCount, capsuleCount)
    }
  }

  destroy(): void {
    this.wireSphereBuffer.destroy()
    this.wireBoxBuffer.destroy()
    this.wireCapsuleBuffer.destroy()
    this.solidSphereBuffer.destroy()
    this.solidBoxBuffer.destroy()
    this.solidCapsuleBuffer.destroy()
    this.instanceBuffer.destroy()
  }
}

// ── Geometry builders ─────────────────────────────────────────────────────────
// Each vertex is vec4(unitPos.xyz, axialAnchor) packed as 4 floats.

function buildSphereWireGeometry() {
  const segs = 32
  const out = new Float32Array(3 * segs * 2 * 4) // 3 great circles
  let p = 0
  for (let plane = 0; plane < 3; plane++) {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2
      const a1 = ((i + 1) / segs) * Math.PI * 2
      const c0 = Math.cos(a0), s0 = Math.sin(a0)
      const c1 = Math.cos(a1), s1 = Math.sin(a1)
      let p0x = 0, p0y = 0, p0z = 0
      let p1x = 0, p1y = 0, p1z = 0
      if (plane === 0) {
        p0x = c0; p0y = s0; p1x = c1; p1y = s1
      } else if (plane === 1) {
        p0x = c0; p0z = s0; p1x = c1; p1z = s1
      } else {
        p0y = c0; p0z = s0; p1y = c1; p1z = s1
      }
      out[p++] = p0x; out[p++] = p0y; out[p++] = p0z; out[p++] = 0
      out[p++] = p1x; out[p++] = p1y; out[p++] = p1z; out[p++] = 0
    }
  }
  return out
}

function buildBoxWireGeometry() {
  const edges: Array<[number, number, number, number, number, number]> = [
    // 4 along X
    [-1, -1, -1, +1, -1, -1], [-1, -1, +1, +1, -1, +1],
    [-1, +1, -1, +1, +1, -1], [-1, +1, +1, +1, +1, +1],
    // 4 along Y
    [-1, -1, -1, -1, +1, -1], [+1, -1, -1, +1, +1, -1],
    [-1, -1, +1, -1, +1, +1], [+1, -1, +1, +1, +1, +1],
    // 4 along Z
    [-1, -1, -1, -1, -1, +1], [+1, -1, -1, +1, -1, +1],
    [-1, +1, -1, -1, +1, +1], [+1, +1, -1, +1, +1, +1],
  ]
  const out = new Float32Array(edges.length * 2 * 4)
  let p = 0
  for (const e of edges) {
    out[p++] = e[0]; out[p++] = e[1]; out[p++] = e[2]; out[p++] = 0
    out[p++] = e[3]; out[p++] = e[4]; out[p++] = e[5]; out[p++] = 0
  }
  return out
}

function buildCapsuleWireGeometry() {
  const ringSegs = 32
  const arcSegs = 16
  // 2 cap rings + 4 hemisphere arcs + 4 cylinder verticals
  const lineCount = ringSegs * 2 + arcSegs * 4 + 4
  const out = new Float32Array(lineCount * 2 * 4)
  let p = 0
  const push = (x: number, y: number, z: number, axial: number): void => {
    out[p++] = x; out[p++] = y; out[p++] = z; out[p++] = axial
  }

  // Top ring (axial=+1) in XZ plane
  for (let i = 0; i < ringSegs; i++) {
    const a0 = (i / ringSegs) * Math.PI * 2
    const a1 = ((i + 1) / ringSegs) * Math.PI * 2
    push(Math.cos(a0), 0, Math.sin(a0), +1)
    push(Math.cos(a1), 0, Math.sin(a1), +1)
  }
  // Bottom ring (axial=-1)
  for (let i = 0; i < ringSegs; i++) {
    const a0 = (i / ringSegs) * Math.PI * 2
    const a1 = ((i + 1) / ringSegs) * Math.PI * 2
    push(Math.cos(a0), 0, Math.sin(a0), -1)
    push(Math.cos(a1), 0, Math.sin(a1), -1)
  }
  // Top cap arcs in XY and YZ planes (θ ∈ [0, π], pos = (cosθ, sinθ, 0) etc.)
  for (let i = 0; i < arcSegs; i++) {
    const t0 = (i / arcSegs) * Math.PI
    const t1 = ((i + 1) / arcSegs) * Math.PI
    push(Math.cos(t0), Math.sin(t0), 0, +1)
    push(Math.cos(t1), Math.sin(t1), 0, +1)
  }
  for (let i = 0; i < arcSegs; i++) {
    const t0 = (i / arcSegs) * Math.PI
    const t1 = ((i + 1) / arcSegs) * Math.PI
    push(0, Math.sin(t0), Math.cos(t0), +1)
    push(0, Math.sin(t1), Math.cos(t1), +1)
  }
  // Bottom cap arcs
  for (let i = 0; i < arcSegs; i++) {
    const t0 = (i / arcSegs) * Math.PI
    const t1 = ((i + 1) / arcSegs) * Math.PI
    push(Math.cos(t0), -Math.sin(t0), 0, -1)
    push(Math.cos(t1), -Math.sin(t1), 0, -1)
  }
  for (let i = 0; i < arcSegs; i++) {
    const t0 = (i / arcSegs) * Math.PI
    const t1 = ((i + 1) / arcSegs) * Math.PI
    push(0, -Math.sin(t0), Math.cos(t0), -1)
    push(0, -Math.sin(t1), Math.cos(t1), -1)
  }
  // 4 cylinder verticals: bottom rim (axial=-1) → top rim (+1) at fixed θ
  push(+1, 0, 0, -1); push(+1, 0, 0, +1)
  push(-1, 0, 0, -1); push(-1, 0, 0, +1)
  push(0, 0, +1, -1); push(0, 0, +1, +1)
  push(0, 0, -1, -1); push(0, 0, -1, +1)

  return out
}

// ── Solid (triangle-list) geometry builders ─────────────────────────────────
// Each vertex is vec4(unitPos.xyz, axialAnchor) — same layout as wireframe.

// UV sphere — stacks × slices quads, each split into 2 triangles. Polar quads
// degenerate to triangles, which the GPU silently drops.
function buildSphereSolidGeometry() {
  const stacks = 12
  const slices = 18
  const out = new Float32Array(stacks * slices * 6 * 4)
  let p = 0
  const vert = (phi: number, theta: number): void => {
    out[p++] = Math.cos(phi) * Math.cos(theta)
    out[p++] = Math.sin(phi)
    out[p++] = Math.cos(phi) * Math.sin(theta)
    out[p++] = 0
  }
  for (let s = 0; s < stacks; s++) {
    const phi0 = -Math.PI / 2 + (s / stacks) * Math.PI
    const phi1 = -Math.PI / 2 + ((s + 1) / stacks) * Math.PI
    for (let l = 0; l < slices; l++) {
      const th0 = (l / slices) * Math.PI * 2
      const th1 = ((l + 1) / slices) * Math.PI * 2
      vert(phi0, th0); vert(phi1, th0); vert(phi1, th1)
      vert(phi0, th0); vert(phi1, th1); vert(phi0, th1)
    }
  }
  return out
}

// 6 cube faces × 2 triangles × 3 verts = 36 verts.
function buildBoxSolidGeometry() {
  const faces: Array<[number, number, number, number, number, number, number, number, number, number, number, number]> = [
    // +X face
    [+1, -1, -1, +1, +1, -1, +1, +1, +1, +1, -1, +1],
    // -X face
    [-1, -1, -1, -1, -1, +1, -1, +1, +1, -1, +1, -1],
    // +Y face
    [-1, +1, -1, -1, +1, +1, +1, +1, +1, +1, +1, -1],
    // -Y face
    [-1, -1, -1, +1, -1, -1, +1, -1, +1, -1, -1, +1],
    // +Z face
    [-1, -1, +1, +1, -1, +1, +1, +1, +1, -1, +1, +1],
    // -Z face
    [-1, -1, -1, -1, +1, -1, +1, +1, -1, +1, -1, -1],
  ]
  const out = new Float32Array(faces.length * 6 * 4)
  let p = 0
  const v = (x: number, y: number, z: number): void => {
    out[p++] = x; out[p++] = y; out[p++] = z; out[p++] = 0
  }
  for (const f of faces) {
    // f = [a, b, c, d] as 4 corners; emit tris (a,b,c) (a,c,d)
    v(f[0], f[1], f[2]); v(f[3], f[4], f[5]); v(f[6], f[7], f[8])
    v(f[0], f[1], f[2]); v(f[6], f[7], f[8]); v(f[9], f[10], f[11])
  }
  return out
}

// Capsule: two hemispheres at axial=±1 + cylinder side connecting their equators.
// Vertex shader does: world.y = unit.y * radius + halfHeight * axial.
function buildCapsuleSolidGeometry() {
  const slices = 18
  const capStacks = 6
  const cylTris = slices * 2          // 1 stack of quads → 2 tris/slice
  const capTris = capStacks * slices * 2
  const totalVerts = (cylTris + capTris * 2) * 3
  const out = new Float32Array(totalVerts * 4)
  let p = 0
  const v = (x: number, y: number, z: number, axial: number): void => {
    out[p++] = x; out[p++] = y; out[p++] = z; out[p++] = axial
  }

  // Cylinder side: two rings at axial=±1, both at unit y=0.
  for (let l = 0; l < slices; l++) {
    const th0 = (l / slices) * Math.PI * 2
    const th1 = ((l + 1) / slices) * Math.PI * 2
    const c0 = Math.cos(th0), s0 = Math.sin(th0)
    const c1 = Math.cos(th1), s1 = Math.sin(th1)
    // bottom-left, top-left, top-right
    v(c0, 0, s0, -1); v(c0, 0, s0, +1); v(c1, 0, s1, +1)
    // bottom-left, top-right, bottom-right
    v(c0, 0, s0, -1); v(c1, 0, s1, +1); v(c1, 0, s1, -1)
  }

  // Top hemisphere (axial=+1): φ ∈ [0, π/2], pos = (cosφ cosθ, sinφ, cosφ sinθ).
  for (let s = 0; s < capStacks; s++) {
    const ph0 = (s / capStacks) * (Math.PI / 2)
    const ph1 = ((s + 1) / capStacks) * (Math.PI / 2)
    for (let l = 0; l < slices; l++) {
      const th0 = (l / slices) * Math.PI * 2
      const th1 = ((l + 1) / slices) * Math.PI * 2
      const a = (ph: number, th: number): [number, number, number] => [
        Math.cos(ph) * Math.cos(th), Math.sin(ph), Math.cos(ph) * Math.sin(th),
      ]
      const p00 = a(ph0, th0), p10 = a(ph1, th0), p11 = a(ph1, th1), p01 = a(ph0, th1)
      v(p00[0], p00[1], p00[2], +1); v(p10[0], p10[1], p10[2], +1); v(p11[0], p11[1], p11[2], +1)
      v(p00[0], p00[1], p00[2], +1); v(p11[0], p11[1], p11[2], +1); v(p01[0], p01[1], p01[2], +1)
    }
  }

  // Bottom hemisphere (axial=-1): same but y = -sinφ.
  for (let s = 0; s < capStacks; s++) {
    const ph0 = (s / capStacks) * (Math.PI / 2)
    const ph1 = ((s + 1) / capStacks) * (Math.PI / 2)
    for (let l = 0; l < slices; l++) {
      const th0 = (l / slices) * Math.PI * 2
      const th1 = ((l + 1) / slices) * Math.PI * 2
      const a = (ph: number, th: number): [number, number, number] => [
        Math.cos(ph) * Math.cos(th), -Math.sin(ph), Math.cos(ph) * Math.sin(th),
      ]
      const p00 = a(ph0, th0), p10 = a(ph1, th0), p11 = a(ph1, th1), p01 = a(ph0, th1)
      v(p00[0], p00[1], p00[2], -1); v(p11[0], p11[1], p11[2], -1); v(p10[0], p10[1], p10[2], -1)
      v(p00[0], p00[1], p00[2], -1); v(p01[0], p01[1], p01[2], -1); v(p11[0], p11[1], p11[2], -1)
    }
  }

  return out
}

