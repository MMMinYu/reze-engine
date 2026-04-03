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

export type RaycastCallback = (modelName: string, material: string | null, screenX: number, screenY: number) => void

/** Select a folder (webkitdirectory) and pass FileList or File[]; pmxFile picks which .pmx when several exist. */
export type LoadModelFromFilesOptions = {
  files: FileList | File[]
  pmxFile?: File
}

export type EngineOptions = {
  ambientColor?: Vec3
  directionalLightIntensity?: number
  minSpecularIntensity?: number
  rimLightIntensity?: number
  cameraDistance?: number
  cameraTarget?: Vec3
  cameraFov?: number
  onRaycast?: RaycastCallback
  physicsOptions?: PhysicsOptions
  shadowLightDirection?: Vec3
}

export const DEFAULT_ENGINE_OPTIONS = {
  ambientColor: new Vec3(0.88, 0.88, 0.88),
  directionalLightIntensity: 0.24,
  minSpecularIntensity: 0.3,
  rimLightIntensity: 0.4,
  cameraDistance: 26.6,
  cameraTarget: new Vec3(0, 12.5, 0),
  cameraFov: Math.PI / 4,
  onRaycast: undefined,
  physicsOptions: { constraintSolverKeywords: ["胸"] },
  shadowLightDirection: new Vec3(0.12, -1, 0.16),
}

export interface EngineStats {
  fps: number
  frameTime: number // ms
}

type DrawCallType =
  | "opaque"
  | "transparent"
  | "ground"
  | "opaque-outline"
  | "transparent-outline"

interface DrawCall {
  type: DrawCallType
  count: number
  firstIndex: number
  bindGroup: GPUBindGroup
  materialName: string
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
  private cameraDistance!: number
  private cameraTarget!: Vec3
  private cameraFov!: number
  private lightUniformBuffer!: GPUBuffer
  private lightData = new Float32Array(64)
  private lightCount = 0
  private resizeObserver: ResizeObserver | null = null
  private depthTexture!: GPUTexture
  private modelPipeline!: GPURenderPipeline
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
  private static readonly MULTISAMPLE_COUNT = 4
  private renderPassDescriptor!: GPURenderPassDescriptor

  // Ambient light settings
  private ambientColor!: Vec3
  private directionalLightIntensity!: number
  private minSpecularIntensity!: number
  // Rim light settings
  private rimLightIntensity!: number

  // Ground properties (shadow only)
  private groundVertexBuffer?: GPUBuffer
  private groundIndexBuffer?: GPUBuffer
  private hasGround = false
  private shadowMapTexture?: GPUTexture
  private shadowMapDepthView?: GPUTextureView
  private shadowDepthPipeline!: GPURenderPipeline
  private shadowLightVPBuffer!: GPUBuffer
  private shadowLightVPMatrix = new Float32Array(16)
  private groundShadowBindGroup?: GPUBindGroup
  private shadowComparisonSampler!: GPUSampler
  private groundShadowMaterialBuffer?: GPUBuffer
  private groundDrawCall: DrawCall | null = null

  private onRaycast?: RaycastCallback
  private physicsOptions: PhysicsOptions = DEFAULT_ENGINE_OPTIONS.physicsOptions
  private shadowLightDirection: Vec3 = DEFAULT_ENGINE_OPTIONS.shadowLightDirection
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

  constructor(canvas: HTMLCanvasElement, options?: EngineOptions) {
    this.canvas = canvas
    if (options) {
      this.ambientColor = options.ambientColor ?? DEFAULT_ENGINE_OPTIONS.ambientColor
      this.directionalLightIntensity =
        options.directionalLightIntensity ?? DEFAULT_ENGINE_OPTIONS.directionalLightIntensity
      this.minSpecularIntensity = options.minSpecularIntensity ?? DEFAULT_ENGINE_OPTIONS.minSpecularIntensity
      this.rimLightIntensity = options.rimLightIntensity ?? DEFAULT_ENGINE_OPTIONS.rimLightIntensity
      this.cameraDistance = options.cameraDistance ?? DEFAULT_ENGINE_OPTIONS.cameraDistance
      this.cameraTarget = options.cameraTarget ?? DEFAULT_ENGINE_OPTIONS.cameraTarget
      this.cameraFov = options.cameraFov ?? DEFAULT_ENGINE_OPTIONS.cameraFov
      this.onRaycast = options.onRaycast
      this.physicsOptions = options.physicsOptions ?? DEFAULT_ENGINE_OPTIONS.physicsOptions
      this.shadowLightDirection = options.shadowLightDirection ?? DEFAULT_ENGINE_OPTIONS.shadowLightDirection
    }
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

    const standardBlend: GPUColorTargetState = {
      format: this.presentationFormat,
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
      label: "model shaders",
      code: /* wgsl */ `
        struct CameraUniforms {
          view: mat4x4f,
          projection: mat4x4f,
          viewPos: vec3f,
          _padding: f32,
        };

        struct Light {
          direction: vec4f,
          color: vec4f,
        };

        struct LightUniforms {
          ambientColor: vec4f,
          lights: array<Light, 4>,
        };

        struct MaterialUniforms {
          alpha: f32,
          rimIntensity: f32,
          shininess: f32,
          _padding1: f32,
          rimColor: vec3f,
          _padding2: f32,
          diffuseColor: vec3f,
          _padding3: f32,
          ambientColor: vec3f,
          _padding4: f32,
          specularColor: vec3f,
          _padding5: f32,
        };

        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) normal: vec3f,
          @location(1) uv: vec2f,
          @location(2) worldPos: vec3f,
        };

        // group 0: per-frame (bound once per pass)
        @group(0) @binding(0) var<uniform> camera: CameraUniforms;
        @group(0) @binding(1) var<uniform> light: LightUniforms;
        @group(0) @binding(2) var diffuseSampler: sampler;
        // group 1: per-instance (bound once per model)
        @group(1) @binding(0) var<storage, read> skinMats: array<mat4x4f>;
        // group 2: per-material (bound per draw call)
        @group(2) @binding(0) var diffuseTexture: texture_2d<f32>;
        @group(2) @binding(1) var<uniform> material: MaterialUniforms;

        @vertex fn vs(
          @location(0) position: vec3f,
          @location(1) normal: vec3f,
          @location(2) uv: vec2f,
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
          output.position = camera.projection * camera.view * vec4f(worldPos, 1.0);
          output.normal = normalize(skinnedNrm);
          output.uv = uv;
          output.worldPos = worldPos;
          return output;
        }

        @fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
          let finalAlpha = material.alpha;
          if (finalAlpha < 0.001) {
            discard;
          }
          
          let n = normalize(input.normal);
          let textureColor = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;

          let viewDir = normalize(camera.viewPos - input.worldPos);

          let albedo = textureColor * material.diffuseColor;
          
          let minSpec = light.ambientColor.w;
          let effectiveSpecular = max(material.specularColor, vec3f(minSpec));
          let specPower = max(material.shininess, 1.0);
          
          let l = -light.lights[0].direction.xyz;
          let nDotL = max(dot(n, l), 0.0);
          let intensity = light.lights[0].color.w;
          let radiance = light.lights[0].color.xyz * intensity;
          
          let lightAccum = light.ambientColor.xyz + radiance * nDotL;

          let h = normalize(l + viewDir);
          let nDotH = max(dot(n, h), 0.0);
          let specFactor = pow(nDotH, specPower);
          let specularAccum = effectiveSpecular * radiance * specFactor * nDotL;
          
          let litColor = albedo * lightAccum;

          let fresnel = 1.0 - abs(dot(n, viewDir));
          let rimFactor = pow(fresnel, 4.0);
          let rimLight = material.rimColor * material.rimIntensity * rimFactor;

          let color = litColor + specularAccum + rimLight;
          
          return vec4f(color, finalAlpha);
        }
      `,
    })

    // group 0: per-frame (camera + light + sampler) — bound once per pass
    this.mainPerFrameBindGroupLayout = this.device.createBindGroupLayout({
      label: "main per-frame bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
      ],
    })
    // group 1: per-instance (skinMats) — bound once per model
    this.mainPerInstanceBindGroupLayout = this.device.createBindGroupLayout({
      label: "main per-instance bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
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
      bindGroupLayouts: [this.mainPerFrameBindGroupLayout, this.mainPerInstanceBindGroupLayout, this.mainPerMaterialBindGroupLayout],
    })

    this.perFrameBindGroup = this.device.createBindGroup({
      label: "main per-frame bind group",
      layout: this.mainPerFrameBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraUniformBuffer } },
        { binding: 1, resource: { buffer: this.lightUniformBuffer } },
        { binding: 2, resource: this.materialSampler },
      ],
    })

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
      bindGroupLayouts: [this.outlinePerFrameBindGroupLayout, this.mainPerInstanceBindGroupLayout, this.outlinePerMaterialBindGroupLayout],
    })

    this.outlinePerFrameBindGroup = this.device.createBindGroup({
      label: "outline per-frame bind group",
      layout: this.outlinePerFrameBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraUniformBuffer } },
      ],
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
          // Screen-stable edgeline: extrusion ∝ camera distance (same idea as MMD viewers / babylon-mmd-style scaling)
          let camDist = max(length(camera.viewPos - worldPos), 0.25);
          let refDist = 30.0;
          let edgeScale = 0.025;
          let expandedPos = worldPos + worldNormal * material.edgeSize * edgeScale * (camDist / refDist);
          output.position = camera.projection * camera.view * vec4f(expandedPos, 1.0);
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
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "uniform" } },
      ],
    })
    this.pickPerInstanceBindGroupLayout = this.device.createBindGroupLayout({
      label: "pick per-instance layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } },
      ],
    })
    this.pickPerMaterialBindGroupLayout = this.device.createBindGroupLayout({
      label: "pick per-material layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } },
      ],
    })

    const pickPipelineLayout = this.device.createPipelineLayout({
      label: "pick pipeline layout",
      bindGroupLayouts: [this.pickPerFrameBindGroupLayout, this.pickPerInstanceBindGroupLayout, this.pickPerMaterialBindGroupLayout],
    })

    this.pickPerFrameBindGroup = this.device.createBindGroup({
      label: "pick per-frame bind group",
      layout: this.pickPerFrameBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.cameraUniformBuffer } },
      ],
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
        label: "multisample render target",
        size: [width, height],
        sampleCount: Engine.MULTISAMPLE_COUNT,
        format: this.presentationFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })

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
        resolveTarget: this.context.getCurrentTexture().createView(),
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

    this.camera = new Camera(Math.PI, Math.PI / 2.5, this.cameraDistance, this.cameraTarget, this.cameraFov)

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

  getCameraDistance(): number { return this.camera.radius }
  setCameraDistance(d: number): void { this.camera.radius = d }
  getCameraAlpha(): number { return this.camera.alpha }
  setCameraAlpha(a: number): void { this.camera.alpha = a }
  getCameraBeta(): number { return this.camera.beta }
  setCameraBeta(b: number): void { this.camera.beta = b }

  // Step 5: Create lighting buffers
  private setupLighting() {
    this.lightUniformBuffer = this.device.createBuffer({
      label: "light uniforms",
      size: 64 * 4, // 64 floats: ambientColor vec4f (4) + 4 lights * 2 vec4f each (32)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Initialize light buffer to zeros
    this.lightData.fill(0)
    this.lightCount = 0

    this.setAmbientColor(this.ambientColor)
    this.addLight(new Vec3(0.5, -1, 1).normalize(), new Vec3(1.0, 1.0, 1.0), this.directionalLightIntensity)
  }

  private setAmbientColor(color: Vec3) {
    // Layout: ambientColor (0-3), lights (4-63) - 2 vec4f per light
    this.lightData[0] = color.x // ambientColor.x
    this.lightData[1] = color.y // ambientColor.y
    this.lightData[2] = color.z // ambientColor.z
    this.lightData[3] = this.minSpecularIntensity // ambientColor.w = minSpecularIntensity
    this.updateLightBuffer()
  }

  private addLight(direction: Vec3, color: Vec3, intensity: number = 1.0): boolean {
    if (this.lightCount >= 4) return false

    const normalized = direction.normalize()
    const baseIndex = 4 + this.lightCount * 8 // Start at index 4, 8 floats per light (2 vec4f)
    this.lightData[baseIndex] = normalized.x // direction.x
    this.lightData[baseIndex + 1] = normalized.y // direction.y
    this.lightData[baseIndex + 2] = normalized.z // direction.z
    this.lightData[baseIndex + 3] = 0 // direction.w
    this.lightData[baseIndex + 4] = color.x // color.x
    this.lightData[baseIndex + 5] = color.y // color.y
    this.lightData[baseIndex + 6] = color.z // color.z
    this.lightData[baseIndex + 7] = intensity // color.w / intensity

    this.lightCount++
    this.updateLightBuffer()
    return true
  }

  addGround(options?: {
    width?: number
    height?: number
    diffuseColor?: Vec3
    fadeStart?: number
    fadeEnd?: number
    shadowMapSize?: number
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
      shadowMapSize: 4096,
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
  async loadModel(
    nameOrPath: string,
    pathOrOptions?: string | LoadModelFromFilesOptions
  ): Promise<Model> {
    if (pathOrOptions !== undefined && typeof pathOrOptions === "object" && "files" in pathOrOptions) {
      const name = nameOrPath
      const pmxFile = pathOrOptions.pmxFile ?? findFirstPmxFileInList(pathOrOptions.files)
      if (!pmxFile) throw new Error("No .pmx file found in the selected folder")
      const map = fileListToMap(pathOrOptions.files)
      const pmxKey = normalizeAssetPath(
        (pmxFile as File & { webkitRelativePath?: string }).webkitRelativePath ?? pmxFile.name
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
        inst.physics.step(
          deltaTime,
          inst.model.getWorldMatrices(),
          inst.model.getBoneInverseBindMatrices()
        )
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

  private async setupModelInstance(name: string, model: Model, basePath: string, assetReader: AssetReader): Promise<void> {
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
      skinning.joints.byteLength
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
      skinning.weights.byteLength
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
      entries: [
        { binding: 0, resource: { buffer: skinMatrixBuffer } },
      ],
    })

    const pickPerInstanceBindGroup = this.device.createBindGroup({
      label: `${name}: pick per-instance bind group`,
      layout: this.pickPerInstanceBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: skinMatrixBuffer } },
      ],
    })

    const gpuBuffers: GPUBuffer[] = [
      vertexBuffer,
      indexBuffer,
      jointsBuffer,
      weightsBuffer,
      skinMatrixBuffer,
    ]

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
    shadowMapSize: number
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
    const { shadowMapSize, diffuseColor, fadeStart, fadeEnd, shadowStrength, gridSpacing, gridLineWidth, gridLineOpacity, gridLineColor, noiseStrength } = opts
    this.shadowMapTexture = this.device.createTexture({
      label: "shadow map",
      size: [shadowMapSize, shadowMapSize],
      format: "depth32float",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.shadowMapDepthView = this.shadowMapTexture.createView()
    // Layout: diffuseColor(3f) fadeStart(1f) | fadeEnd(1f) shadowStrength(1f) pcfTexel(1f) gridSpacing(1f) | gridLineWidth(1f) gridOpacity(1f) noiseStrength(1f) _pad(1f) | gridColor(3f) _pad2(1f)
    const gb = new Float32Array(16)
    gb[0] = diffuseColor.x; gb[1] = diffuseColor.y; gb[2] = diffuseColor.z; gb[3] = fadeStart
    gb[4] = fadeEnd; gb[5] = shadowStrength; gb[6] = 1 / shadowMapSize; gb[7] = gridSpacing
    gb[8] = gridLineWidth; gb[9] = gridLineOpacity; gb[10] = noiseStrength; gb[11] = 0
    gb[12] = gridLineColor.x; gb[13] = gridLineColor.y; gb[14] = gridLineColor.z; gb[15] = 0
    this.groundShadowMaterialBuffer = this.device.createBuffer({ size: gb.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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

  // Shadow uses a fixed orthographic projection, independent of the visible light direction
  private shadowLightVPDirty = true
  private updateShadowLightVP() {
    if (!this.shadowLightVPDirty) return
    this.shadowLightVPDirty = false
    const dir = new Vec3(this.shadowLightDirection.x, this.shadowLightDirection.y, this.shadowLightDirection.z)
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

      const materialUniformBuffer = this.createMaterialUniformBuffer(
        prefix + mat.name,
        materialAlpha,
        [mat.diffuse[0], mat.diffuse[1], mat.diffuse[2]],
        mat.ambient,
        mat.specular,
        mat.shininess
      )
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
      inst.drawCalls.push({ type, count: indexCount, firstIndex: currentIndexOffset, bindGroup, materialName: mat.name })

      if ((mat.edgeFlag & 0x10) !== 0 && mat.edgeSize > 0) {
        const materialUniformData = new Float32Array([
          mat.edgeColor[0], mat.edgeColor[1], mat.edgeColor[2], mat.edgeColor[3],
          mat.edgeSize, 0, 0, 0,
        ])
        const outlineUniformBuffer = this.createUniformBuffer(`${prefix}outline: ${mat.name}`, materialUniformData)
        inst.gpuBuffers.push(outlineUniformBuffer)
        const outlineBindGroup = this.device.createBindGroup({
          label: `${prefix}outline: ${mat.name}`,
          layout: this.outlinePerMaterialBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: outlineUniformBuffer } },
          ],
        })
        const outlineType: DrawCallType = isTransparent ? "transparent-outline" : "opaque-outline"
        inst.drawCalls.push({ type: outlineType, count: indexCount, firstIndex: currentIndexOffset, bindGroup: outlineBindGroup, materialName: mat.name })
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

  private createMaterialUniformBuffer(
    label: string,
    alpha: number,
    diffuseColor: [number, number, number],
    ambientColor: [number, number, number],
    specularColor: [number, number, number],
    shininess: number
  ): GPUBuffer {
    const data = new Float32Array(20)
    data.set([
      alpha,
      this.rimLightIntensity,
      shininess,
      0.0,
      1.0, 1.0, 1.0, 0.0, // rimColor (vec3), _padding2
      diffuseColor[0], diffuseColor[1], diffuseColor[2], 0.0,
      ambientColor[0], ambientColor[1], ambientColor[2], 0.0,
      specularColor[0], specularColor[1], specularColor[2], 0.0,
    ])
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
        format: "rgba8unorm",
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
      colorAttachments: [{
        view: this.pickTexture.createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: "clear",
        storeOp: "store",
      }],
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
      { width: 1, height: 1 }
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
      if (idx === modelId) { hitModel = name; break }
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
          if (matIdx === materialId) { hitMaterial = mat.name; break }
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

    this.updateRenderTarget()

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
    if (this.hasGround) this.updateShadowLightVP()

    const encoder = this.device.createCommandEncoder()
    if (hasModels && this.hasGround && this.shadowMapDepthView) {
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

  private updateRenderTarget() {
    const colorAttachment = (this.renderPassDescriptor.colorAttachments as GPURenderPassColorAttachment[])[0]
    colorAttachment.resolveTarget = this.context.getCurrentTexture().createView()
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

  private drawOpaque(pass: GPURenderPassEncoder, inst: ModelInstance, pipeline: GPURenderPipeline): void {
    pass.setPipeline(pipeline)
    for (const draw of inst.drawCalls) {
      if (draw.type === "opaque" && this.shouldRenderDrawCall(inst, draw)) {
        pass.setBindGroup(2, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    }
  }

  private drawTransparent(pass: GPURenderPassEncoder, inst: ModelInstance, pipeline: GPURenderPipeline): void {
    pass.setPipeline(pipeline)
    for (const draw of inst.drawCalls) {
      if (draw.type === "transparent" && this.shouldRenderDrawCall(inst, draw)) {
        pass.setBindGroup(2, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    }
  }

  private bindMainGroups(pass: GPURenderPassEncoder, inst: ModelInstance): void {
    pass.setBindGroup(0, this.perFrameBindGroup)
    pass.setBindGroup(1, inst.mainPerInstanceBindGroup)
  }

  private renderOneModel(pass: GPURenderPassEncoder, inst: ModelInstance): void {
    pass.setVertexBuffer(0, inst.vertexBuffer)
    pass.setVertexBuffer(1, inst.jointsBuffer)
    pass.setVertexBuffer(2, inst.weightsBuffer)
    pass.setIndexBuffer(inst.indexBuffer, "uint32")

    this.bindMainGroups(pass, inst)
    this.drawOpaque(pass, inst, this.modelPipeline)
    this.drawOutlines(pass, inst, false)
    this.bindMainGroups(pass, inst)
    this.drawTransparent(pass, inst, this.modelPipeline)
    this.drawOutlines(pass, inst, true)
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
        skinMatrices.byteLength
      )
    })
  }

  private drawOutlines(pass: GPURenderPassEncoder, inst: ModelInstance, transparent: boolean) {
    pass.setPipeline(this.outlinePipeline)
    pass.setBindGroup(0, this.outlinePerFrameBindGroup)
    pass.setBindGroup(1, inst.mainPerInstanceBindGroup)
    const outlineType: DrawCallType = transparent ? "transparent-outline" : "opaque-outline"
    for (const draw of inst.drawCalls) {
      if (draw.type === outlineType && this.shouldRenderDrawCall(inst, draw)) {
        pass.setBindGroup(2, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    }
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
