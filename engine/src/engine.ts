import { Camera } from "./camera"
import { Mat4, Vec3 } from "./math"
import { Model } from "./model"
import { PmxLoader } from "./pmx-loader"
import { Physics, type PhysicsOptions } from "./physics"
import {
  createFetchAssetReader,
  createFileMapAssetReader,
  deriveBasePathFromPmxPath,
  fileListToMap,
  findFirstPmxFileInList,
  joinAssetPath,
  normalizeAssetPath,
  type AssetReader,
} from "./asset-reader"
import { DEFAULT_SHADER_WGSL } from "./shaders/default"
import { FACE_SHADER_WGSL } from "./shaders/face"
import { HAIR_SHADER_WGSL } from "./shaders/hair"
import { CLOTH_SMOOTH_SHADER_WGSL } from "./shaders/cloth_smooth"
import { BODY_SHADER_WGSL } from "./shaders/body"
import { EYE_SHADER_WGSL } from "./shaders/eye"
import { resolvePreset, type MaterialPreset, type MaterialPresetMap } from "./shaders/classify"

export type RaycastCallback = (modelName: string, material: string | null, screenX: number, screenY: number) => void

/** Select a folder (webkitdirectory) and pass FileList or File[]; pmxFile picks which .pmx when several exist. */
export type LoadModelFromFilesOptions = {
  files: FileList | File[]
  pmxFile?: File
}

// Blender-style scene config. World = environment lighting (ambient);
// Sun = the single directional lamp; Camera = view framing.
export type WorldOptions = {
  /** Linear scene-referred color of the World Background (Blender: World > Surface > Color). */
  color?: Vec3
  /** Multiplier on world color (Blender: World > Surface > Strength). */
  strength?: number
}

export type SunOptions = {
  /** Linear color of the sun lamp (Blender: Light > Color). */
  color?: Vec3
  /** Lamp power in Blender units (Blender: Light > Strength). */
  strength?: number
  /** Direction sunlight travels (points FROM sun TO scene, Blender: -light.rotation.Z). */
  direction?: Vec3
}

export type CameraOptions = {
  /** Orbit distance from target. */
  distance?: number
  /** World-space orbit center. */
  target?: Vec3
  /** Vertical field of view in radians. */
  fov?: number
}

/** EEVEE Bloom panel (3D Viewport > Render > Bloom). Fields map 1:1 to Blender's UI. */
export type BloomOptions = {
  enabled: boolean
  threshold: number
  knee: number
  radius: number
  color: Vec3
  intensity: number
  clamp: number
}

export const DEFAULT_BLOOM_OPTIONS: BloomOptions = {
  enabled: true,
  threshold: 0.5,
  knee: 0.5,
  radius: 4.0,
  color: new Vec3(1.0, 0.7247558832168579, 0.6487361788749695),
  intensity: 0.05,
  clamp: 0.0,
}

/** Blender Color Management / View (rendering.txt: Filmic, exposure, gamma). `look` is reserved for future curve tweaks. */
export type ViewTransformOptions = {
  /** Stops applied before Filmic: `linear *= 2^exposure` (Blender default often ~−0.3). */
  exposure: number
  /** After Filmic, display gamma (`pow(rgb, 1/gamma)`). */
  gamma: number
  look: "default" | "medium_high_contrast"
}

export const DEFAULT_VIEW_TRANSFORM: ViewTransformOptions = {
  exposure: -0.30000001192092896,
  gamma: 1.0,
  look: "medium_high_contrast",
}

export type EngineOptions = {
  world?: WorldOptions
  sun?: SunOptions
  camera?: CameraOptions
  /** Initial EEVEE-style bloom; tune at runtime with `setBloomOptions`. */
  bloom?: Partial<BloomOptions>
  /** View transform (exposure/gamma) applied in composite before/after Filmic. */
  view?: Partial<ViewTransformOptions>
  onRaycast?: RaycastCallback
  physicsOptions?: PhysicsOptions
}

export const DEFAULT_ENGINE_OPTIONS = {
  world: { color: new Vec3(0.4014, 0.4944, 0.647), strength: 0.3 },
  sun: { color: new Vec3(1.0, 1.0, 1.0), strength: 2.0, direction: new Vec3(-0.0873, -0.3844, 0.919) },
  camera: { distance: 26.6, target: new Vec3(0, 12.5, 0), fov: Math.PI / 4 },
  onRaycast: undefined,
  physicsOptions: { constraintSolverKeywords: ["胸"] },
}

export interface EngineStats {
  fps: number
  frameTime: number // ms
}

type DrawCallType = "opaque" | "transparent" | "ground" | "opaque-outline" | "transparent-outline"

interface DrawCall {
  type: DrawCallType
  count: number
  firstIndex: number
  bindGroup: GPUBindGroup
  materialName: string
  preset: MaterialPreset
}

interface PickDrawCall {
  count: number
  firstIndex: number
  bindGroup: GPUBindGroup
}

interface ModelInstance {
  name: string
  model: Model
  basePath: string
  assetReader: AssetReader
  gpuBuffers: GPUBuffer[]
  textureCacheKeys: string[]
  vertexBuffer: GPUBuffer
  indexBuffer: GPUBuffer
  jointsBuffer: GPUBuffer
  weightsBuffer: GPUBuffer
  skinMatrixBuffer: GPUBuffer
  drawCalls: DrawCall[]
  shadowDrawCalls: DrawCall[]
  shadowBindGroup: GPUBindGroup
  mainPerInstanceBindGroup: GPUBindGroup
  pickPerInstanceBindGroup: GPUBindGroup
  pickDrawCalls: PickDrawCall[]
  hiddenMaterials: Set<string>
  materialPresets: MaterialPresetMap | undefined
  physics: Physics | null
  vertexBufferNeedsUpdate: boolean
}

export class Engine {
  private static instance: Engine | null = null

  static getInstance(): Engine {
    if (!Engine.instance) {
      throw new Error("Engine not ready: create Engine, await init(), then load models via engine.loadModel().")
    }
    return Engine.instance
  }

  private canvas: HTMLCanvasElement
  private device!: GPUDevice
  private context!: GPUCanvasContext
  private presentationFormat!: GPUTextureFormat
  private camera!: Camera
  private cameraUniformBuffer!: GPUBuffer
  private cameraMatrixData = new Float32Array(36)
  // Blender-style scene config groups (resolved from EngineOptions)
  private world!: { color: Vec3; strength: number }
  private sun!: { color: Vec3; strength: number; direction: Vec3 }
  private cameraConfig!: { distance: number; target: Vec3; fov: number }
  private lightUniformBuffer!: GPUBuffer
  private lightData = new Float32Array(64)
  private lightCount = 0
  private resizeObserver: ResizeObserver | null = null
  private depthTexture!: GPUTexture
  private modelPipeline!: GPURenderPipeline
  private facePipeline!: GPURenderPipeline
  private hairPipeline!: GPURenderPipeline
  private clothSmoothPipeline!: GPURenderPipeline
  private bodyPipeline!: GPURenderPipeline
  private eyePipeline!: GPURenderPipeline
  private groundShadowPipeline!: GPURenderPipeline
  private groundShadowBindGroupLayout!: GPUBindGroupLayout
  private outlinePipeline!: GPURenderPipeline
  private mainPerFrameBindGroupLayout!: GPUBindGroupLayout
  private mainPerInstanceBindGroupLayout!: GPUBindGroupLayout
  private mainPerMaterialBindGroupLayout!: GPUBindGroupLayout
  private outlinePerFrameBindGroupLayout!: GPUBindGroupLayout
  private outlinePerMaterialBindGroupLayout!: GPUBindGroupLayout
  private perFrameBindGroup!: GPUBindGroup
  private outlinePerFrameBindGroup!: GPUBindGroup
  private multisampleTexture!: GPUTexture
  private hdrResolveTexture!: GPUTexture
  private static readonly MULTISAMPLE_COUNT = 4
  private static readonly HDR_FORMAT: GPUTextureFormat = "rgba16float"
  private renderPassDescriptor!: GPURenderPassDescriptor
  private compositePassDescriptor!: GPURenderPassDescriptor
  private compositePipeline!: GPURenderPipeline
  private compositeBindGroupLayout!: GPUBindGroupLayout
  private compositeBindGroup!: GPUBindGroup
  private compositeUniformBuffer!: GPUBuffer
  // [exposure, gamma, _, _,  bloomTint.x, bloomTint.y, bloomTint.z, bloomIntensity]
  private readonly compositeUniformData = new Float32Array(8)

  // EEVEE-style bloom pyramid (mirrors Blender 3.6 effect_bloom_frag.glsl):
  //   blit (HDR → half-res, 4-tap Karis + soft threshold/knee)
  //   N-1 downsamples (13-tap Jimenez/COD box filter, 5 group averages)
  //   N-1 upsamples (9-tap tent, additively combined with corresponding downsample mip)
  //   composite adds bloomUp mip 0 × (color × intensity) to HDR before Filmic.
  // Matches EEVEE energy: tint/intensity applied at composite, not prefilter.
  private bloomSampler!: GPUSampler
  private bloomBlitUniformBuffer!: GPUBuffer
  private bloomUpsampleUniformBuffer!: GPUBuffer
  private readonly bloomBlitUniformData = new Float32Array(4)
  private readonly bloomUpsampleUniformData = new Float32Array(4)
  private bloomBlitPipeline!: GPURenderPipeline
  private bloomDownsamplePipeline!: GPURenderPipeline
  private bloomUpsamplePipeline!: GPURenderPipeline
  private bloomBlitBindGroupLayout!: GPUBindGroupLayout
  private bloomDownsampleBindGroupLayout!: GPUBindGroupLayout
  private bloomUpsampleBindGroupLayout!: GPUBindGroupLayout
  private bloomDownTexture!: GPUTexture
  private bloomUpTexture!: GPUTexture
  private bloomMipCount = 0
  private bloomDownMipViews: GPUTextureView[] = []
  private bloomUpMipViews: GPUTextureView[] = []
  private bloomBlitBindGroup!: GPUBindGroup
  private bloomDownsampleBindGroups: GPUBindGroup[] = []
  private bloomUpsampleBindGroups: GPUBindGroup[] = []
  /** Single-attachment pass; colorAttachments[0].view set per bloom step. */
  private bloomPassDescriptor!: GPURenderPassDescriptor
  private static readonly BLOOM_MAX_LEVELS = 7

  // Ground properties (shadow only)
  private groundVertexBuffer?: GPUBuffer
  private groundIndexBuffer?: GPUBuffer
  private hasGround = false
  private shadowMapTexture!: GPUTexture
  private shadowMapDepthView!: GPUTextureView
  private static readonly SHADOW_MAP_SIZE = 4096
  private shadowDepthPipeline!: GPURenderPipeline
  private shadowLightVPBuffer!: GPUBuffer
  private shadowLightVPMatrix = new Float32Array(16)
  private groundShadowBindGroup?: GPUBindGroup
  private shadowComparisonSampler!: GPUSampler
  private groundShadowMaterialBuffer?: GPUBuffer
  private groundDrawCall: DrawCall | null = null

  private onRaycast?: RaycastCallback
  private physicsOptions: PhysicsOptions = DEFAULT_ENGINE_OPTIONS.physicsOptions
  private lastTouchTime = 0
  private readonly DOUBLE_TAP_DELAY = 300
  // GPU picking
  private pickPipeline!: GPURenderPipeline
  private pickPerFrameBindGroupLayout!: GPUBindGroupLayout
  private pickPerInstanceBindGroupLayout!: GPUBindGroupLayout
  private pickPerMaterialBindGroupLayout!: GPUBindGroupLayout
  private pickPerFrameBindGroup!: GPUBindGroup
  private pickTexture!: GPUTexture
  private pickDepthTexture!: GPUTexture
  private pickReadbackBuffer!: GPUBuffer
  private pendingPick: { x: number; y: number } | null = null

  private modelInstances = new Map<string, ModelInstance>()
  private materialSampler!: GPUSampler
  private textureCache = new Map<string, GPUTexture>()
  private _nextDefaultModelId = 0

  // IK and physics enabled at engine level (same for all models)
  private ikEnabled = true
  private physicsEnabled = true

  // Camera target binding (Babylon/Three style: camera follows model)
  private cameraTargetModel: Model | null = null
  private cameraTargetBoneName = "全ての親"
  private cameraTargetOffset: Vec3 = new Vec3(0, 0, 0)

  private lastFpsUpdate = performance.now()
  private framesSinceLastUpdate = 0
  private lastFrameTime = performance.now()
  private frameTimeSum = 0
  private frameTimeCount = 0
  private stats: EngineStats = {
    fps: 0,
    frameTime: 0,
  }
  private animationFrameId: number | null = null
  private renderLoopCallback: (() => void) | null = null
  private bloomSettings!: BloomOptions
  private viewTransform!: ViewTransformOptions

  constructor(canvas: HTMLCanvasElement, options?: EngineOptions) {
    this.canvas = canvas
    const d = DEFAULT_ENGINE_OPTIONS
    this.world = {
      color: options?.world?.color ?? d.world.color,
      strength: options?.world?.strength ?? d.world.strength,
    }
    this.sun = {
      color: options?.sun?.color ?? d.sun.color,
      strength: options?.sun?.strength ?? d.sun.strength,
      direction: options?.sun?.direction ?? d.sun.direction,
    }
    this.cameraConfig = {
      distance: options?.camera?.distance ?? d.camera.distance,
      target: options?.camera?.target ?? d.camera.target,
      fov: options?.camera?.fov ?? d.camera.fov,
    }
    this.onRaycast = options?.onRaycast
    this.physicsOptions = options?.physicsOptions ?? d.physicsOptions
    this.bloomSettings = Engine.mergeBloomDefaults(options?.bloom)
    this.viewTransform = Engine.mergeViewTransformDefaults(options?.view)
  }

  /** Merge partial bloom with EEVEE defaults (same as constructor). */
  static mergeBloomDefaults(partial?: Partial<BloomOptions>): BloomOptions {
    const d = DEFAULT_BLOOM_OPTIONS
    const c = partial?.color
    return {
      enabled: partial?.enabled ?? d.enabled,
      threshold: partial?.threshold ?? d.threshold,
      knee: partial?.knee ?? d.knee,
      radius: partial?.radius ?? d.radius,
      color: c ? new Vec3(c.x, c.y, c.z) : new Vec3(d.color.x, d.color.y, d.color.z),
      intensity: partial?.intensity ?? d.intensity,
      clamp: partial?.clamp ?? d.clamp,
    }
  }

  static mergeViewTransformDefaults(partial?: Partial<ViewTransformOptions>): ViewTransformOptions {
    const d = DEFAULT_VIEW_TRANSFORM
    return {
      exposure: partial?.exposure ?? d.exposure,
      gamma: partial?.gamma ?? d.gamma,
      look: partial?.look ?? d.look,
    }
  }

  /** Current bloom settings (Blender names; tint is a copied `Vec3`). */
  getBloomOptions(): BloomOptions {
    const b = this.bloomSettings
    return {
      enabled: b.enabled,
      threshold: b.threshold,
      knee: b.knee,
      radius: b.radius,
      color: new Vec3(b.color.x, b.color.y, b.color.z),
      intensity: b.intensity,
      clamp: b.clamp,
    }
  }

  getViewTransformOptions(): ViewTransformOptions {
    const v = this.viewTransform
    return { exposure: v.exposure, gamma: v.gamma, look: v.look }
  }

  setViewTransformOptions(patch: Partial<ViewTransformOptions>): void {
    const v = this.viewTransform
    if (patch.exposure !== undefined) v.exposure = patch.exposure
    if (patch.gamma !== undefined) v.gamma = patch.gamma
    if (patch.look !== undefined) v.look = patch.look
    if (this.device && this.compositeUniformBuffer) {
      this.writeCompositeViewUniforms()
    }
  }

  private writeCompositeViewUniforms(): void {
    const v = this.viewTransform
    const b = this.bloomSettings
    const effIntensity = b.enabled ? b.intensity : 0.0
    const u = this.compositeUniformData
    u[0] = v.exposure
    u[1] = Math.max(v.gamma, 1e-4)
    u[2] = 0.0
    u[3] = 0.0
    u[4] = b.color.x
    u[5] = b.color.y
    u[6] = b.color.z
    u[7] = effIntensity
    this.device.queue.writeBuffer(this.compositeUniformBuffer, 0, u)
  }

  /** Patch bloom; GPU uniforms update immediately if `init()` has run. */
  setBloomOptions(patch: Partial<BloomOptions>): void {
    const b = this.bloomSettings
    if (patch.enabled !== undefined) b.enabled = patch.enabled
    if (patch.threshold !== undefined) b.threshold = patch.threshold
    if (patch.knee !== undefined) b.knee = patch.knee
    if (patch.radius !== undefined) b.radius = patch.radius
    if (patch.color !== undefined) {
      b.color.x = patch.color.x
      b.color.y = patch.color.y
      b.color.z = patch.color.z
    }
    if (patch.intensity !== undefined) b.intensity = patch.intensity
    if (patch.clamp !== undefined) b.clamp = patch.clamp
    if (this.device && this.bloomBlitUniformBuffer) {
      this.writeBloomUniforms()
      this.writeCompositeViewUniforms()
    }
  }

  // EEVEE prefilter uniforms (blit stage) + upsample sample scale. Intensity/tint live in composite.
  private writeBloomUniforms(): void {
    const b = this.bloomSettings
    const bu = this.bloomBlitUniformData
    // EEVEE prefilter: threshold, knee, clamp (0 → disabled), _unused
    bu[0] = b.threshold
    bu[1] = b.knee
    bu[2] = b.clamp
    bu[3] = 0.0
    this.device.queue.writeBuffer(this.bloomBlitUniformBuffer, 0, bu)
    const us = this.bloomUpsampleUniformData
    // Blender: bloom.radius directly controls the tent-filter sample scale in texel units.
    us[0] = Math.max(0.5, b.radius)
    us[1] = 0
    us[2] = 0
    us[3] = 0
    this.device.queue.writeBuffer(this.bloomUpsampleUniformBuffer, 0, us)
  }

  // Step 1: Get WebGPU device and context
  async init() {
    const adapter = await navigator.gpu?.requestAdapter()
    const device = await adapter?.requestDevice()
    if (!device) {
      throw new Error("WebGPU is not supported in this browser.")
    }
    this.device = device

    const context = this.canvas.getContext("webgpu")
    if (!context) {
      throw new Error("Failed to get WebGPU context.")
    }
    this.context = context

    this.presentationFormat = navigator.gpu.getPreferredCanvasFormat()

    this.context.configure({
      device: this.device,
      format: this.presentationFormat,
      alphaMode: "premultiplied",
    })

    this.setupCamera()
    this.setupLighting()
    this.createPipelines()
    this.setupResize()
    Engine.instance = this
  }

  private createRenderPipeline(config: {
    label: string
    layout: GPUPipelineLayout
    shaderModule: GPUShaderModule
    vertexBuffers: GPUVertexBufferLayout[]
    fragmentTarget?: GPUColorTargetState
    fragmentEntryPoint?: string
    cullMode?: GPUCullMode
    depthStencil?: GPUDepthStencilState
    multisample?: GPUMultisampleState
  }): GPURenderPipeline {
    return this.device.createRenderPipeline({
      label: config.label,
      layout: config.layout,
      vertex: {
        module: config.shaderModule,
        buffers: config.vertexBuffers,
      },
      fragment: config.fragmentTarget
        ? {
            module: config.shaderModule,
            entryPoint: config.fragmentEntryPoint,
            targets: [config.fragmentTarget],
          }
        : undefined,
      primitive: { cullMode: config.cullMode ?? "none" },
      depthStencil: config.depthStencil,
      multisample: config.multisample ?? { count: Engine.MULTISAMPLE_COUNT },
    })
  }

  private createPipelines() {
    this.materialSampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    })

    // Shared vertex buffer layouts
    const fullVertexBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: 8 * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat },
          { shaderLocation: 1, offset: 3 * 4, format: "float32x3" as GPUVertexFormat },
          { shaderLocation: 2, offset: 6 * 4, format: "float32x2" as GPUVertexFormat },
        ],
      },
      {
        arrayStride: 4 * 2,
        attributes: [{ shaderLocation: 3, offset: 0, format: "uint16x4" as GPUVertexFormat }],
      },
      {
        arrayStride: 4,
        attributes: [{ shaderLocation: 4, offset: 0, format: "unorm8x4" as GPUVertexFormat }],
      },
    ]

    const outlineVertexBuffers: GPUVertexBufferLayout[] = [
      {
        arrayStride: 8 * 4,
        attributes: [
          { shaderLocation: 0, offset: 0, format: "float32x3" as GPUVertexFormat },
          { shaderLocation: 1, offset: 3 * 4, format: "float32x3" as GPUVertexFormat },
        ],
      },
      {
        arrayStride: 4 * 2,
        attributes: [{ shaderLocation: 3, offset: 0, format: "uint16x4" as GPUVertexFormat }],
      },
      {
        arrayStride: 4,
        attributes: [{ shaderLocation: 4, offset: 0, format: "unorm8x4" as GPUVertexFormat }],
      },
    ]

    // Internal scene passes render into the HDR offscreen target; only the final
    // composite pass writes the swapchain. Tonemap moved to composite so bloom
    // (added next) can run on linear HDR.
    const standardBlend: GPUColorTargetState = {
      format: Engine.HDR_FORMAT,
      blend: {
        color: {
          srcFactor: "src-alpha",
          dstFactor: "one-minus-src-alpha",
          operation: "add",
        },
        alpha: {
          srcFactor: "one",
          dstFactor: "one-minus-src-alpha",
          operation: "add",
        },
      },
    }

    const shaderModule = this.device.createShaderModule({
      label: "default model shader",
      code: DEFAULT_SHADER_WGSL,
    })

    const faceShaderModule = this.device.createShaderModule({
      label: "face NPR shader",
      code: FACE_SHADER_WGSL,
    })

    const hairShaderModule = this.device.createShaderModule({
      label: "hair NPR shader",
      code: HAIR_SHADER_WGSL,
    })

    const clothSmoothShaderModule = this.device.createShaderModule({
      label: "cloth smooth NPR shader",
      code: CLOTH_SMOOTH_SHADER_WGSL,
    })

    const bodyShaderModule = this.device.createShaderModule({
      label: "body NPR shader",
      code: BODY_SHADER_WGSL,
    })

    const eyeShaderModule = this.device.createShaderModule({
      label: "eye shader",
      code: EYE_SHADER_WGSL,
    })

    // group 0: per-frame (camera + light + sampler + shadow) — bound once per pass
    this.mainPerFrameBindGroupLayout = this.device.createBindGroupLayout({
      label: "main per-frame bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })
    // group 1: per-instance (skinMats) — bound once per model
    this.mainPerInstanceBindGroupLayout = this.device.createBindGroupLayout({
      label: "main per-instance bind group layout",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }],
    })
    // group 2: per-material (texture + material uniforms) — bound per draw call
    this.mainPerMaterialBindGroupLayout = this.device.createBindGroupLayout({
      label: "main per-material bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })

    const mainPipelineLayout = this.device.createPipelineLayout({
      label: "main pipeline layout",
      bindGroupLayouts: [
        this.mainPerFrameBindGroupLayout,
        this.mainPerInstanceBindGroupLayout,
        this.mainPerMaterialBindGroupLayout,
      ],
    })

    // perFrameBindGroup is created after shadow resources below

    this.modelPipeline = this.createRenderPipeline({
      label: "model pipeline",
      layout: mainPipelineLayout,
      shaderModule,
      vertexBuffers: fullVertexBuffers,
      fragmentTarget: standardBlend,
      cullMode: "none",
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    })

    this.facePipeline = this.createRenderPipeline({
      label: "face NPR pipeline",
      layout: mainPipelineLayout,
      shaderModule: faceShaderModule,
      vertexBuffers: fullVertexBuffers,
      fragmentTarget: standardBlend,
      cullMode: "none",
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    })

    this.hairPipeline = this.createRenderPipeline({
      label: "hair NPR pipeline",
      layout: mainPipelineLayout,
      shaderModule: hairShaderModule,
      vertexBuffers: fullVertexBuffers,
      fragmentTarget: standardBlend,
      cullMode: "none",
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    })

    this.clothSmoothPipeline = this.createRenderPipeline({
      label: "cloth smooth NPR pipeline",
      layout: mainPipelineLayout,
      shaderModule: clothSmoothShaderModule,
      vertexBuffers: fullVertexBuffers,
      fragmentTarget: standardBlend,
      cullMode: "none",
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    })

    this.bodyPipeline = this.createRenderPipeline({
      label: "body NPR pipeline",
      layout: mainPipelineLayout,
      shaderModule: bodyShaderModule,
      vertexBuffers: fullVertexBuffers,
      fragmentTarget: standardBlend,
      cullMode: "none",
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    })

    this.eyePipeline = this.createRenderPipeline({
      label: "eye pipeline",
      layout: mainPipelineLayout,
      shaderModule: eyeShaderModule,
      vertexBuffers: fullVertexBuffers,
      fragmentTarget: standardBlend,
      cullMode: "none",
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    })

    this.shadowLightVPBuffer = this.device.createBuffer({
      size: 64,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const shadowBindGroupLayout = this.device.createBindGroupLayout({
      label: "shadow depth bind layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    })
    const shadowShader = this.device.createShaderModule({
      label: "shadow depth",
      code: /* wgsl */ `
        struct LightVP { viewProj: mat4x4f, };
        @group(0) @binding(0) var<uniform> lp: LightVP;
        @group(0) @binding(1) var<storage, read> skinMats: array<mat4x4f>;
        @vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f,
          @location(3) joints0: vec4<u32>, @location(4) weights0: vec4<f32>) -> @builtin(position) vec4f {
          let pos4 = vec4f(position, 1.0);
          let ws = weights0.x + weights0.y + weights0.z + weights0.w;
          let inv = select(1.0, 1.0 / ws, ws > 0.0001);
          let nw = select(vec4f(1.0,0.0,0.0,0.0), weights0 * inv, ws > 0.0001);
          var sp = vec4f(0.0);
          for (var i = 0u; i < 4u; i++) { sp += (skinMats[joints0[i]] * pos4) * nw[i]; }
          return lp.viewProj * vec4f(sp.xyz, 1.0);
        }
      `,
    })
    this.shadowDepthPipeline = this.device.createRenderPipeline({
      label: "shadow depth pipeline",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [shadowBindGroupLayout] }),
      vertex: { module: shadowShader, entryPoint: "vs", buffers: fullVertexBuffers as GPUVertexBufferLayout[] },
      primitive: { cullMode: "none" },
      depthStencil: {
        format: "depth32float",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
        depthBias: 2,
        depthBiasSlopeScale: 1.5,
        depthBiasClamp: 0,
      },
    })
    this.shadowComparisonSampler = this.device.createSampler({
      compare: "less",
      magFilter: "linear",
      minFilter: "linear",
    })
    this.shadowMapTexture = this.device.createTexture({
      label: "shadow map",
      size: [Engine.SHADOW_MAP_SIZE, Engine.SHADOW_MAP_SIZE],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.shadowMapDepthView = this.shadowMapTexture.createView()

    // Now that shadow resources exist, create the main per-frame bind group
    this.perFrameBindGroup = this.device.createBindGroup({
      label: "main per-frame bind group",
      layout: this.mainPerFrameBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraUniformBuffer } },
        { binding: 1, resource: { buffer: this.lightUniformBuffer } },
        { binding: 2, resource: this.materialSampler },
        { binding: 3, resource: this.shadowMapDepthView },
        { binding: 4, resource: this.shadowComparisonSampler },
        { binding: 5, resource: { buffer: this.shadowLightVPBuffer } },
      ],
    })

    this.groundShadowBindGroupLayout = this.device.createBindGroupLayout({
      label: "ground shadow layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "depth" } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: "comparison" } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })
    const groundShadowShader = this.device.createShaderModule({
      label: "ground shadow",
      code: /* wgsl */ `
        struct CameraUniforms { view: mat4x4f, projection: mat4x4f, viewPos: vec3f, _p: f32, };
        struct Light { direction: vec4f, color: vec4f, };
        struct LightUniforms { ambientColor: vec4f, lights: array<Light, 4>, };
        struct GroundShadowMat {
          diffuseColor: vec3f, fadeStart: f32,
          fadeEnd: f32, shadowStrength: f32, pcfTexel: f32, gridSpacing: f32,
          gridLineWidth: f32, gridLineOpacity: f32, noiseStrength: f32, _pad: f32,
          gridLineColor: vec3f, _pad2: f32,
        };
        struct LightVP { viewProj: mat4x4f, };
        @group(0) @binding(0) var<uniform> camera: CameraUniforms;
        @group(0) @binding(1) var<uniform> light: LightUniforms;
        @group(0) @binding(2) var shadowMap: texture_depth_2d;
        @group(0) @binding(3) var shadowSampler: sampler_comparison;
        @group(0) @binding(4) var<uniform> material: GroundShadowMat;
        @group(0) @binding(5) var<uniform> lightVP: LightVP;

        // Hash-based noise for frosted/matte surface
        fn hash2(p: vec2f) -> f32 {
          var p3 = fract(vec3f(p.x, p.y, p.x) * 0.1031);
          p3 += dot(p3, vec3f(p3.y + 33.33, p3.z + 33.33, p3.x + 33.33));
          return fract((p3.x + p3.y) * p3.z);
        }
        fn valueNoise(p: vec2f) -> f32 {
          let i = floor(p);
          let f = fract(p);
          let u = f * f * (3.0 - 2.0 * f);
          return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x),
                     mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
        }
        fn fbmNoise(p: vec2f) -> f32 {
          var v = 0.0;
          var a = 0.5;
          var pp = p;
          for (var i = 0; i < 4; i++) {
            v += a * valueNoise(pp);
            pp *= 2.0;
            a *= 0.5;
          }
          return v;
        }

        struct VO { @builtin(position) position: vec4f, @location(0) worldPos: vec3f, @location(1) normal: vec3f, };
        @vertex fn vs(@location(0) position: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> VO {
          var o: VO; o.worldPos = position; o.normal = normal;
          o.position = camera.projection * camera.view * vec4f(position, 1.0); return o;
        }
        @fragment fn fs(i: VO) -> @location(0) vec4f {
          let n = normalize(i.normal);
          let centerDist = length(i.worldPos.xz);
          let edgeFade = 1.0 - smoothstep(0.0, 1.0, clamp((centerDist - material.fadeStart) / max(material.fadeEnd - material.fadeStart, 0.001), 0.0, 1.0));

          // Shadow sampling
          let lclip = lightVP.viewProj * vec4f(i.worldPos, 1.0);
          let ndc = lclip.xyz / max(lclip.w, 1e-6);
          let suv = vec2f(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5);
          let suv_c = clamp(suv, vec2f(0.02), vec2f(0.98));
          let st = material.pcfTexel;
          let compareZ = ndc.z - 0.0035;
          var vis = 0.0;
          for (var y = -2; y <= 2; y++) {
            for (var x = -2; x <= 2; x++) {
              vis += textureSampleCompare(shadowMap, shadowSampler, suv_c + vec2f(f32(x), f32(y)) * st, compareZ);
            }
          }
          vis *= 0.04;

          // Frosted/matte micro-texture (磨砂)
          let noiseVal = fbmNoise(i.worldPos.xz * 3.0);
          let noiseTint = 1.0 + (noiseVal - 0.5) * material.noiseStrength;

          // Grid lines — anti-aliased via screen-space derivatives
          let gp = i.worldPos.xz / material.gridSpacing;
          let gridFrac = abs(fract(gp - 0.5) - 0.5);
          let gridDeriv = fwidth(gp);
          let halfLine = material.gridLineWidth * 0.5;
          let gridLine = 1.0 - min(
            smoothstep(halfLine - gridDeriv.x, halfLine + gridDeriv.x, gridFrac.x),
            smoothstep(halfLine - gridDeriv.y, halfLine + gridDeriv.y, gridFrac.y)
          );
          let sun = light.ambientColor.xyz + light.lights[0].color.xyz * light.lights[0].color.w * max(dot(n, -light.lights[0].direction.xyz), 0.0);
          let dark = (1.0 - vis) * material.shadowStrength;
          var baseColor = material.diffuseColor * sun * (1.0 - dark * 0.65);
          baseColor *= noiseTint;
          let finalColor = mix(baseColor, material.gridLineColor, gridLine * material.gridLineOpacity * edgeFade);
          return vec4f(finalColor * edgeFade, edgeFade);
        }
      `,
    })
    this.groundShadowPipeline = this.createRenderPipeline({
      label: "ground shadow pipeline",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.groundShadowBindGroupLayout] }),
      shaderModule: groundShadowShader,
      vertexBuffers: fullVertexBuffers,
      fragmentTarget: standardBlend,
      cullMode: "back",
      depthStencil: { format: "depth24plus-stencil8", depthWriteEnabled: true, depthCompare: "less-equal" },
    })

    // Outline: group 0 = per-frame (camera), group 1 = per-instance (skinMats), group 2 = per-material (edge uniforms)
    this.outlinePerFrameBindGroupLayout = this.device.createBindGroupLayout({
      label: "outline per-frame bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })
    // Outline per-instance reuses mainPerInstanceBindGroupLayout (same skinMats binding)
    this.outlinePerMaterialBindGroupLayout = this.device.createBindGroupLayout({
      label: "outline per-material bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })

    const outlinePipelineLayout = this.device.createPipelineLayout({
      label: "outline pipeline layout",
      bindGroupLayouts: [
        this.outlinePerFrameBindGroupLayout,
        this.mainPerInstanceBindGroupLayout,
        this.outlinePerMaterialBindGroupLayout,
      ],
    })

    this.outlinePerFrameBindGroup = this.device.createBindGroup({
      label: "outline per-frame bind group",
      layout: this.outlinePerFrameBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.cameraUniformBuffer } }],
    })

    const outlineShaderModule = this.device.createShaderModule({
      label: "outline shaders",
      code: /* wgsl */ `
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

        // group 0: per-frame
        @group(0) @binding(0) var<uniform> camera: CameraUniforms;
        // group 1: per-instance
        @group(1) @binding(0) var<storage, read> skinMats: array<mat4x4f>;
        // group 2: per-material
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

        @fragment fn fs() -> @location(0) vec4f {
          return material.edgeColor;
        }
      `,
    })

    this.outlinePipeline = this.createRenderPipeline({
      label: "outline pipeline",
      layout: outlinePipelineLayout,
      shaderModule: outlineShaderModule,
      vertexBuffers: outlineVertexBuffers,
      fragmentTarget: standardBlend,
      cullMode: "back",
      depthStencil: {
        format: "depth24plus-stencil8",
        // Don’t write outline into depth buffer — stops z-fighting / black cracks vs body (MMD-style; body depth stays authoritative)
        depthWriteEnabled: false,
        depthCompare: "less-equal",
      },
    })

    // ─── Bloom (EEVEE 3.6 pyramid): blit(Karis prefilter) → 13-tap downsamples → 9-tap tent upsamples ───
    // Mirrors source/blender/draw/engines/eevee/shaders/effect_bloom_frag.glsl.
    // Firefly suppression lives in the blit (Karis luminance-weighted 4-tap average). A single-pass
    // Gaussian cannot reproduce this — hot pixels dominate and produce the sparkle halo.
    this.bloomSampler = this.device.createSampler({
      label: "bloom sampler",
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    })
    this.bloomBlitUniformBuffer = this.device.createBuffer({
      label: "bloom blit uniforms",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.bloomUpsampleUniformBuffer = this.device.createBuffer({
      label: "bloom upsample uniforms",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.bloomBlitBindGroupLayout = this.device.createBindGroupLayout({
      label: "bloom blit layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })
    this.bloomDownsampleBindGroupLayout = this.device.createBindGroupLayout({
      label: "bloom downsample layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    this.bloomUpsampleBindGroupLayout = this.device.createBindGroupLayout({
      label: "bloom upsample layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // coarser-mip accumulator
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // matching downsample mip (base add)
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })

    const bloomFullscreenVs = /* wgsl */ `
      @vertex fn vs(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
        let x = f32((vi & 1u) << 2u) - 1.0;
        let y = f32((vi & 2u) << 1u) - 1.0;
        return vec4f(x, y, 0.0, 1.0);
      }
    `

    // Blit: full-res HDR → half-res. Karis 4-tap firefly average + EEVEE quadratic knee threshold + clamp.
    const bloomBlitShader = this.device.createShaderModule({
      label: "bloom blit (Karis prefilter)",
      code: `${bloomFullscreenVs}
        @group(0) @binding(0) var hdrTex: texture_2d<f32>;
        @group(0) @binding(1) var<uniform> prefilter: vec4<f32>; // threshold, knee, clamp, _unused

        fn luminance(c: vec3f) -> f32 {
          return dot(max(c, vec3f(0.0)), vec3f(0.2126, 0.7152, 0.0722));
        }
        fn fetch(c: vec2<i32>, clampV: f32) -> vec3f {
          let d = vec2<i32>(textureDimensions(hdrTex));
          let cc = clamp(c, vec2<i32>(0), d - vec2<i32>(1));
          let s = textureLoad(hdrTex, cc, 0);
          // Scene pass uses src-alpha blend with clear alpha 0 → premultiplied. Unpremultiply.
          let rgb = max(s.rgb / max(s.a, 1e-6), vec3f(0.0));
          // Blender: clamp each tap BEFORE Karis average (eevee_bloom: color = min(clampIntensity, color)).
          return select(rgb, min(rgb, vec3f(clampV)), clampV > 0.0);
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
      `,
    })

    // Downsample: Jimenez/COD 13-tap dual-box — 5 weighted 2×2 averages, rejects nyquist ringing.
    const bloomDownsampleShader = this.device.createShaderModule({
      label: "bloom downsample 13-tap",
      code: `${bloomFullscreenVs}
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
      `,
    })

    // Upsample: 9-tap tent, progressively added to matching downsample mip. Blender radius = sample scale.
    const bloomUpsampleShader = this.device.createShaderModule({
      label: "bloom upsample 9-tap tent",
      code: `${bloomFullscreenVs}
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
      `,
    })

    const bloomBlitLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bloomBlitBindGroupLayout] })
    const bloomDownLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bloomDownsampleBindGroupLayout] })
    const bloomUpLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.bloomUpsampleBindGroupLayout] })

    this.bloomBlitPipeline = this.device.createRenderPipeline({
      label: "bloom blit pipeline",
      layout: bloomBlitLayout,
      vertex: { module: bloomBlitShader, entryPoint: "vs" },
      fragment: { module: bloomBlitShader, entryPoint: "fs", targets: [{ format: Engine.HDR_FORMAT }] },
      primitive: { topology: "triangle-list" },
    })
    this.bloomDownsamplePipeline = this.device.createRenderPipeline({
      label: "bloom downsample pipeline",
      layout: bloomDownLayout,
      vertex: { module: bloomDownsampleShader, entryPoint: "vs" },
      fragment: { module: bloomDownsampleShader, entryPoint: "fs", targets: [{ format: Engine.HDR_FORMAT }] },
      primitive: { topology: "triangle-list" },
    })
    this.bloomUpsamplePipeline = this.device.createRenderPipeline({
      label: "bloom upsample pipeline",
      layout: bloomUpLayout,
      vertex: { module: bloomUpsampleShader, entryPoint: "vs" },
      fragment: { module: bloomUpsampleShader, entryPoint: "fs", targets: [{ format: Engine.HDR_FORMAT }] },
      primitive: { topology: "triangle-list" },
    })

    // ─── Composite: HDR + bloom → Filmic → swapchain (premultiplied) ───
    // Bloom color/intensity applied HERE (pyramid is pure energy; tint belongs to the combine step,
    // mirroring EEVEE where bloom color/intensity are combine-stage params, not prefilter).
    this.compositeUniformBuffer = this.device.createBuffer({
      label: "composite view uniforms",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.compositeBindGroupLayout = this.device.createBindGroupLayout({
      label: "composite bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: "unfilterable-float" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })

    const compositeShader = this.device.createShaderModule({
      label: "composite shader",
      code: /* wgsl */ `
        @group(0) @binding(0) var hdrTex: texture_2d<f32>;
        @group(0) @binding(1) var bloomTex: texture_2d<f32>;   // bloomUpTexture mip 0 (full pyramid top)
        @group(0) @binding(2) var bloomSamp: sampler;
        @group(0) @binding(3) var<uniform> viewU: array<vec4<f32>, 2>;
        // viewU[0] = (exposure, gamma, _, _);  viewU[1] = (tint.rgb, intensity)

        fn filmic(x: f32) -> f32 {
          var lut = array<f32, 14>(
            0.0067, 0.0141, 0.0272, 0.0499, 0.0885, 0.1512, 0.2462,
            0.3753, 0.5273, 0.6776, 0.8031, 0.8929, 0.9495, 0.9814
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
          let hdr = textureLoad(hdrTex, vec2<i32>(fragCoord.xy), 0);
          let a = max(hdr.a, 1e-6);
          let straight = hdr.rgb / a;
          let fullSz = vec2f(textureDimensions(hdrTex));
          let bloomSz = vec2f(textureDimensions(bloomTex));
          // Bloom is at half-res (pyramid mip 0). Sampler interpolates back to full-res UVs.
          let bloomUv = (fragCoord.xy + vec2f(0.5)) / max(fullSz, vec2f(1.0));
          let tint = viewU[1].xyz;
          let intensity = viewU[1].w;
          let bloom = textureSampleLevel(bloomTex, bloomSamp, bloomUv, 0.0).rgb * tint * intensity;
          let combined = straight + bloom;
          let exposed = combined * exp2(viewU[0].x);
          let tm = vec3f(filmic(exposed.r), filmic(exposed.g), filmic(exposed.b));
          let g = max(viewU[0].y, 1e-4);
          let disp = pow(max(tm, vec3f(0.0)), vec3f(1.0 / g));
          return vec4f(disp * hdr.a, hdr.a);
        }
      `,
    })

    this.compositePipeline = this.device.createRenderPipeline({
      label: "composite pipeline",
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.compositeBindGroupLayout] }),
      vertex: { module: compositeShader, entryPoint: "vs" },
      fragment: {
        module: compositeShader,
        entryPoint: "fs",
        targets: [{ format: this.presentationFormat }],
      },
      primitive: { topology: "triangle-list" },
    })

    this.bloomPassDescriptor = {
      label: "bloom pass",
      colorAttachments: [
        {
          view: undefined as unknown as GPUTextureView,
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    } as GPURenderPassDescriptor

    // GPU picking: encode (modelIndex, materialIndex) as color
    const pickShaderModule = this.device.createShaderModule({
      label: "pick shader",
      code: /* wgsl */ `
        struct CameraUniforms {
          view: mat4x4f,
          projection: mat4x4f,
          viewPos: vec3f,
          _padding: f32,
        };
        struct PickId {
          modelId: f32,
          materialId: f32,
          _p1: f32,
          _p2: f32,
        };

        @group(0) @binding(0) var<uniform> camera: CameraUniforms;
        @group(1) @binding(0) var<storage, read> skinMats: array<mat4x4f>;
        @group(2) @binding(0) var<uniform> pickId: PickId;

        @vertex fn vs(
          @location(0) position: vec3f,
          @location(1) normal: vec3f,
          @location(2) uv: vec2f,
          @location(3) joints0: vec4<u32>,
          @location(4) weights0: vec4<f32>
        ) -> @builtin(position) vec4f {
          let pos4 = vec4f(position, 1.0);
          let weightSum = weights0.x + weights0.y + weights0.z + weights0.w;
          let invWeightSum = select(1.0, 1.0 / weightSum, weightSum > 0.0001);
          let nw = select(vec4f(1.0, 0.0, 0.0, 0.0), weights0 * invWeightSum, weightSum > 0.0001);
          var sp = vec4f(0.0);
          for (var i = 0u; i < 4u; i++) { sp += (skinMats[joints0[i]] * pos4) * nw[i]; }
          return camera.projection * camera.view * vec4f(sp.xyz, 1.0);
        }

        @fragment fn fs() -> @location(0) vec4f {
          return vec4f(pickId.modelId / 255.0, pickId.materialId / 255.0, 0.0, 1.0);
        }
      `,
    })

    this.pickPerFrameBindGroupLayout = this.device.createBindGroupLayout({
      label: "pick per-frame layout",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } }],
    })
    this.pickPerInstanceBindGroupLayout = this.device.createBindGroupLayout({
      label: "pick per-instance layout",
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }],
    })
    this.pickPerMaterialBindGroupLayout = this.device.createBindGroupLayout({
      label: "pick per-material layout",
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }],
    })

    const pickPipelineLayout = this.device.createPipelineLayout({
      label: "pick pipeline layout",
      bindGroupLayouts: [
        this.pickPerFrameBindGroupLayout,
        this.pickPerInstanceBindGroupLayout,
        this.pickPerMaterialBindGroupLayout,
      ],
    })

    this.pickPerFrameBindGroup = this.device.createBindGroup({
      label: "pick per-frame bind group",
      layout: this.pickPerFrameBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.cameraUniformBuffer } }],
    })

    this.pickPipeline = this.device.createRenderPipeline({
      label: "pick pipeline",
      layout: pickPipelineLayout,
      vertex: { module: pickShaderModule, buffers: fullVertexBuffers },
      fragment: {
        module: pickShaderModule,
        targets: [{ format: "rgba8unorm" }],
      },
      primitive: { cullMode: "none" },
      depthStencil: {
        format: "depth24plus",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    })

    this.pickReadbackBuffer = this.device.createBuffer({
      label: "pick readback",
      size: 256,
      usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    })
  }

  // Step 3: Setup canvas resize handling
  private setupResize() {
    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(this.canvas)
    this.handleResize()

    // Setup raycasting double-click handler for desktop
    if (this.onRaycast) {
      this.canvas.addEventListener("dblclick", this.handleCanvasDoubleClick)
      this.canvas.addEventListener("touchend", this.handleCanvasTouch)
    }
  }

  private handleResize() {
    const displayWidth = this.canvas.clientWidth
    const displayHeight = this.canvas.clientHeight

    const dpr = window.devicePixelRatio || 1
    const width = Math.floor(displayWidth * dpr)
    const height = Math.floor(displayHeight * dpr)

    if (!this.multisampleTexture || this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width
      this.canvas.height = height

      this.multisampleTexture = this.device.createTexture({
        label: "multisample HDR render target",
        size: [width, height],
        sampleCount: Engine.MULTISAMPLE_COUNT,
        format: Engine.HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })

      this.hdrResolveTexture = this.device.createTexture({
        label: "HDR resolve target",
        size: [width, height],
        format: Engine.HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })

      // Bloom pyramid: mip 0 is half-res, each subsequent mip halves again.
      // Mip count chosen so the coarsest mip is ≥4 px on the short side, capped at BLOOM_MAX_LEVELS.
      const bw = Math.max(1, Math.floor(width / 2))
      const bh = Math.max(1, Math.floor(height / 2))
      const shortSide = Math.max(1, Math.min(bw, bh))
      this.bloomMipCount = Math.max(
        1,
        Math.min(Engine.BLOOM_MAX_LEVELS, Math.floor(Math.log2(shortSide)) - 1),
      )
      this.bloomDownTexture = this.device.createTexture({
        label: "bloom down pyramid",
        size: [bw, bh],
        mipLevelCount: this.bloomMipCount,
        format: Engine.HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.bloomUpTexture = this.device.createTexture({
        label: "bloom up pyramid",
        size: [bw, bh],
        mipLevelCount: Math.max(1, this.bloomMipCount - 1),
        format: Engine.HDR_FORMAT,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.bloomDownMipViews = []
      for (let i = 0; i < this.bloomMipCount; i++) {
        this.bloomDownMipViews.push(
          this.bloomDownTexture.createView({ baseMipLevel: i, mipLevelCount: 1 }),
        )
      }
      this.bloomUpMipViews = []
      const upLevels = Math.max(1, this.bloomMipCount - 1)
      for (let i = 0; i < upLevels; i++) {
        this.bloomUpMipViews.push(
          this.bloomUpTexture.createView({ baseMipLevel: i, mipLevelCount: 1 }),
        )
      }

      this.depthTexture = this.device.createTexture({
        label: "depth texture",
        size: [width, height],
        sampleCount: Engine.MULTISAMPLE_COUNT,
        format: "depth24plus-stencil8",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })

      const depthTextureView = this.depthTexture.createView()

      const colorAttachment: GPURenderPassColorAttachment = {
        view: this.multisampleTexture.createView(),
        resolveTarget: this.hdrResolveTexture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }

      this.renderPassDescriptor = {
        label: "renderPass",
        colorAttachments: [colorAttachment],
        depthStencilAttachment: {
          view: depthTextureView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
          stencilClearValue: 0,
          stencilLoadOp: "clear",
          stencilStoreOp: "discard",
        },
      }

      // Composite pass descriptor (color attachment view patched per-frame to current swapchain).
      this.compositePassDescriptor = {
        label: "composite pass",
        colorAttachments: [
          {
            view: undefined as unknown as GPUTextureView,
            clearValue: { r: 0, g: 0, b: 0, a: 0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
      }

      this.writeBloomUniforms()

      if (this.compositeBindGroupLayout && this.bloomBlitBindGroupLayout) {
        // Blit: reads HDR resolve texture (full-res), writes bloomDown mip 0.
        this.bloomBlitBindGroup = this.device.createBindGroup({
          label: "bloom blit bind group",
          layout: this.bloomBlitBindGroupLayout,
          entries: [
            { binding: 0, resource: this.hdrResolveTexture.createView() },
            { binding: 1, resource: { buffer: this.bloomBlitUniformBuffer } },
          ],
        })
        // Downsample[i] reads bloomDown mip (i-1), writes bloomDown mip i. i ∈ [1..N-1].
        this.bloomDownsampleBindGroups = []
        for (let i = 1; i < this.bloomMipCount; i++) {
          this.bloomDownsampleBindGroups.push(
            this.device.createBindGroup({
              label: `bloom downsample ${i}`,
              layout: this.bloomDownsampleBindGroupLayout,
              entries: [
                { binding: 0, resource: this.bloomDownMipViews[i - 1] },
                { binding: 1, resource: this.bloomSampler },
              ],
            }),
          )
        }
        // Upsample[i] writes bloomUp mip i. Coarsest step reads bloomDown[N-1] (no prior up yet);
        // subsequent steps read bloomUp[i+1]. Both read bloomDown[i] as the base (additive combine).
        this.bloomUpsampleBindGroups = []
        const topIdx = this.bloomMipCount - 2
        for (let i = topIdx; i >= 0; i--) {
          const srcView = i === topIdx ? this.bloomDownMipViews[this.bloomMipCount - 1] : this.bloomUpMipViews[i + 1]
          this.bloomUpsampleBindGroups.push(
            this.device.createBindGroup({
              label: `bloom upsample ${i}`,
              layout: this.bloomUpsampleBindGroupLayout,
              entries: [
                { binding: 0, resource: srcView },
                { binding: 1, resource: this.bloomDownMipViews[i] },
                { binding: 2, resource: this.bloomSampler },
                { binding: 3, resource: { buffer: this.bloomUpsampleUniformBuffer } },
              ],
            }),
          )
        }
        // Composite reads bloomUp mip 0 (full pyramid collapsed); fallback to bloomDown mip 0 if no upsample level.
        const compositeBloomView = this.bloomMipCount > 1 ? this.bloomUpMipViews[0] : this.bloomDownMipViews[0]
        this.compositeBindGroup = this.device.createBindGroup({
          label: "composite bind group",
          layout: this.compositeBindGroupLayout,
          entries: [
            { binding: 0, resource: this.hdrResolveTexture.createView() },
            { binding: 1, resource: compositeBloomView },
            { binding: 2, resource: this.bloomSampler },
            { binding: 3, resource: { buffer: this.compositeUniformBuffer } },
          ],
        })
      }

      this.writeCompositeViewUniforms()

      this.camera.aspect = width / height

      if (this.onRaycast) {
        this.pickTexture = this.device.createTexture({
          label: "pick render target",
          size: [width, height],
          format: "rgba8unorm",
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
        })
        this.pickDepthTexture = this.device.createTexture({
          label: "pick depth",
          size: [width, height],
          format: "depth24plus",
          usage: GPUTextureUsage.RENDER_ATTACHMENT,
        })
      }
    }
  }

  // Step 4: Create camera and uniform buffer
  private setupCamera() {
    this.cameraUniformBuffer = this.device.createBuffer({
      label: "camera uniforms",
      size: 40 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.camera = new Camera(
      Math.PI,
      Math.PI / 2.5,
      this.cameraConfig.distance,
      this.cameraConfig.target,
      this.cameraConfig.fov,
    )

    this.camera.aspect = this.canvas.width / this.canvas.height
    this.camera.attachControl(this.canvas)
  }

  /** Set static camera look-at / orbit center. Clears any model follow binding. */
  setCameraTarget(v: Vec3): void
  /** Bind camera orbit center to a model's bone (Souls-style follow cam). Pass null to unbind. */
  setCameraTarget(model: Model | null, boneName: string, offset?: Vec3): void
  setCameraTarget(modelOrVec: Model | Vec3 | null, boneName?: string, offset?: Vec3): void {
    if (modelOrVec === null) {
      this.cameraTargetModel = null
      return
    }
    if ("x" in modelOrVec && "y" in modelOrVec && "z" in modelOrVec) {
      this.cameraTargetModel = null
      this.camera.target.x = modelOrVec.x
      this.camera.target.y = modelOrVec.y
      this.camera.target.z = modelOrVec.z
      return
    }
    this.cameraTargetModel = modelOrVec
    this.cameraTargetBoneName = boneName ?? ""
    this.cameraTargetOffset.x = offset?.x ?? 0
    this.cameraTargetOffset.y = offset?.y ?? 0
    this.cameraTargetOffset.z = offset?.z ?? 0
  }

  /** Souls-style follow cam: orbit center tracks a model bone each frame. Shorthand for setCameraTarget(model, boneName, offset). */
  setCameraFollow(model: Model | null, boneName?: string, offset?: Vec3): void {
    if (model === null) {
      this.cameraTargetModel = null
      return
    }
    this.cameraTargetModel = model
    this.cameraTargetBoneName = boneName ?? "全ての親"
    this.cameraTargetOffset.x = offset?.x ?? 0
    this.cameraTargetOffset.y = offset?.y ?? 0
    this.cameraTargetOffset.z = offset?.z ?? 0
  }

  getCameraDistance(): number {
    return this.camera.radius
  }
  setCameraDistance(d: number): void {
    this.camera.radius = d
  }
  getCameraAlpha(): number {
    return this.camera.alpha
  }
  setCameraAlpha(a: number): void {
    this.camera.alpha = a
  }
  getCameraBeta(): number {
    return this.camera.beta
  }
  setCameraBeta(b: number): void {
    this.camera.beta = b
  }

  // Step 5: Create lighting buffers
  private setupLighting() {
    this.lightUniformBuffer = this.device.createBuffer({
      label: "light uniforms",
      size: 64 * 4, // ambientColor vec4f (4) + 4 lights * 2 vec4f each (32) = 36 f32 padded to 64
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.lightData.fill(0)
    this.lightCount = 0
    this.writeWorld()
    this.writeSun(0)
  }

  /**
   * Write world ambient. For a uniform-radiance world, hemispherical irradiance
   * is E = π·L and a Lambertian BRDF reflects (albedo/π)·E = albedo·L, so the
   * shader's ambient uniform is just `world.color × world.strength` — no /π.
   */
  private writeWorld() {
    const s = this.world.strength
    this.lightData[0] = this.world.color.x * s
    this.lightData[1] = this.world.color.y * s
    this.lightData[2] = this.world.color.z * s
    this.lightData[3] = 0
    this.updateLightBuffer()
  }

  /** Write sun lamp into light slot `index` (0..3). Layout mirrors the WGSL struct. */
  private writeSun(index: number) {
    if (index < 0 || index >= 4) return
    const normalized = this.sun.direction.normalize()
    const base = 4 + index * 8 // 8 floats per light (direction vec4, color vec4)
    this.lightData[base] = normalized.x
    this.lightData[base + 1] = normalized.y
    this.lightData[base + 2] = normalized.z
    this.lightData[base + 3] = 0
    this.lightData[base + 4] = this.sun.color.x
    this.lightData[base + 5] = this.sun.color.y
    this.lightData[base + 6] = this.sun.color.z
    this.lightData[base + 7] = this.sun.strength
    if (index >= this.lightCount) this.lightCount = index + 1
    this.updateLightBuffer()
  }

  /** Update the world environment (Blender: World Background). Ambient recomputes immediately. */
  setWorld(options: WorldOptions): void {
    if (options.color) this.world.color = options.color
    if (options.strength !== undefined) this.world.strength = options.strength
    this.writeWorld()
  }

  /** Update the sun lamp (Blender: Light > Sun). Direction change marks shadow VP dirty. */
  setSun(options: SunOptions): void {
    if (options.color) this.sun.color = options.color
    if (options.strength !== undefined) this.sun.strength = options.strength
    if (options.direction) {
      this.sun.direction = options.direction
      this.shadowLightVPDirty = true
    }
    this.writeSun(0)
  }

  getWorld(): Readonly<{ color: Vec3; strength: number }> {
    return this.world
  }
  getSun(): Readonly<{ color: Vec3; strength: number; direction: Vec3 }> {
    return this.sun
  }

  addGround(options?: {
    width?: number
    height?: number
    diffuseColor?: Vec3
    fadeStart?: number
    fadeEnd?: number
    shadowStrength?: number
    gridSpacing?: number
    gridLineWidth?: number
    gridLineOpacity?: number
    gridLineColor?: Vec3
    noiseStrength?: number
  }): void {
    const opts = {
      width: 160,
      height: 160,
      diffuseColor: new Vec3(0.8, 0.1, 1.0),
      fadeStart: 10.0,
      fadeEnd: 80.0,
      shadowStrength: 1.0,
      gridSpacing: 4.2,
      gridLineWidth: 0.012,
      gridLineOpacity: 0.4,
      gridLineColor: new Vec3(0.85, 0.85, 0.85),
      noiseStrength: 0.05,
      ...options,
    }
    this.createGroundGeometry(opts.width, opts.height)
    this.createShadowGroundResources(opts)
    this.hasGround = true
    this.groundDrawCall = {
      type: "ground",
      count: 6,
      firstIndex: 0,
      bindGroup: this.groundShadowBindGroup!,
      materialName: "Ground",
      preset: "cloth_rough",
    }
  }

  private updateLightBuffer() {
    this.device.queue.writeBuffer(this.lightUniformBuffer, 0, this.lightData)
  }

  getStats(): EngineStats {
    return { ...this.stats }
  }

  runRenderLoop(callback?: () => void) {
    this.renderLoopCallback = callback || null

    const loop = () => {
      this.render()

      if (this.renderLoopCallback) {
        this.renderLoopCallback()
      }

      this.animationFrameId = requestAnimationFrame(loop)
    }

    this.animationFrameId = requestAnimationFrame(loop)
  }

  stopRenderLoop() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
    this.renderLoopCallback = null
  }

  dispose() {
    this.stopRenderLoop()
    this.forEachInstance((inst) => inst.model.stopAnimation())
    if (Engine.instance === this) Engine.instance = null
    if (this.camera) this.camera.detachControl()

    // Remove raycasting event listeners
    if (this.onRaycast) {
      this.canvas.removeEventListener("dblclick", this.handleCanvasDoubleClick)
      this.canvas.removeEventListener("touchend", this.handleCanvasTouch)
    }

    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
  }

  async loadModel(path: string): Promise<Model>
  async loadModel(name: string, path: string): Promise<Model>
  async loadModel(name: string, options: LoadModelFromFilesOptions): Promise<Model>
  async loadModel(nameOrPath: string, pathOrOptions?: string | LoadModelFromFilesOptions): Promise<Model> {
    if (pathOrOptions !== undefined && typeof pathOrOptions === "object" && "files" in pathOrOptions) {
      const name = nameOrPath
      const pmxFile = pathOrOptions.pmxFile ?? findFirstPmxFileInList(pathOrOptions.files)
      if (!pmxFile) throw new Error("No .pmx file found in the selected folder")
      const map = fileListToMap(pathOrOptions.files)
      const pmxKey = normalizeAssetPath(
        (pmxFile as File & { webkitRelativePath?: string }).webkitRelativePath ?? pmxFile.name,
      )
      const reader = createFileMapAssetReader(map)
      const model = await PmxLoader.loadFromReader(reader, pmxKey)
      model.setName(name)
      await this.addModel(model, pmxKey, name, reader)
      return model
    }

    const pmxPath = pathOrOptions === undefined ? nameOrPath : pathOrOptions
    const name = pathOrOptions === undefined ? "model_" + this._nextDefaultModelId++ : nameOrPath
    const model = await PmxLoader.load(pmxPath)
    model.setName(name)
    await this.addModel(model, pmxPath, name)
    return model
  }

  async addModel(model: Model, pmxPath: string, name?: string, assetReader?: AssetReader): Promise<string> {
    const requested = name ?? model.name
    let key = requested
    let n = 1
    while (this.modelInstances.has(key)) {
      key = `${requested}_${n++}`
    }
    const reader = assetReader ?? createFetchAssetReader()
    const basePath = deriveBasePathFromPmxPath(pmxPath)
    model.setAssetContext(reader, basePath)
    await this.setupModelInstance(key, model, basePath, reader)
    return key
  }

  removeModel(name: string): void {
    const inst = this.modelInstances.get(name)
    if (!inst) return
    inst.model.stopAnimation()
    for (const path of inst.textureCacheKeys) {
      const tex = this.textureCache.get(path)
      if (tex) {
        tex.destroy()
        this.textureCache.delete(path)
      }
    }
    for (const buf of inst.gpuBuffers) {
      buf.destroy()
    }
    this.modelInstances.delete(name)
  }

  getModelNames(): string[] {
    return Array.from(this.modelInstances.keys())
  }

  getModel(name: string): Model | null {
    return this.modelInstances.get(name)?.model ?? null
  }

  markVertexBufferDirty(modelNameOrModel?: string | Model): void {
    if (modelNameOrModel === undefined) return
    if (typeof modelNameOrModel === "string") {
      const inst = this.modelInstances.get(modelNameOrModel)
      if (inst) inst.vertexBufferNeedsUpdate = true
      return
    }
    for (const inst of this.modelInstances.values()) {
      if (inst.model === modelNameOrModel) {
        inst.vertexBufferNeedsUpdate = true
        return
      }
    }
  }

  setMaterialPresets(modelName: string, presets: MaterialPresetMap): void {
    const inst = this.modelInstances.get(modelName)
    if (!inst) return
    inst.materialPresets = presets
    for (const dc of inst.drawCalls) {
      dc.preset = resolvePreset(dc.materialName, presets)
    }
  }

  setMaterialVisible(modelName: string, materialName: string, visible: boolean): void {
    const inst = this.modelInstances.get(modelName)
    if (!inst) return
    if (visible) inst.hiddenMaterials.delete(materialName)
    else inst.hiddenMaterials.add(materialName)
  }

  toggleMaterialVisible(modelName: string, materialName: string): void {
    const inst = this.modelInstances.get(modelName)
    if (!inst) return
    if (inst.hiddenMaterials.has(materialName)) inst.hiddenMaterials.delete(materialName)
    else inst.hiddenMaterials.add(materialName)
  }

  isMaterialVisible(modelName: string, materialName: string): boolean {
    const inst = this.modelInstances.get(modelName)
    return inst ? !inst.hiddenMaterials.has(materialName) : false
  }

  setIKEnabled(enabled: boolean): void {
    this.ikEnabled = enabled
  }

  getIKEnabled(): boolean {
    return this.ikEnabled
  }

  setPhysicsEnabled(enabled: boolean): void {
    this.physicsEnabled = enabled
  }

  getPhysicsEnabled(): boolean {
    return this.physicsEnabled
  }

  private forEachInstance(fn: (inst: ModelInstance) => void): void {
    for (const inst of this.modelInstances.values()) fn(inst)
  }

  private updateInstances(deltaTime: number): void {
    this.forEachInstance((inst) => {
      const verticesChanged = inst.model.update(deltaTime, this.ikEnabled)
      if (verticesChanged) inst.vertexBufferNeedsUpdate = true
      if (inst.physics && this.physicsEnabled) {
        inst.physics.step(deltaTime, inst.model.getWorldMatrices(), inst.model.getBoneInverseBindMatrices())
      }
      if (inst.vertexBufferNeedsUpdate) this.updateVertexBuffer(inst)
    })
  }

  private updateVertexBuffer(inst: ModelInstance): void {
    const vertices = inst.model.getVertices()
    if (!vertices?.length) return
    this.device.queue.writeBuffer(inst.vertexBuffer, 0, vertices)
    inst.vertexBufferNeedsUpdate = false
  }

  private async setupModelInstance(
    name: string,
    model: Model,
    basePath: string,
    assetReader: AssetReader,
  ): Promise<void> {
    const vertices = model.getVertices()
    const skinning = model.getSkinning()
    const skeleton = model.getSkeleton()
    const boneCount = skeleton.bones.length
    const matrixSize = boneCount * 16 * 4

    const vertexBuffer = this.device.createBuffer({
      label: `${name}: vertex buffer`,
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(vertexBuffer, 0, vertices)

    const jointsBuffer = this.device.createBuffer({
      label: `${name}: joints buffer`,
      size: skinning.joints.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(
      jointsBuffer,
      0,
      skinning.joints.buffer,
      skinning.joints.byteOffset,
      skinning.joints.byteLength,
    )

    const weightsBuffer = this.device.createBuffer({
      label: `${name}: weights buffer`,
      size: skinning.weights.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(
      weightsBuffer,
      0,
      skinning.weights.buffer,
      skinning.weights.byteOffset,
      skinning.weights.byteLength,
    )

    const skinMatrixBuffer = this.device.createBuffer({
      label: `${name}: skin matrices`,
      size: Math.max(256, matrixSize),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })

    const indices = model.getIndices()
    if (!indices) throw new Error("Model has no index buffer")
    const indexBuffer = this.device.createBuffer({
      label: `${name}: index buffer`,
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(indexBuffer, 0, indices)

    const rbs = model.getRigidbodies()
    const physics = rbs.length > 0 ? new Physics(rbs, model.getJoints(), this.physicsOptions) : null

    const shadowBindGroup = this.device.createBindGroup({
      label: `${name}: shadow bind`,
      layout: this.shadowDepthPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.shadowLightVPBuffer } },
        { binding: 1, resource: { buffer: skinMatrixBuffer } },
      ],
    })

    const mainPerInstanceBindGroup = this.device.createBindGroup({
      label: `${name}: main per-instance bind group`,
      layout: this.mainPerInstanceBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: skinMatrixBuffer } }],
    })

    const pickPerInstanceBindGroup = this.device.createBindGroup({
      label: `${name}: pick per-instance bind group`,
      layout: this.pickPerInstanceBindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: skinMatrixBuffer } }],
    })

    const gpuBuffers: GPUBuffer[] = [vertexBuffer, indexBuffer, jointsBuffer, weightsBuffer, skinMatrixBuffer]

    const inst: ModelInstance = {
      name,
      model,
      basePath,
      assetReader,
      gpuBuffers,
      textureCacheKeys: [],
      vertexBuffer,
      indexBuffer,
      jointsBuffer,
      weightsBuffer,
      skinMatrixBuffer,
      drawCalls: [],
      shadowDrawCalls: [],
      shadowBindGroup,
      mainPerInstanceBindGroup,
      pickPerInstanceBindGroup,
      pickDrawCalls: [],
      hiddenMaterials: new Set(),
      materialPresets: undefined,
      physics,
      vertexBufferNeedsUpdate: false,
    }
    await this.setupMaterialsForInstance(inst)
    this.modelInstances.set(name, inst)
  }

  private createGroundGeometry(width: number = 100, height: number = 100) {
    const halfWidth = width / 2
    const halfHeight = height / 2

    const vertices = new Float32Array([
      // Bottom-left
      -halfWidth,
      0,
      -halfHeight, // position
      0,
      1,
      0, // normal (up)
      0,
      0, // uv

      // Bottom-right
      halfWidth,
      0,
      -halfHeight, // position
      0,
      1,
      0, // normal (up)
      1,
      0, // uv

      // Top-right
      halfWidth,
      0,
      halfHeight, // position
      0,
      1,
      0, // normal (up)
      1,
      1, // uv

      // Top-left
      -halfWidth,
      0,
      halfHeight, // position
      0,
      1,
      0, // normal (up)
      0,
      1, // uv
    ])

    // Create indices for two triangles
    const indices = new Uint16Array([
      0,
      1,
      2, // First triangle
      0,
      2,
      3, // Second triangle
    ])

    // Create vertex buffer
    this.groundVertexBuffer = this.device.createBuffer({
      label: "ground vertex buffer",
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(this.groundVertexBuffer, 0, vertices)

    this.groundIndexBuffer = this.device.createBuffer({
      label: "ground index buffer",
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(this.groundIndexBuffer, 0, indices)
  }

  private createShadowGroundResources(opts: {
    diffuseColor: Vec3
    fadeStart: number
    fadeEnd: number
    shadowStrength: number
    gridSpacing: number
    gridLineWidth: number
    gridLineOpacity: number
    gridLineColor: Vec3
    noiseStrength: number
  }) {
    const {
      diffuseColor,
      fadeStart,
      fadeEnd,
      shadowStrength,
      gridSpacing,
      gridLineWidth,
      gridLineOpacity,
      gridLineColor,
      noiseStrength,
    } = opts
    // Shadow map is already created in setupPipelines()
    const gb = new Float32Array(16)
    gb[0] = diffuseColor.x
    gb[1] = diffuseColor.y
    gb[2] = diffuseColor.z
    gb[3] = fadeStart
    gb[4] = fadeEnd
    gb[5] = shadowStrength
    gb[6] = 1 / Engine.SHADOW_MAP_SIZE
    gb[7] = gridSpacing
    gb[8] = gridLineWidth
    gb[9] = gridLineOpacity
    gb[10] = noiseStrength
    gb[11] = 0
    gb[12] = gridLineColor.x
    gb[13] = gridLineColor.y
    gb[14] = gridLineColor.z
    gb[15] = 0
    this.groundShadowMaterialBuffer = this.device.createBuffer({
      size: gb.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(this.groundShadowMaterialBuffer, 0, gb)
    this.groundShadowBindGroup = this.device.createBindGroup({
      label: "ground shadow bind",
      layout: this.groundShadowBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraUniformBuffer } },
        { binding: 1, resource: { buffer: this.lightUniformBuffer } },
        { binding: 2, resource: this.shadowMapDepthView },
        { binding: 3, resource: this.shadowComparisonSampler },
        { binding: 4, resource: { buffer: this.groundShadowMaterialBuffer } },
        { binding: 5, resource: { buffer: this.shadowLightVPBuffer } },
      ],
    })
  }

  // Shadow is cast from the visible sun direction — same vector the shader lights with.
  private shadowLightVPDirty = true
  private updateShadowLightVP() {
    if (!this.shadowLightVPDirty) return
    this.shadowLightVPDirty = false
    const dir = new Vec3(this.sun.direction.x, this.sun.direction.y, this.sun.direction.z)
    dir.normalize()
    const target = new Vec3(0, 11, 0)
    const eye = new Vec3(target.x - dir.x * 72, target.y - dir.y * 72, target.z - dir.z * 72)
    const up = Math.abs(dir.y) > 0.99 ? new Vec3(0, 0, -1) : new Vec3(0, 1, 0)
    const view = Mat4.lookAt(eye, target, up)
    const proj = Mat4.orthographicLh(-72, 72, -72, 72, 1, 140)
    const vp = proj.multiply(view)
    this.shadowLightVPMatrix.set(vp.values)
    this.device.queue.writeBuffer(this.shadowLightVPBuffer, 0, this.shadowLightVPMatrix)
  }

  private async setupMaterialsForInstance(inst: ModelInstance): Promise<void> {
    const model = inst.model
    const materials = model.getMaterials()
    if (materials.length === 0) throw new Error("Model has no materials")
    const textures = model.getTextures()
    const prefix = `${inst.name}: `
    // 1-based so that (0,0) = clear color = "no hit"
    const modelId = this.modelInstances.size + 1

    const loadTextureByIndex = async (texIndex: number): Promise<GPUTexture | null> => {
      if (texIndex < 0 || texIndex >= textures.length) return null
      const logicalPath = joinAssetPath(inst.basePath, normalizeAssetPath(textures[texIndex].path))
      return this.createTextureFromLogicalPath(inst, logicalPath)
    }

    let currentIndexOffset = 0
    let materialId = 0
    for (const mat of materials) {
      const indexCount = mat.vertexCount
      if (indexCount === 0) continue
      materialId++

      const diffuseTexture = await loadTextureByIndex(mat.diffuseTextureIndex)
      if (!diffuseTexture) throw new Error(`Material "${mat.name}" has no diffuse texture`)

      const materialAlpha = mat.diffuse[3]
      const isTransparent = materialAlpha < 1.0 - 0.001

      const materialUniformBuffer = this.createMaterialUniformBuffer(prefix + mat.name, materialAlpha, [
        mat.diffuse[0],
        mat.diffuse[1],
        mat.diffuse[2],
      ])
      inst.gpuBuffers.push(materialUniformBuffer)

      const textureView = diffuseTexture.createView()
      const bindGroup = this.device.createBindGroup({
        label: `${prefix}material: ${mat.name}`,
        layout: this.mainPerMaterialBindGroupLayout,
        entries: [
          { binding: 0, resource: textureView },
          { binding: 1, resource: { buffer: materialUniformBuffer } },
        ],
      })

      const type: DrawCallType = isTransparent ? "transparent" : "opaque"
      const preset = resolvePreset(mat.name, inst.materialPresets)
      inst.drawCalls.push({
        type,
        count: indexCount,
        firstIndex: currentIndexOffset,
        bindGroup,
        materialName: mat.name,
        preset,
      })

      if ((mat.edgeFlag & 0x10) !== 0 && mat.edgeSize > 0) {
        const materialUniformData = new Float32Array([
          mat.edgeColor[0],
          mat.edgeColor[1],
          mat.edgeColor[2],
          mat.edgeColor[3],
          mat.edgeSize,
          0,
          0,
          0,
        ])
        const outlineUniformBuffer = this.createUniformBuffer(`${prefix}outline: ${mat.name}`, materialUniformData)
        inst.gpuBuffers.push(outlineUniformBuffer)
        const outlineBindGroup = this.device.createBindGroup({
          label: `${prefix}outline: ${mat.name}`,
          layout: this.outlinePerMaterialBindGroupLayout,
          entries: [{ binding: 0, resource: { buffer: outlineUniformBuffer } }],
        })
        const outlineType: DrawCallType = isTransparent ? "transparent-outline" : "opaque-outline"
        inst.drawCalls.push({
          type: outlineType,
          count: indexCount,
          firstIndex: currentIndexOffset,
          bindGroup: outlineBindGroup,
          materialName: mat.name,
          preset,
        })
      }

      if (this.onRaycast) {
        const pickIdData = new Float32Array([modelId, materialId, 0, 0])
        const pickIdBuffer = this.createUniformBuffer(`${prefix}pick: ${mat.name}`, pickIdData)
        inst.gpuBuffers.push(pickIdBuffer)
        const pickBindGroup = this.device.createBindGroup({
          label: `${prefix}pick: ${mat.name}`,
          layout: this.pickPerMaterialBindGroupLayout,
          entries: [{ binding: 0, resource: { buffer: pickIdBuffer } }],
        })
        inst.pickDrawCalls.push({ count: indexCount, firstIndex: currentIndexOffset, bindGroup: pickBindGroup })
      }

      currentIndexOffset += indexCount
    }

    for (const d of inst.drawCalls) {
      if (d.type === "opaque") inst.shadowDrawCalls.push(d)
    }
  }

  private createMaterialUniformBuffer(label: string, alpha: number, diffuseColor: [number, number, number]): GPUBuffer {
    // Matches WGSL `struct MaterialUniforms { diffuseColor: vec3f, alpha: f32 }` — 16 bytes.
    const data = new Float32Array(4)
    data[0] = diffuseColor[0]
    data[1] = diffuseColor[1]
    data[2] = diffuseColor[2]
    data[3] = alpha
    return this.createUniformBuffer(`material uniform: ${label}`, data)
  }

  private createUniformBuffer(label: string, data: Float32Array | Uint32Array): GPUBuffer {
    const buffer = this.device.createBuffer({
      label,
      size: data.byteLength,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(buffer, 0, data as ArrayBufferView<ArrayBuffer>)
    return buffer
  }

  private shouldRenderDrawCall(inst: ModelInstance, drawCall: DrawCall): boolean {
    return !inst.hiddenMaterials.has(drawCall.materialName)
  }

  private async createTextureFromLogicalPath(inst: ModelInstance, logicalPath: string): Promise<GPUTexture | null> {
    const cacheKey = logicalPath
    const cached = this.textureCache.get(cacheKey)
    if (cached) {
      return cached
    }

    try {
      const buffer = await inst.assetReader.readBinary(logicalPath)
      const imageBitmap = await createImageBitmap(new Blob([buffer]), {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      })

      const texture = this.device.createTexture({
        label: `texture: ${cacheKey}`,
        size: [imageBitmap.width, imageBitmap.height],
        format: "rgba8unorm-srgb",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      this.device.queue.copyExternalImageToTexture({ source: imageBitmap }, { texture }, [
        imageBitmap.width,
        imageBitmap.height,
      ])

      this.textureCache.set(cacheKey, texture)
      inst.textureCacheKeys.push(cacheKey)
      return texture
    } catch {
      return null
    }
  }

  private renderGround(pass: GPURenderPassEncoder) {
    if (!this.hasGround || !this.groundVertexBuffer || !this.groundIndexBuffer || !this.groundDrawCall) return
    pass.setPipeline(this.groundShadowPipeline)
    pass.setVertexBuffer(0, this.groundVertexBuffer)
    pass.setIndexBuffer(this.groundIndexBuffer, "uint16")
    pass.setBindGroup(0, this.groundDrawCall.bindGroup)
    pass.drawIndexed(this.groundDrawCall.count, 1, this.groundDrawCall.firstIndex, 0, 0)
  }

  private handleCanvasDoubleClick = (event: MouseEvent) => {
    if (!this.onRaycast || this.modelInstances.size === 0) return
    const rect = this.canvas.getBoundingClientRect()
    this.performRaycast(event.clientX - rect.left, event.clientY - rect.top)
  }

  private handleCanvasTouch = (event: TouchEvent) => {
    if (!this.onRaycast || this.modelInstances.size === 0) return

    // Prevent default to avoid triggering mouse events
    event.preventDefault()

    // Get the first touch
    const touch = event.changedTouches[0]
    if (!touch) return

    const currentTime = Date.now()
    const timeDiff = currentTime - this.lastTouchTime

    // Check for double-tap (within delay threshold)
    if (timeDiff < this.DOUBLE_TAP_DELAY) {
      const rect = this.canvas.getBoundingClientRect()
      const x = touch.clientX - rect.left
      const y = touch.clientY - rect.top

      this.performRaycast(x, y)
      // Reset last touch time to prevent triple-tap triggering double-tap
      this.lastTouchTime = 0
    } else {
      // Single tap - update last touch time for potential double-tap
      this.lastTouchTime = currentTime
    }
  }

  private performRaycast(screenX: number, screenY: number) {
    if (!this.onRaycast || this.modelInstances.size === 0) {
      this.onRaycast?.("", null, screenX, screenY)
      return
    }
    const dpr = window.devicePixelRatio || 1
    this.pendingPick = { x: Math.floor(screenX * dpr), y: Math.floor(screenY * dpr) }
  }

  private renderPickPass(encoder: GPUCommandEncoder): void {
    if (!this.pendingPick || !this.pickTexture || !this.pickDepthTexture) return

    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: this.pickTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
      depthStencilAttachment: {
        view: this.pickDepthTexture.createView(),
        depthClearValue: 1.0,
        depthLoadOp: "clear",
        depthStoreOp: "store",
      },
    })

    pass.setPipeline(this.pickPipeline)
    pass.setBindGroup(0, this.pickPerFrameBindGroup)

    this.forEachInstance((inst) => {
      pass.setVertexBuffer(0, inst.vertexBuffer)
      pass.setVertexBuffer(1, inst.jointsBuffer)
      pass.setVertexBuffer(2, inst.weightsBuffer)
      pass.setIndexBuffer(inst.indexBuffer, "uint32")
      pass.setBindGroup(1, inst.pickPerInstanceBindGroup)
      for (const draw of inst.pickDrawCalls) {
        pass.setBindGroup(2, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    })

    pass.end()

    // Copy the single pixel under cursor to readback buffer
    const px = Math.min(this.pendingPick.x, this.pickTexture.width - 1)
    const py = Math.min(this.pendingPick.y, this.pickTexture.height - 1)
    encoder.copyTextureToBuffer(
      { texture: this.pickTexture, origin: { x: Math.max(0, px), y: Math.max(0, py) } },
      { buffer: this.pickReadbackBuffer, bytesPerRow: 256 },
      { width: 1, height: 1 },
    )
  }

  private async resolvePickResult(screenX: number, screenY: number): Promise<void> {
    if (!this.onRaycast) return
    await this.pickReadbackBuffer.mapAsync(GPUMapMode.READ)
    const data = new Uint8Array(this.pickReadbackBuffer.getMappedRange())
    const modelId = data[0]
    const materialId = data[1]
    this.pickReadbackBuffer.unmap()

    if (modelId === 0) {
      this.onRaycast("", null, screenX, screenY)
      return
    }

    // Find model by 1-based index
    let idx = 1
    let hitModel = ""
    for (const [name] of this.modelInstances) {
      if (idx === modelId) {
        hitModel = name
        break
      }
      idx++
    }

    // Find material by 1-based index (skipping zero-vertex materials)
    let hitMaterial: string | null = null
    if (hitModel) {
      const inst = this.modelInstances.get(hitModel)
      if (inst) {
        const materials = inst.model.getMaterials()
        let matIdx = 0
        for (const mat of materials) {
          if (mat.vertexCount === 0) continue
          matIdx++
          if (matIdx === materialId) {
            hitMaterial = mat.name
            break
          }
        }
      }
    }

    this.onRaycast(hitModel, hitMaterial, screenX, screenY)
  }

  render() {
    if (!this.multisampleTexture || !this.camera || !this.device) return

    const currentTime = performance.now()
    const deltaTime = this.lastFrameTime > 0 ? (currentTime - this.lastFrameTime) / 1000 : 0.016
    this.lastFrameTime = currentTime

    const hasModels = this.modelInstances.size > 0
    if (hasModels) {
      this.updateInstances(deltaTime)
      this.updateSkinMatrices()
      // Update camera target from bound model (bone not found → 0,0,0 + offset)
      if (this.cameraTargetModel) {
        const pos = this.cameraTargetModel.getBoneWorldPosition(this.cameraTargetBoneName)
        const px = pos?.x ?? 0
        const py = pos?.y ?? 0
        const pz = pos?.z ?? 0
        this.camera.target.x = px + this.cameraTargetOffset.x
        this.camera.target.y = py + this.cameraTargetOffset.y
        this.camera.target.z = pz + this.cameraTargetOffset.z
      }
    }

    this.updateCameraUniforms()
    this.updateShadowLightVP()

    const encoder = this.device.createCommandEncoder()
    if (hasModels) {
      const sp = encoder.beginRenderPass({
        colorAttachments: [],
        depthStencilAttachment: {
          view: this.shadowMapDepthView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        },
      })
      sp.setPipeline(this.shadowDepthPipeline)
      this.forEachInstance((inst) => this.drawInstanceShadow(sp, inst))
      sp.end()
    }

    const pass = encoder.beginRenderPass(this.renderPassDescriptor)
    if (hasModels) this.forEachInstance((inst) => this.renderOneModel(pass, inst))
    if (this.hasGround) this.renderGround(pass)
    pass.end()

    // Bloom pyramid (EEVEE 3.6):
    //   1. Blit: HDR → bloomDown[0] (Karis prefilter, half-res)
    //   2. Downsample: bloomDown[0] → bloomDown[1] → … → bloomDown[N-1] (13-tap)
    //   3. Upsample (top-down): bloomUp[N-2] = tent(bloomDown[N-1]) + bloomDown[N-2],
    //      then bloomUp[i] = tent(bloomUp[i+1]) + bloomDown[i] until i=0 (9-tap tent)
    //   Composite reads bloomUp[0] and adds tint * intensity * bloom before Filmic.
    if (this.bloomBlitBindGroup && this.compositeBindGroup && this.bloomMipCount > 0) {
      const bloomAtt = this.bloomPassDescriptor.colorAttachments as GPURenderPassColorAttachment[]

      // 1. Blit
      bloomAtt[0].view = this.bloomDownMipViews[0]
      const pBlit = encoder.beginRenderPass(this.bloomPassDescriptor)
      pBlit.setPipeline(this.bloomBlitPipeline)
      pBlit.setBindGroup(0, this.bloomBlitBindGroup)
      pBlit.draw(3)
      pBlit.end()

      // 2. Downsample chain
      for (let i = 1; i < this.bloomMipCount; i++) {
        bloomAtt[0].view = this.bloomDownMipViews[i]
        const p = encoder.beginRenderPass(this.bloomPassDescriptor)
        p.setPipeline(this.bloomDownsamplePipeline)
        p.setBindGroup(0, this.bloomDownsampleBindGroups[i - 1])
        p.draw(3)
        p.end()
      }

      // 3. Upsample chain (coarsest to finest; bindGroups[0] is the coarsest step)
      const upSteps = this.bloomUpsampleBindGroups.length
      const topIdx = this.bloomMipCount - 2
      for (let k = 0; k < upSteps; k++) {
        const levelIdx = topIdx - k // writes bloomUp[levelIdx]
        bloomAtt[0].view = this.bloomUpMipViews[levelIdx]
        const p = encoder.beginRenderPass(this.bloomPassDescriptor)
        p.setPipeline(this.bloomUpsamplePipeline)
        p.setBindGroup(0, this.bloomUpsampleBindGroups[k])
        p.draw(3)
        p.end()
      }
    }

    // Composite: HDR + bloom → Filmic tonemap → swapchain.
    const compositeAttachment = (this.compositePassDescriptor.colorAttachments as GPURenderPassColorAttachment[])[0]
    compositeAttachment.view = this.context.getCurrentTexture().createView()
    const cpass = encoder.beginRenderPass(this.compositePassDescriptor)
    cpass.setPipeline(this.compositePipeline)
    cpass.setBindGroup(0, this.compositeBindGroup)
    cpass.draw(3)
    cpass.end()

    const pick = this.pendingPick
    if (pick && hasModels) this.renderPickPass(encoder)

    this.device.queue.submit([encoder.finish()])

    if (pick) {
      this.pendingPick = null
      const dpr = window.devicePixelRatio || 1
      this.resolvePickResult(pick.x / dpr, pick.y / dpr)
    }

    this.updateStats(performance.now() - currentTime)
  }

  private drawInstanceShadow(sp: GPURenderPassEncoder, inst: ModelInstance): void {
    sp.setBindGroup(0, inst.shadowBindGroup)
    sp.setVertexBuffer(0, inst.vertexBuffer)
    sp.setVertexBuffer(1, inst.jointsBuffer)
    sp.setVertexBuffer(2, inst.weightsBuffer)
    sp.setIndexBuffer(inst.indexBuffer, "uint32")
    for (const draw of inst.shadowDrawCalls) {
      if (this.shouldRenderDrawCall(inst, draw)) sp.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
    }
  }

  private pipelineForPreset(preset: MaterialPreset): GPURenderPipeline {
    if (preset === "face") return this.facePipeline
    if (preset === "hair") return this.hairPipeline
    if (preset === "cloth_smooth") return this.clothSmoothPipeline
    if (preset === "body") return this.bodyPipeline
    if (preset === "eye") return this.eyePipeline
    return this.modelPipeline
  }

  /**
   * Draw every material of a given type (`opaque` or `transparent`) using the main
   * pipeline(s). Binds the per-frame and per-instance groups once at the top of the
   * batch, then issues one draw per material. Early-outs if nothing to draw so we
   * don't waste bindings when a model has no transparents, etc.
   */
  private drawMaterials(pass: GPURenderPassEncoder, inst: ModelInstance, type: "opaque" | "transparent"): void {
    let currentPipeline: GPURenderPipeline | null = null
    let bound = false
    for (const draw of inst.drawCalls) {
      if (draw.type !== type || !this.shouldRenderDrawCall(inst, draw)) continue
      if (!bound) {
        pass.setBindGroup(0, this.perFrameBindGroup)
        pass.setBindGroup(1, inst.mainPerInstanceBindGroup)
        bound = true
      }
      const pipeline = this.pipelineForPreset(draw.preset)
      if (pipeline !== currentPipeline) {
        pass.setPipeline(pipeline)
        currentPipeline = pipeline
      }
      pass.setBindGroup(2, draw.bindGroup)
      pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
    }
  }

  /**
   * Draw every outline of a given type (`opaque-outline` or `transparent-outline`).
   * Uses its own pipeline layout (group 0 = camera-only, group 2 = edge uniforms), so
   * every batch binds its own groups from scratch — the next drawMaterials call will
   * rebind group 0/1 correctly if needed.
   */
  private drawOutlines(pass: GPURenderPassEncoder, inst: ModelInstance, type: DrawCallType): void {
    let bound = false
    for (const draw of inst.drawCalls) {
      if (draw.type !== type || !this.shouldRenderDrawCall(inst, draw)) continue
      if (!bound) {
        pass.setPipeline(this.outlinePipeline)
        pass.setBindGroup(0, this.outlinePerFrameBindGroup)
        pass.setBindGroup(1, inst.mainPerInstanceBindGroup)
        bound = true
      }
      pass.setBindGroup(2, draw.bindGroup)
      pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
    }
  }

  /**
   * Main-pass render sequence for one model instance:
   *   1) opaque bodies → 2) opaque outlines → 3) transparents → 4) transparent outlines.
   * Each batch binds the groups it needs, so switching between main and outline
   * pipelines is self-contained (no cross-batch dependencies).
   */
  private renderOneModel(pass: GPURenderPassEncoder, inst: ModelInstance): void {
    pass.setVertexBuffer(0, inst.vertexBuffer)
    pass.setVertexBuffer(1, inst.jointsBuffer)
    pass.setVertexBuffer(2, inst.weightsBuffer)
    pass.setIndexBuffer(inst.indexBuffer, "uint32")

    this.drawMaterials(pass, inst, "opaque")
    this.drawOutlines(pass, inst, "opaque-outline")
    this.drawMaterials(pass, inst, "transparent")
    this.drawOutlines(pass, inst, "transparent-outline")
  }

  private updateCameraUniforms() {
    const viewMatrix = this.camera.getViewMatrix()
    const projectionMatrix = this.camera.getProjectionMatrix()
    const cameraPos = this.camera.getPosition()
    this.cameraMatrixData.set(viewMatrix.values, 0)
    this.cameraMatrixData.set(projectionMatrix.values, 16)
    this.cameraMatrixData[32] = cameraPos.x
    this.cameraMatrixData[33] = cameraPos.y
    this.cameraMatrixData[34] = cameraPos.z
    this.device.queue.writeBuffer(this.cameraUniformBuffer, 0, this.cameraMatrixData)
  }

  private updateSkinMatrices() {
    this.forEachInstance((inst) => {
      const skinMatrices = inst.model.getSkinMatrices()
      this.device.queue.writeBuffer(
        inst.skinMatrixBuffer,
        0,
        skinMatrices.buffer,
        skinMatrices.byteOffset,
        skinMatrices.byteLength,
      )
    })
  }

  private updateStats(frameTime: number) {
    // Simplified frame time tracking - rolling average with fixed window
    const maxSamples = 60
    this.frameTimeSum += frameTime
    this.frameTimeCount++
    if (this.frameTimeCount > maxSamples) {
      // Maintain rolling window by subtracting oldest sample estimate
      const avg = this.frameTimeSum / maxSamples
      this.frameTimeSum -= avg
      this.frameTimeCount = maxSamples
    }
    this.stats.frameTime = Math.round((this.frameTimeSum / this.frameTimeCount) * 100) / 100

    // FPS tracking
    const now = performance.now()
    this.framesSinceLastUpdate++
    const elapsed = now - this.lastFpsUpdate

    if (elapsed >= 1000) {
      this.stats.fps = Math.round((this.framesSinceLastUpdate / elapsed) * 1000)
      this.framesSinceLastUpdate = 0
      this.lastFpsUpdate = now
    }
  }
}
