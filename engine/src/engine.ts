import { Camera } from "./camera"
import { Mat4, Quat, Vec3 } from "./math"
import { Model } from "./model"
import { PmxLoader } from "./pmx-loader"

export type RaycastCallback = (materialName: string | null) => void

export type EngineOptions = {
  ambientColor?: Vec3
  bloomIntensity?: number
  bloomThreshold?: number
  rimLightIntensity?: number
  cameraDistance?: number
  cameraTarget?: Vec3
  cameraFov?: number
  onRaycast?: RaycastCallback
}

export type RequiredEngineOptions = Required<Omit<EngineOptions, "onRaycast">> & Pick<EngineOptions, "onRaycast">

export const DEFAULT_ENGINE_OPTIONS: RequiredEngineOptions = {
  ambientColor: new Vec3(0.85, 0.85, 0.85),
  bloomIntensity: 0.12,
  bloomThreshold: 0.5,
  rimLightIntensity: 0.45,
  cameraDistance: 26.6,
  cameraTarget: new Vec3(0, 12.5, 0),
  cameraFov: Math.PI / 4,
  onRaycast: undefined,
}

export interface EngineStats {
  fps: number
  frameTime: number // ms
}

type DrawCallType =
  | "opaque"
  | "eye"
  | "hair-over-eyes"
  | "hair-over-non-eyes"
  | "transparent"
  | "opaque-outline"
  | "eye-outline"
  | "hair-outline"
  | "transparent-outline"

interface DrawCall {
  type: DrawCallType
  count: number
  firstIndex: number
  bindGroup: GPUBindGroup
  materialName: string
}

export class Engine {
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
  private vertexBuffer!: GPUBuffer
  private indexBuffer?: GPUBuffer
  private resizeObserver: ResizeObserver | null = null
  private depthTexture!: GPUTexture
  // Material rendering pipelines
  private modelPipeline!: GPURenderPipeline
  private eyePipeline!: GPURenderPipeline
  private hairPipelineOverEyes!: GPURenderPipeline
  private hairPipelineOverNonEyes!: GPURenderPipeline
  private hairDepthPipeline!: GPURenderPipeline
  // Outline pipelines
  private outlinePipeline!: GPURenderPipeline
  private hairOutlinePipeline!: GPURenderPipeline
  private mainBindGroupLayout!: GPUBindGroupLayout
  private outlineBindGroupLayout!: GPUBindGroupLayout
  private jointsBuffer!: GPUBuffer
  private weightsBuffer!: GPUBuffer
  private skinMatrixBuffer?: GPUBuffer
  private inverseBindMatrixBuffer?: GPUBuffer
  private multisampleTexture!: GPUTexture
  private readonly sampleCount = 4
  private renderPassDescriptor!: GPURenderPassDescriptor
  // Constants
  private readonly STENCIL_EYE_VALUE = 1
  private readonly BLOOM_DOWNSCALE_FACTOR = 2

  // Ambient light settings
  private ambientColor!: Vec3
  // Bloom post-processing textures
  private sceneRenderTexture!: GPUTexture
  private sceneRenderTextureView!: GPUTextureView // Cached view (recreated on resize)
  private bloomExtractTexture!: GPUTexture
  private bloomBlurTexture1!: GPUTexture
  private bloomBlurTexture2!: GPUTexture
  // Post-processing pipelines
  private bloomExtractPipeline!: GPURenderPipeline
  private bloomBlurPipeline!: GPURenderPipeline
  private bloomComposePipeline!: GPURenderPipeline
  private blurDirectionBuffer!: GPUBuffer
  private bloomIntensityBuffer!: GPUBuffer
  private bloomThresholdBuffer!: GPUBuffer
  private linearSampler!: GPUSampler
  // Bloom bind groups (created once, reused every frame)
  private bloomExtractBindGroup?: GPUBindGroup
  private bloomBlurHBindGroup?: GPUBindGroup
  private bloomBlurVBindGroup?: GPUBindGroup
  private bloomComposeBindGroup?: GPUBindGroup
  // Bloom settings
  private bloomThreshold!: number
  private bloomIntensity!: number
  // Rim light settings
  private rimLightIntensity!: number

  // Raycasting
  private onRaycast?: RaycastCallback
  private cachedSkinnedVertices?: Float32Array
  private cachedSkinMatricesVersion = -1
  private skinMatricesVersion = 0

  private currentModel: Model | null = null
  private modelDir: string = ""
  private materialSampler!: GPUSampler
  private textureCache = new Map<string, GPUTexture>()
  private vertexBufferNeedsUpdate = false
  // Unified draw call list
  private drawCalls: DrawCall[] = []
  // Material visibility tracking
  private hiddenMaterials = new Set<string>()

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
      this.ambientColor = options.ambientColor ?? DEFAULT_ENGINE_OPTIONS.ambientColor!
      this.bloomIntensity = options.bloomIntensity ?? DEFAULT_ENGINE_OPTIONS.bloomIntensity
      this.bloomThreshold = options.bloomThreshold ?? DEFAULT_ENGINE_OPTIONS.bloomThreshold
      this.rimLightIntensity = options.rimLightIntensity ?? DEFAULT_ENGINE_OPTIONS.rimLightIntensity
      this.cameraDistance = options.cameraDistance ?? DEFAULT_ENGINE_OPTIONS.cameraDistance
      this.cameraTarget = options.cameraTarget ?? DEFAULT_ENGINE_OPTIONS.cameraTarget
      this.cameraFov = options.cameraFov ?? DEFAULT_ENGINE_OPTIONS.cameraFov
      this.onRaycast = options.onRaycast
    }
  }

  // Step 1: Get WebGPU device and context
  public async init() {
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
    this.createBloomPipelines()
    this.setupResize()
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
      multisample: config.multisample ?? { count: this.sampleCount },
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

    const depthOnlyVertexBuffers: GPUVertexBufferLayout[] = [
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
          alphaMultiplier: f32,
          rimIntensity: f32,
          _padding1: f32,
          rimColor: vec3f,
          isOverEyes: f32, // 1.0 if rendering over eyes, 0.0 otherwise
        };

        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) normal: vec3f,
          @location(1) uv: vec2f,
          @location(2) worldPos: vec3f,
        };

        @group(0) @binding(0) var<uniform> camera: CameraUniforms;
        @group(0) @binding(1) var<uniform> light: LightUniforms;
        @group(0) @binding(2) var diffuseTexture: texture_2d<f32>;
        @group(0) @binding(3) var diffuseSampler: sampler;
        @group(0) @binding(4) var<storage, read> skinMats: array<mat4x4f>;
        @group(0) @binding(5) var<uniform> material: MaterialUniforms;

        @vertex fn vs(
          @location(0) position: vec3f,
          @location(1) normal: vec3f,
          @location(2) uv: vec2f,
          @location(3) joints0: vec4<u32>,
          @location(4) weights0: vec4<f32>
        ) -> VertexOutput {
          var output: VertexOutput;
          let pos4 = vec4f(position, 1.0);
          
          // Branchless weight normalization (avoids GPU branch divergence)
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
          // Early alpha test - discard before expensive calculations
          var finalAlpha = material.alpha * material.alphaMultiplier;
          if (material.isOverEyes > 0.5) {
            finalAlpha *= 0.5; // Hair over eyes gets 50% alpha
          }
          if (finalAlpha < 0.001) {
            discard;
          }
          
          let n = normalize(input.normal);
          let albedo = textureSample(diffuseTexture, diffuseSampler, input.uv).rgb;

          // Accumulate light contribution
          var lightAccum = light.ambientColor.xyz;
          for (var i = 0u; i < 4u; i++) {
            let intensity = light.lights[i].color.w;
            if (intensity > 0.0) {
              let l = -light.lights[i].direction.xyz;
              let nDotL = max(dot(n, l), 0.0);
              let radiance = light.lights[i].color.xyz * intensity;
              lightAccum += radiance * nDotL;
            }
          }

          // Rim light calculation - proper Fresnel for edge-only highlights
          let viewDir = normalize(camera.viewPos - input.worldPos);
          let fresnel = 1.0 - abs(dot(n, viewDir));
          let rimFactor = pow(fresnel, 4.0); // Higher power for sharper edge-only effect
          let rimLight = material.rimColor * material.rimIntensity * rimFactor;

          let color = albedo * lightAccum + rimLight;
          
          return vec4f(color, finalAlpha);
        }
      `,
    })

    // Create explicit bind group layout for all pipelines using the main shader
    this.mainBindGroupLayout = this.device.createBindGroupLayout({
      label: "main material bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }, // camera
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }, // light
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} }, // diffuseTexture
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: {} }, // diffuseSampler
        { binding: 4, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }, // skinMats
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }, // material
      ],
    })

    const mainPipelineLayout = this.device.createPipelineLayout({
      label: "main pipeline layout",
      bindGroupLayouts: [this.mainBindGroupLayout],
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

    // Create bind group layout for outline pipelines
    this.outlineBindGroupLayout = this.device.createBindGroupLayout({
      label: "outline bind group layout",
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }, // camera
        { binding: 1, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: "uniform" } }, // material
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: "read-only-storage" } }, // skinMats
      ],
    })

    const outlinePipelineLayout = this.device.createPipelineLayout({
      label: "outline pipeline layout",
      bindGroupLayouts: [this.outlineBindGroupLayout],
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
          isOverEyes: f32, // 1.0 if rendering over eyes, 0.0 otherwise (for hair outlines)
          _padding1: f32,
          _padding2: f32,
        };

        @group(0) @binding(0) var<uniform> camera: CameraUniforms;
        @group(0) @binding(1) var<uniform> material: MaterialUniforms;
        @group(0) @binding(2) var<storage, read> skinMats: array<mat4x4f>;

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
          
          // Branchless weight normalization (avoids GPU branch divergence)
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
          
          // MMD invert hull: expand vertices outward along normals
          let scaleFactor = 0.01;
          let expandedPos = worldPos + worldNormal * material.edgeSize * scaleFactor;
          output.position = camera.projection * camera.view * vec4f(expandedPos, 1.0);
          return output;
        }

        @fragment fn fs() -> @location(0) vec4f {
          var color = material.edgeColor;
          
          if (material.isOverEyes > 0.5) {
            color.a *= 0.5; // Hair outlines over eyes get 50% alpha
          }
          
          return color;
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
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
    })

    // Hair outline pipeline
    this.hairOutlinePipeline = this.createRenderPipeline({
      label: "hair outline pipeline",
      layout: outlinePipelineLayout,
      shaderModule: outlineShaderModule,
      vertexBuffers: outlineVertexBuffers,
      fragmentTarget: standardBlend,
      cullMode: "back",
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false,
        depthCompare: "less-equal",
        depthBias: -0.0001,
        depthBiasSlopeScale: 0.0,
        depthBiasClamp: 0.0,
      },
    })

    // Eye overlay pipeline (renders after opaque, writes stencil)
    this.eyePipeline = this.createRenderPipeline({
      label: "eye overlay pipeline",
      layout: mainPipelineLayout,
      shaderModule,
      vertexBuffers: fullVertexBuffers,
      fragmentTarget: standardBlend,
      cullMode: "front",
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
        depthBias: -0.00005,
        depthBiasSlopeScale: 0.0,
        depthBiasClamp: 0.0,
        stencilFront: {
          compare: "always",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "replace",
        },
        stencilBack: {
          compare: "always",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "replace",
        },
      },
    })

    // Depth-only shader for hair pre-pass (reduces overdraw by early depth rejection)
    const depthOnlyShaderModule = this.device.createShaderModule({
      label: "depth only shader",
      code: /* wgsl */ `
        struct CameraUniforms {
          view: mat4x4f,
          projection: mat4x4f,
          viewPos: vec3f,
          _padding: f32,
        };

        @group(0) @binding(0) var<uniform> camera: CameraUniforms;
        @group(0) @binding(4) var<storage, read> skinMats: array<mat4x4f>;

        @vertex fn vs(
          @location(0) position: vec3f,
          @location(1) normal: vec3f,
          @location(3) joints0: vec4<u32>,
          @location(4) weights0: vec4<f32>
        ) -> @builtin(position) vec4f {
          let pos4 = vec4f(position, 1.0);
          
          // Branchless weight normalization (avoids GPU branch divergence)
          let weightSum = weights0.x + weights0.y + weights0.z + weights0.w;
          let invWeightSum = select(1.0, 1.0 / weightSum, weightSum > 0.0001);
          let normalizedWeights = select(vec4f(1.0, 0.0, 0.0, 0.0), weights0 * invWeightSum, weightSum > 0.0001);
          
          var skinnedPos = vec4f(0.0, 0.0, 0.0, 0.0);
          for (var i = 0u; i < 4u; i++) {
            let j = joints0[i];
            let w = normalizedWeights[i];
            let m = skinMats[j];
            skinnedPos += (m * pos4) * w;
          }
          let worldPos = skinnedPos.xyz;
          let clipPos = camera.projection * camera.view * vec4f(worldPos, 1.0);
          return clipPos;
        }

        @fragment fn fs() -> @location(0) vec4f {
          return vec4f(0.0, 0.0, 0.0, 0.0); // Transparent - color writes disabled via writeMask
        }
      `,
    })

    // Hair depth pre-pass pipeline: depth-only with color writes disabled to eliminate overdraw
    this.hairDepthPipeline = this.createRenderPipeline({
      label: "hair depth pre-pass",
      layout: mainPipelineLayout,
      shaderModule: depthOnlyShaderModule,
      vertexBuffers: depthOnlyVertexBuffers,
      fragmentTarget: {
        format: this.presentationFormat,
        writeMask: 0,
      },
      fragmentEntryPoint: "fs",
      cullMode: "none",
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
        depthBias: 0.0,
        depthBiasSlopeScale: 0.0,
        depthBiasClamp: 0.0,
      },
    })

    // Hair pipelines for rendering over eyes vs non-eyes (only differ in stencil compare mode)
    const createHairPipeline = (isOverEyes: boolean): GPURenderPipeline => {
      return this.createRenderPipeline({
        label: `hair pipeline (${isOverEyes ? "over eyes" : "over non-eyes"})`,
        layout: mainPipelineLayout,
        shaderModule,
        vertexBuffers: fullVertexBuffers,
        fragmentTarget: standardBlend,
        cullMode: "none",
        depthStencil: {
          format: "depth24plus-stencil8",
          depthWriteEnabled: false,
          depthCompare: "less-equal",
          stencilFront: {
            compare: isOverEyes ? "equal" : "not-equal",
            failOp: "keep",
            depthFailOp: "keep",
            passOp: "keep",
          },
          stencilBack: {
            compare: isOverEyes ? "equal" : "not-equal",
            failOp: "keep",
            depthFailOp: "keep",
            passOp: "keep",
          },
        },
      })
    }

    this.hairPipelineOverEyes = createHairPipeline(true)
    this.hairPipelineOverNonEyes = createHairPipeline(false)
  }

  // Create bloom post-processing pipelines
  private createBloomPipelines() {
    // Bloom extraction shader (extracts bright areas)
    const bloomExtractShader = this.device.createShaderModule({
      label: "bloom extract",
      code: /* wgsl */ `
        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) uv: vec2f,
        };

        @vertex fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          // Generate fullscreen quad from vertex index
          let x = f32((vertexIndex << 1u) & 2u) * 2.0 - 1.0;
          let y = f32(vertexIndex & 2u) * 2.0 - 1.0;
          output.position = vec4f(x, y, 0.0, 1.0);
          output.uv = vec2f(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
          return output;
        }

        struct BloomExtractUniforms {
          threshold: f32,
          _padding1: f32,
          _padding2: f32,
          _padding3: f32,
          _padding4: f32,
          _padding5: f32,
          _padding6: f32,
          _padding7: f32,
        };

        @group(0) @binding(0) var inputTexture: texture_2d<f32>;
        @group(0) @binding(1) var inputSampler: sampler;
        @group(0) @binding(2) var<uniform> extractUniforms: BloomExtractUniforms;

        @fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
          let color = textureSample(inputTexture, inputSampler, input.uv);
          // Extract bright areas above threshold
          let threshold = extractUniforms.threshold;
          let bloom = max(vec3f(0.0), color.rgb - vec3f(threshold)) / max(0.001, 1.0 - threshold);
          return vec4f(bloom, color.a);
        }
      `,
    })

    // Bloom blur shader (gaussian blur - can be used for both horizontal and vertical)
    const bloomBlurShader = this.device.createShaderModule({
      label: "bloom blur",
      code: /* wgsl */ `
        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) uv: vec2f,
        };

        @vertex fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          let x = f32((vertexIndex << 1u) & 2u) * 2.0 - 1.0;
          let y = f32(vertexIndex & 2u) * 2.0 - 1.0;
          output.position = vec4f(x, y, 0.0, 1.0);
          output.uv = vec2f(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
          return output;
        }

        struct BlurUniforms {
          direction: vec2f,
          _padding1: f32,
          _padding2: f32,
          _padding3: f32,
          _padding4: f32,
          _padding5: f32,
          _padding6: f32,
        };

        @group(0) @binding(0) var inputTexture: texture_2d<f32>;
        @group(0) @binding(1) var inputSampler: sampler;
        @group(0) @binding(2) var<uniform> blurUniforms: BlurUniforms;

        // 3-tap gaussian blur using bilinear filtering trick (40% fewer texture fetches!)
        @fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
          let texelSize = 1.0 / vec2f(textureDimensions(inputTexture));
          
          // Bilinear optimization: leverage hardware filtering to sample between pixels
          // Original 5-tap: weights [0.06136, 0.24477, 0.38774, 0.24477, 0.06136] at offsets [-2, -1, 0, 1, 2]
          // Optimized 3-tap: combine adjacent samples using weighted offsets
          let weight0 = 0.38774; // Center sample
          let weight1 = 0.24477 + 0.06136; // Combined outer samples = 0.30613
          let offset1 = (0.24477 * 1.0 + 0.06136 * 2.0) / weight1; // Weighted position = 1.2
          
          var result = textureSample(inputTexture, inputSampler, input.uv) * weight0;
          let offsetVec = offset1 * texelSize * blurUniforms.direction;
          result += textureSample(inputTexture, inputSampler, input.uv + offsetVec) * weight1;
          result += textureSample(inputTexture, inputSampler, input.uv - offsetVec) * weight1;
          
          return result;
        }
      `,
    })

    // Bloom composition shader (combines original scene with bloom)
    const bloomComposeShader = this.device.createShaderModule({
      label: "bloom compose",
      code: /* wgsl */ `
        struct VertexOutput {
          @builtin(position) position: vec4f,
          @location(0) uv: vec2f,
        };

        @vertex fn vs(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
          var output: VertexOutput;
          let x = f32((vertexIndex << 1u) & 2u) * 2.0 - 1.0;
          let y = f32(vertexIndex & 2u) * 2.0 - 1.0;
          output.position = vec4f(x, y, 0.0, 1.0);
          output.uv = vec2f(x * 0.5 + 0.5, 1.0 - (y * 0.5 + 0.5));
          return output;
        }

        struct BloomComposeUniforms {
          intensity: f32,
          _padding1: f32,
          _padding2: f32,
          _padding3: f32,
          _padding4: f32,
          _padding5: f32,
          _padding6: f32,
          _padding7: f32,
        };

        @group(0) @binding(0) var sceneTexture: texture_2d<f32>;
        @group(0) @binding(1) var sceneSampler: sampler;
        @group(0) @binding(2) var bloomTexture: texture_2d<f32>;
        @group(0) @binding(3) var bloomSampler: sampler;
        @group(0) @binding(4) var<uniform> composeUniforms: BloomComposeUniforms;

        @fragment fn fs(input: VertexOutput) -> @location(0) vec4f {
          let scene = textureSample(sceneTexture, sceneSampler, input.uv);
          let bloom = textureSample(bloomTexture, bloomSampler, input.uv);
          // Additive blending with intensity control
          let result = scene.rgb + bloom.rgb * composeUniforms.intensity;
          return vec4f(result, scene.a);
        }
      `,
    })

    // Create uniform buffer for blur direction (minimum 32 bytes for WebGPU)
    const blurDirectionBuffer = this.device.createBuffer({
      label: "blur direction",
      size: 32, // Minimum 32 bytes required for uniform buffers in WebGPU
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Create uniform buffer for bloom intensity (minimum 32 bytes for WebGPU)
    const bloomIntensityBuffer = this.device.createBuffer({
      label: "bloom intensity",
      size: 32, // Minimum 32 bytes required for uniform buffers in WebGPU
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Create uniform buffer for bloom threshold (minimum 32 bytes for WebGPU)
    const bloomThresholdBuffer = this.device.createBuffer({
      label: "bloom threshold",
      size: 32, // Minimum 32 bytes required for uniform buffers in WebGPU
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    // Set default bloom values
    const intensityData = new Float32Array(8) // f32 + 7 padding floats = 8 floats = 32 bytes
    intensityData[0] = this.bloomIntensity
    this.device.queue.writeBuffer(bloomIntensityBuffer, 0, intensityData)

    const thresholdData = new Float32Array(8) // f32 + 7 padding floats = 8 floats = 32 bytes
    thresholdData[0] = this.bloomThreshold
    this.device.queue.writeBuffer(bloomThresholdBuffer, 0, thresholdData)

    // Create linear sampler for post-processing
    const linearSampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "clamp-to-edge",
      addressModeV: "clamp-to-edge",
    })

    // Bloom extraction pipeline
    this.bloomExtractPipeline = this.device.createRenderPipeline({
      label: "bloom extract",
      layout: "auto",
      vertex: {
        module: bloomExtractShader,
        entryPoint: "vs",
      },
      fragment: {
        module: bloomExtractShader,
        entryPoint: "fs",
        targets: [{ format: this.presentationFormat }],
      },
      primitive: { topology: "triangle-list" },
    })

    // Bloom blur pipeline
    this.bloomBlurPipeline = this.device.createRenderPipeline({
      label: "bloom blur",
      layout: "auto",
      vertex: {
        module: bloomBlurShader,
        entryPoint: "vs",
      },
      fragment: {
        module: bloomBlurShader,
        entryPoint: "fs",
        targets: [{ format: this.presentationFormat }],
      },
      primitive: { topology: "triangle-list" },
    })

    // Bloom composition pipeline
    this.bloomComposePipeline = this.device.createRenderPipeline({
      label: "bloom compose",
      layout: "auto",
      vertex: {
        module: bloomComposeShader,
        entryPoint: "vs",
      },
      fragment: {
        module: bloomComposeShader,
        entryPoint: "fs",
        targets: [{ format: this.presentationFormat }],
      },
      primitive: { topology: "triangle-list" },
    })

    // Store buffers and sampler for later use
    this.blurDirectionBuffer = blurDirectionBuffer
    this.bloomIntensityBuffer = bloomIntensityBuffer
    this.bloomThresholdBuffer = bloomThresholdBuffer
    this.linearSampler = linearSampler
  }

  private setupBloom(width: number, height: number) {
    const bloomWidth = Math.floor(width / this.BLOOM_DOWNSCALE_FACTOR)
    const bloomHeight = Math.floor(height / this.BLOOM_DOWNSCALE_FACTOR)
    this.bloomExtractTexture = this.device.createTexture({
      label: "bloom extract",
      size: [bloomWidth, bloomHeight],
      format: this.presentationFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.bloomBlurTexture1 = this.device.createTexture({
      label: "bloom blur 1",
      size: [bloomWidth, bloomHeight],
      format: this.presentationFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.bloomBlurTexture2 = this.device.createTexture({
      label: "bloom blur 2",
      size: [bloomWidth, bloomHeight],
      format: this.presentationFormat,
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })

    // Create bloom bind groups
    this.bloomExtractBindGroup = this.device.createBindGroup({
      layout: this.bloomExtractPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sceneRenderTexture.createView() },
        { binding: 1, resource: this.linearSampler },
        { binding: 2, resource: { buffer: this.bloomThresholdBuffer } },
      ],
    })

    this.bloomBlurHBindGroup = this.device.createBindGroup({
      layout: this.bloomBlurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.bloomExtractTexture.createView() },
        { binding: 1, resource: this.linearSampler },
        { binding: 2, resource: { buffer: this.blurDirectionBuffer } },
      ],
    })

    this.bloomBlurVBindGroup = this.device.createBindGroup({
      layout: this.bloomBlurPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.bloomBlurTexture1.createView() },
        { binding: 1, resource: this.linearSampler },
        { binding: 2, resource: { buffer: this.blurDirectionBuffer } },
      ],
    })

    this.bloomComposeBindGroup = this.device.createBindGroup({
      layout: this.bloomComposePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: this.sceneRenderTexture.createView() },
        { binding: 1, resource: this.linearSampler },
        { binding: 2, resource: this.bloomBlurTexture2.createView() },
        { binding: 3, resource: this.linearSampler },
        { binding: 4, resource: { buffer: this.bloomIntensityBuffer } },
      ],
    })
  }

  // Step 3: Setup canvas resize handling
  private setupResize() {
    this.resizeObserver = new ResizeObserver(() => this.handleResize())
    this.resizeObserver.observe(this.canvas)
    this.handleResize()

    // Setup raycasting click handler
    if (this.onRaycast) {
      this.canvas.addEventListener("click", this.handleCanvasClick)
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
        sampleCount: this.sampleCount,
        format: this.presentationFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })

      this.depthTexture = this.device.createTexture({
        label: "depth texture",
        size: [width, height],
        sampleCount: this.sampleCount,
        format: "depth24plus-stencil8",
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })

      // Create scene render texture (non-multisampled for post-processing)
      this.sceneRenderTexture = this.device.createTexture({
        label: "scene render texture",
        size: [width, height],
        format: this.presentationFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })

      // Setup bloom textures and bind groups
      this.setupBloom(width, height)

      const depthTextureView = this.depthTexture.createView()
      // Cache the scene render texture view (only recreate on resize)
      this.sceneRenderTextureView = this.sceneRenderTexture.createView()

      // Render scene to texture instead of directly to canvas
      const colorAttachment: GPURenderPassColorAttachment =
        this.sampleCount > 1
          ? {
              view: this.multisampleTexture.createView(),
              resolveTarget: this.sceneRenderTextureView,
              clearValue: { r: 0, g: 0, b: 0, a: 0 },
              loadOp: "clear",
              storeOp: "store",
            }
          : {
              view: this.sceneRenderTextureView,
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
          stencilStoreOp: "discard", // Discard stencil after frame to save bandwidth (we only use it during rendering)
        },
      }

      this.camera.aspect = width / height
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
    this.addLight(new Vec3(-0.3, -0.7, 0.6).normalize(), new Vec3(1.0, 0.9, 0.8), 0.08)
    this.addLight(new Vec3(0.5, -0.6, 0.6).normalize(), new Vec3(0.9, 0.95, 1.0), 0.07)
    this.addLight(new Vec3(0.0, -0.3, -1.0).normalize(), new Vec3(0.95, 0.95, 0.9), 0.06)
  }

  private setAmbientColor(color: Vec3) {
    // Layout: ambientColor (0-3), lights (4-63) - 2 vec4f per light
    this.lightData[0] = color.x // ambientColor.x
    this.lightData[1] = color.y // ambientColor.y
    this.lightData[2] = color.z // ambientColor.z
    this.lightData[3] = 1.0 // ambientColor.w
    this.updateLightBuffer()
  }

  public clearLights() {
    this.lightCount = 0
    // Clear all light data by setting intensity to 0
    for (let i = 0; i < 4; i++) {
      const baseIndex = 4 + i * 8
      this.lightData[baseIndex + 7] = 0 // color.w / intensity
    }
    this.updateLightBuffer()
  }

  public addLight(direction: Vec3, color: Vec3, intensity: number = 1.0): boolean {
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

  private updateLightBuffer() {
    this.device.queue.writeBuffer(this.lightUniformBuffer, 0, this.lightData)
  }

  public async loadAnimation(url: string) {
    if (!this.currentModel) return
    await this.currentModel.loadVmd(url)
  }

  public playAnimation() {
    this.currentModel?.playAnimation()
  }

  public stopAnimation() {
    this.currentModel?.stopAnimation()
  }

  public pauseAnimation() {
    this.currentModel?.pauseAnimation()
  }

  public seekAnimation(time: number) {
    this.currentModel?.seekAnimation(time)
  }

  public getAnimationProgress() {
    return this.currentModel?.getAnimationProgress() ?? { current: 0, duration: 0, percentage: 0 }
  }

  public getStats(): EngineStats {
    return { ...this.stats }
  }

  public runRenderLoop(callback?: () => void) {
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

  public stopRenderLoop() {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId)
      this.animationFrameId = null
    }
    this.renderLoopCallback = null
  }

  public dispose() {
    this.stopRenderLoop()
    this.stopAnimation()
    if (this.camera) this.camera.detachControl()
    if (this.resizeObserver) {
      this.resizeObserver.disconnect()
      this.resizeObserver = null
    }
  }

  // Step 6: Load PMX model file
  public async loadModel(path: string) {
    const pathParts = path.split("/")
    pathParts.pop()
    const dir = pathParts.join("/") + "/"
    this.modelDir = dir

    const model = await PmxLoader.load(path)
    console.log(model)

    // Clear cached skinned vertices when loading a new model
    this.cachedSkinnedVertices = undefined
    this.cachedSkinMatricesVersion = -1

    await this.setupModelBuffers(model)
  }

  public rotateBones(bones: string[], rotations: Quat[], durationMs?: number) {
    this.currentModel?.rotateBones(bones, rotations, durationMs)
  }

  // moveBones now takes relative translations (VMD-style) by default
  public moveBones(bones: string[], relativeTranslations: Vec3[], durationMs?: number) {
    this.currentModel?.moveBones(bones, relativeTranslations, durationMs)
  }

  public setMorphWeight(name: string, weight: number, durationMs?: number): void {
    if (!this.currentModel) return
    this.currentModel.setMorphWeight(name, weight, durationMs)
    if (!durationMs || durationMs === 0) {
      this.vertexBufferNeedsUpdate = true
    }
  }

  public setMaterialVisible(name: string, visible: boolean): void {
    if (visible) {
      this.hiddenMaterials.delete(name)
    } else {
      this.hiddenMaterials.add(name)
    }
  }

  public isMaterialVisible(name: string): boolean {
    return !this.hiddenMaterials.has(name)
  }

  public getBones(): string[] {
    return this.currentModel?.getSkeleton().bones.map((bone) => bone.name) ?? []
  }

  public getMorphs(): string[] {
    return this.currentModel?.getMorphing().morphs.map((morph) => morph.name) ?? []
  }

  public getMaterials(): string[] {
    return this.currentModel?.getMaterials().map((material) => material.name) ?? []
  }

  private updateVertexBuffer(): void {
    if (!this.currentModel || !this.vertexBuffer) return
    const vertices = this.currentModel.getVertices()
    if (!vertices || vertices.length === 0) return
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices)
  }

  // Step 7: Create vertex, index, and joint buffers
  private async setupModelBuffers(model: Model) {
    this.currentModel = model
    const vertices = model.getVertices()
    const skinning = model.getSkinning()
    const skeleton = model.getSkeleton()

    this.vertexBuffer = this.device.createBuffer({
      label: "model vertex buffer",
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(this.vertexBuffer, 0, vertices)

    this.jointsBuffer = this.device.createBuffer({
      label: "joints buffer",
      size: skinning.joints.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(
      this.jointsBuffer,
      0,
      skinning.joints.buffer,
      skinning.joints.byteOffset,
      skinning.joints.byteLength
    )

    this.weightsBuffer = this.device.createBuffer({
      label: "weights buffer",
      size: skinning.weights.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    this.device.queue.writeBuffer(
      this.weightsBuffer,
      0,
      skinning.weights.buffer,
      skinning.weights.byteOffset,
      skinning.weights.byteLength
    )

    const boneCount = skeleton.bones.length
    const matrixSize = boneCount * 16 * 4

    this.skinMatrixBuffer = this.device.createBuffer({
      label: "skin matrices",
      size: Math.max(256, matrixSize),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })

    this.inverseBindMatrixBuffer = this.device.createBuffer({
      label: "inverse bind matrices",
      size: Math.max(256, matrixSize),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    })

    const invBindMatrices = skeleton.inverseBindMatrices
    this.device.queue.writeBuffer(
      this.inverseBindMatrixBuffer,
      0,
      invBindMatrices.buffer,
      invBindMatrices.byteOffset,
      invBindMatrices.byteLength
    )

    const indices = model.getIndices()
    if (indices) {
      this.indexBuffer = this.device.createBuffer({
        label: "model index buffer",
        size: indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(this.indexBuffer, 0, indices)
    } else {
      throw new Error("Model has no index buffer")
    }

    await this.setupMaterials(model)
  }

  private async setupMaterials(model: Model) {
    const materials = model.getMaterials()
    if (materials.length === 0) {
      throw new Error("Model has no materials")
    }

    const textures = model.getTextures()

    const loadTextureByIndex = async (texIndex: number): Promise<GPUTexture | null> => {
      if (texIndex < 0 || texIndex >= textures.length) {
        return null
      }

      const path = this.modelDir + textures[texIndex].path
      const texture = await this.createTextureFromPath(path)
      return texture
    }

    this.drawCalls = []
    let currentIndexOffset = 0

    for (const mat of materials) {
      const indexCount = mat.vertexCount
      if (indexCount === 0) continue

      const diffuseTexture = await loadTextureByIndex(mat.diffuseTextureIndex)
      if (!diffuseTexture) throw new Error(`Material "${mat.name}" has no diffuse texture`)

      const materialAlpha = mat.diffuse[3]
      const isTransparent = materialAlpha < 1.0 - 0.001

      const materialUniformBuffer = this.createMaterialUniformBuffer(mat.name, materialAlpha, 0.0)

      // Create bind groups using the shared bind group layout - All pipelines (main, eye, hair multiply, hair opaque) use the same shader and layout
      const bindGroup = this.device.createBindGroup({
        label: `material bind group: ${mat.name}`,
        layout: this.mainBindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.cameraUniformBuffer } },
          { binding: 1, resource: { buffer: this.lightUniformBuffer } },
          { binding: 2, resource: diffuseTexture.createView() },
          { binding: 3, resource: this.materialSampler },
          { binding: 4, resource: { buffer: this.skinMatrixBuffer! } },
          { binding: 5, resource: { buffer: materialUniformBuffer } },
        ],
      })

      if (indexCount > 0) {
        if (mat.isEye) {
          this.drawCalls.push({
            type: "eye",
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup,
            materialName: mat.name,
          })
        } else if (mat.isHair) {
          // Hair materials: create separate bind groups for over-eyes vs over-non-eyes
          const createHairBindGroup = (isOverEyes: boolean) => {
            const buffer = this.createMaterialUniformBuffer(
              `${mat.name} (${isOverEyes ? "over eyes" : "over non-eyes"})`,
              materialAlpha,
              isOverEyes ? 1.0 : 0.0
            )

            return this.device.createBindGroup({
              label: `material bind group (${isOverEyes ? "over eyes" : "over non-eyes"}): ${mat.name}`,
              layout: this.mainBindGroupLayout,
              entries: [
                { binding: 0, resource: { buffer: this.cameraUniformBuffer } },
                { binding: 1, resource: { buffer: this.lightUniformBuffer } },
                { binding: 2, resource: diffuseTexture.createView() },
                { binding: 3, resource: this.materialSampler },
                { binding: 4, resource: { buffer: this.skinMatrixBuffer! } },
                { binding: 5, resource: { buffer: buffer } },
              ],
            })
          }

          const bindGroupOverEyes = createHairBindGroup(true)
          const bindGroupOverNonEyes = createHairBindGroup(false)

          this.drawCalls.push({
            type: "hair-over-eyes",
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup: bindGroupOverEyes,
            materialName: mat.name,
          })
          this.drawCalls.push({
            type: "hair-over-non-eyes",
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup: bindGroupOverNonEyes,
            materialName: mat.name,
          })
        } else if (isTransparent) {
          this.drawCalls.push({
            type: "transparent",
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup,
            materialName: mat.name,
          })
        } else {
          this.drawCalls.push({
            type: "opaque",
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup,
            materialName: mat.name,
          })
        }
      }

      // Edge flag is at bit 4 (0x10) in PMX format
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
        const materialUniformBuffer = this.createUniformBuffer(
          `outline material uniform: ${mat.name}`,
          materialUniformData
        )

        const outlineBindGroup = this.device.createBindGroup({
          label: `outline bind group: ${mat.name}`,
          layout: this.outlineBindGroupLayout,
          entries: [
            { binding: 0, resource: { buffer: this.cameraUniformBuffer } },
            { binding: 1, resource: { buffer: materialUniformBuffer } },
            { binding: 2, resource: { buffer: this.skinMatrixBuffer! } },
          ],
        })

        if (indexCount > 0) {
          const outlineType: DrawCallType = mat.isEye
            ? "eye-outline"
            : mat.isHair
            ? "hair-outline"
            : isTransparent
            ? "transparent-outline"
            : "opaque-outline"
          this.drawCalls.push({
            type: outlineType,
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup: outlineBindGroup,
            materialName: mat.name,
          })
        }
      }

      currentIndexOffset += indexCount
    }
  }

  private createMaterialUniformBuffer(label: string, alpha: number, isOverEyes: number): GPUBuffer {
    const data = new Float32Array(8)
    data.set([alpha, 1.0, this.rimLightIntensity, 0.0, 1.0, 1.0, 1.0, isOverEyes])
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

  private shouldRenderDrawCall(drawCall: DrawCall): boolean {
    return !this.hiddenMaterials.has(drawCall.materialName)
  }

  private async createTextureFromPath(path: string): Promise<GPUTexture | null> {
    const cached = this.textureCache.get(path)
    if (cached) {
      return cached
    }

    try {
      const response = await fetch(path)
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      const imageBitmap = await createImageBitmap(await response.blob(), {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      })

      const texture = this.device.createTexture({
        label: `texture: ${path}`,
        size: [imageBitmap.width, imageBitmap.height],
        format: "rgba8unorm",
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      this.device.queue.copyExternalImageToTexture({ source: imageBitmap }, { texture }, [
        imageBitmap.width,
        imageBitmap.height,
      ])

      this.textureCache.set(path, texture)
      return texture
    } catch {
      return null
    }
  }

  // Helper: Render eyes with stencil writing (for post-alpha-eye effect)
  private renderEyes(pass: GPURenderPassEncoder) {
    pass.setPipeline(this.eyePipeline)
    pass.setStencilReference(this.STENCIL_EYE_VALUE)
    for (const draw of this.drawCalls) {
      if (draw.type === "eye" && this.shouldRenderDrawCall(draw)) {
        pass.setBindGroup(0, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    }
  }

  // Helper: Render hair with post-alpha-eye effect (depth pre-pass + stencil-based shading + outlines)
  private renderHair(pass: GPURenderPassEncoder) {
    // Hair depth pre-pass (reduces overdraw via early depth rejection)
    const hasHair = this.drawCalls.some(
      (d) => (d.type === "hair-over-eyes" || d.type === "hair-over-non-eyes") && this.shouldRenderDrawCall(d)
    )
    if (hasHair) {
      pass.setPipeline(this.hairDepthPipeline)
      for (const draw of this.drawCalls) {
        if ((draw.type === "hair-over-eyes" || draw.type === "hair-over-non-eyes") && this.shouldRenderDrawCall(draw)) {
          pass.setBindGroup(0, draw.bindGroup)
          pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
        }
      }
    }

    // Hair shading (split by stencil for transparency over eyes)
    const hairOverEyes = this.drawCalls.filter((d) => d.type === "hair-over-eyes" && this.shouldRenderDrawCall(d))
    if (hairOverEyes.length > 0) {
      pass.setPipeline(this.hairPipelineOverEyes)
      pass.setStencilReference(this.STENCIL_EYE_VALUE)
      for (const draw of hairOverEyes) {
        pass.setBindGroup(0, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    }

    const hairOverNonEyes = this.drawCalls.filter(
      (d) => d.type === "hair-over-non-eyes" && this.shouldRenderDrawCall(d)
    )
    if (hairOverNonEyes.length > 0) {
      pass.setPipeline(this.hairPipelineOverNonEyes)
      pass.setStencilReference(this.STENCIL_EYE_VALUE)
      for (const draw of hairOverNonEyes) {
        pass.setBindGroup(0, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    }

    // Hair outlines
    const hairOutlines = this.drawCalls.filter((d) => d.type === "hair-outline" && this.shouldRenderDrawCall(d))
    if (hairOutlines.length > 0) {
      pass.setPipeline(this.hairOutlinePipeline)
      for (const draw of hairOutlines) {
        pass.setBindGroup(0, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    }
  }

  private handleCanvasClick = (event: MouseEvent) => {
    if (!this.onRaycast || !this.currentModel) return

    const rect = this.canvas.getBoundingClientRect()
    const x = event.clientX - rect.left
    const y = event.clientY - rect.top

    this.performRaycast(x, y)
  }

  private performRaycast(screenX: number, screenY: number) {
    if (!this.currentModel || !this.onRaycast) return

    const materials = this.currentModel.getMaterials()
    if (materials.length === 0) return

    // Get camera matrices
    const viewMatrix = this.camera.getViewMatrix()
    const projectionMatrix = this.camera.getProjectionMatrix()

    // Convert screen coordinates to world space ray (like Babylon.js)
    const canvas = this.canvas
    const rect = canvas.getBoundingClientRect()

    // Convert to clip space (-1 to 1)
    const clipX = (screenX / rect.width) * 2 - 1
    const clipY = 1 - (screenY / rect.height) * 2 // Flip Y

    // Create ray in clip space at near and far planes
    const clipNear = new Vec3(clipX, clipY, -1) // Near plane
    const clipFar = new Vec3(clipX, clipY, 1) // Far plane

    // Transform to world space using inverse view-projection matrix
    const viewProjMatrix = projectionMatrix.multiply(viewMatrix)
    const inverseViewProj = viewProjMatrix.inverse()

    // Transform point through 4x4 matrix with perspective division
    const transformPoint = (matrix: Mat4, point: Vec3): Vec3 => {
      const m = matrix.values
      const x = point.x,
        y = point.y,
        z = point.z

      // Compute transformed point (matrix * vec4(point, 1.0))
      const result = new Vec3(
        m[0] * x + m[4] * y + m[8] * z + m[12],
        m[1] * x + m[5] * y + m[9] * z + m[13],
        m[2] * x + m[6] * y + m[10] * z + m[14]
      )

      // Perspective division
      const w = m[3] * x + m[7] * y + m[11] * z + m[15]
      const invW = w !== 0 ? 1 / w : 1

      return result.scale(invW)
    }

    const worldNear = transformPoint(inverseViewProj, clipNear)
    const worldFar = transformPoint(inverseViewProj, clipFar)

    // Create ray from camera position through the clicked point
    const rayOrigin = this.camera.getPosition()
    const rayDirection = worldFar.subtract(worldNear).normalize()

    // Get model geometry for ray-triangle intersection
    const baseVertices = this.currentModel.getVertices()
    const indices = this.currentModel.getIndices()
    const skinning = this.currentModel.getSkinning()

    if (!baseVertices || !indices || !skinning) {
      if (this.onRaycast) {
        this.onRaycast(null)
      }
      return
    }

    // Use cached skinned vertices if available and up-to-date
    let vertices: Float32Array
    if (this.cachedSkinnedVertices && this.cachedSkinMatricesVersion === this.skinMatricesVersion) {
      vertices = this.cachedSkinnedVertices
    } else {
      // Apply current skinning transformations to get animated vertex positions
      vertices = new Float32Array(baseVertices.length)
      const skinMatrices = this.currentModel.getSkinMatrices()

      // Helper function to transform point by 4x4 matrix
      const transformByMatrix = (matrix: Float32Array, offset: number, point: Vec3): Vec3 => {
        const m = matrix
        const x = point.x,
          y = point.y,
          z = point.z
        return new Vec3(
          m[offset + 0] * x + m[offset + 4] * y + m[offset + 8] * z + m[offset + 12],
          m[offset + 1] * x + m[offset + 5] * y + m[offset + 9] * z + m[offset + 13],
          m[offset + 2] * x + m[offset + 6] * y + m[offset + 10] * z + m[offset + 14]
        )
      }

      for (let i = 0; i < baseVertices.length; i += 8) {
        const vertexIndex = Math.floor(i / 8)
        const position = new Vec3(baseVertices[i], baseVertices[i + 1], baseVertices[i + 2])

        // Get bone influences for this vertex
        const jointIndices = [
          skinning.joints[vertexIndex * 4],
          skinning.joints[vertexIndex * 4 + 1],
          skinning.joints[vertexIndex * 4 + 2],
          skinning.joints[vertexIndex * 4 + 3],
        ]

        const weights = [
          skinning.weights[vertexIndex * 4],
          skinning.weights[vertexIndex * 4 + 1],
          skinning.weights[vertexIndex * 4 + 2],
          skinning.weights[vertexIndex * 4 + 3],
        ]

        // Normalize weights (same as shader)
        const weightSum = weights[0] + weights[1] + weights[2] + weights[3]
        const invWeightSum = weightSum > 0.0001 ? 1.0 / weightSum : 1.0
        const normalizedWeights = weightSum > 0.0001 ? weights.map((w) => w * invWeightSum) : [1.0, 0.0, 0.0, 0.0]

        // Apply skinning transformation (same as shader)
        let skinnedPosition = new Vec3(0, 0, 0)

        for (let j = 0; j < 4; j++) {
          const weight = normalizedWeights[j]
          if (weight > 0) {
            const matrixOffset = jointIndices[j] * 16
            const transformed = transformByMatrix(skinMatrices, matrixOffset, position)
            skinnedPosition = skinnedPosition.add(transformed.scale(weight))
          }
        }

        // Store transformed position, copy other attributes unchanged
        vertices[i] = skinnedPosition.x
        vertices[i + 1] = skinnedPosition.y
        vertices[i + 2] = skinnedPosition.z
        vertices[i + 3] = baseVertices[i + 3] // normal X
        vertices[i + 4] = baseVertices[i + 4] // normal Y
        vertices[i + 5] = baseVertices[i + 5] // normal Z
        vertices[i + 6] = baseVertices[i + 6] // UV X
        vertices[i + 7] = baseVertices[i + 7] // UV Y
      }

      // Cache the result
      this.cachedSkinnedVertices = vertices
      this.cachedSkinMatricesVersion = this.skinMatricesVersion
    }

    let closestHit: { materialName: string; distance: number } | null = null
    const maxDistance = 1000 // Reasonable max distance

    // Test ray against all triangles (Möller-Trumbore algorithm)
    for (let i = 0; i < indices.length; i += 3) {
      const idx0 = indices[i] * 8 // Each vertex has 8 floats (pos + normal + uv)
      const idx1 = indices[i + 1] * 8
      const idx2 = indices[i + 2] * 8

      // Get triangle vertices in world space (first 3 floats are position)
      const v0 = new Vec3(vertices[idx0], vertices[idx0 + 1], vertices[idx0 + 2])
      const v1 = new Vec3(vertices[idx1], vertices[idx1 + 1], vertices[idx1 + 2])
      const v2 = new Vec3(vertices[idx2], vertices[idx2 + 1], vertices[idx2 + 2])

      // Find which material this triangle belongs to
      // Each material has mat.vertexCount indices (3 per triangle)
      let triangleMaterialIndex = -1
      let indexOffset = 0
      for (let matIdx = 0; matIdx < materials.length; matIdx++) {
        const mat = materials[matIdx]
        if (i >= indexOffset && i < indexOffset + mat.vertexCount) {
          triangleMaterialIndex = matIdx
          break
        }
        indexOffset += mat.vertexCount
      }

      if (triangleMaterialIndex === -1) continue

      // Skip invisible materials
      const materialName = materials[triangleMaterialIndex].name
      if (this.hiddenMaterials.has(materialName)) continue

      // Ray-triangle intersection test (Möller-Trumbore algorithm)
      const edge1 = v1.subtract(v0)
      const edge2 = v2.subtract(v0)
      const h = rayDirection.cross(edge2)
      const a = edge1.dot(h)

      if (Math.abs(a) < 0.0001) continue // Ray is parallel to triangle

      const f = 1.0 / a
      const s = rayOrigin.subtract(v0)
      const u = f * s.dot(h)

      if (u < 0.0 || u > 1.0) continue

      const q = s.cross(edge1)
      const v = f * rayDirection.dot(q)

      if (v < 0.0 || u + v > 1.0) continue

      // At this point we have a hit
      const t = f * edge2.dot(q)

      if (t > 0.0001 && t < maxDistance) {
        // Backface culling: only consider front-facing triangles
        const triangleNormal = edge1.cross(edge2).normalize()
        const isFrontFace = triangleNormal.dot(rayDirection) < 0

        if (isFrontFace) {
          if (!closestHit || t < closestHit.distance) {
            closestHit = {
              materialName: materials[triangleMaterialIndex].name,
              distance: t,
            }
          }
        }
      }
    }

    // Call the callback with the result
    if (this.onRaycast) {
      this.onRaycast(closestHit?.materialName || null)
    }
  }

  // Render strategy: 1) Opaque non-eye/hair 2) Eyes (stencil=1) 3) Hair (depth pre-pass + split by stencil) 4) Transparent 5) Bloom
  public render() {
    if (this.multisampleTexture && this.camera && this.device) {
      const currentTime = performance.now()
      const deltaTime = this.lastFrameTime > 0 ? (currentTime - this.lastFrameTime) / 1000 : 0.016
      this.lastFrameTime = currentTime

      this.updateCameraUniforms()
      this.updateRenderTarget()

      // Update model (handles tweens, animation, physics, IK, and skin matrices)
      if (this.currentModel) {
        const verticesChanged = this.currentModel.update(deltaTime)
        if (verticesChanged) {
          this.vertexBufferNeedsUpdate = true
        }
      }

      // Update vertex buffer if morphs changed
      if (this.vertexBufferNeedsUpdate) {
        this.updateVertexBuffer()
        this.vertexBufferNeedsUpdate = false
      }

      // Update skin matrices buffer
      this.updateSkinMatrices()

      // Use single encoder for render
      const encoder = this.device.createCommandEncoder()

      const pass = encoder.beginRenderPass(this.renderPassDescriptor)

      if (this.currentModel) {
        pass.setVertexBuffer(0, this.vertexBuffer)
        pass.setVertexBuffer(1, this.jointsBuffer)
        pass.setVertexBuffer(2, this.weightsBuffer)
        pass.setIndexBuffer(this.indexBuffer!, "uint32")

        // Pass 1: Opaque
        pass.setPipeline(this.modelPipeline)
        for (const draw of this.drawCalls) {
          if (draw.type === "opaque" && this.shouldRenderDrawCall(draw)) {
            pass.setBindGroup(0, draw.bindGroup)
            pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
          }
        }

        // Pass 2: Eyes (writes stencil value for hair to test against)
        this.renderEyes(pass)

        this.drawOutlines(pass, false)

        // Pass 3: Hair rendering (depth pre-pass + shading + outlines)
        this.renderHair(pass)

        // Pass 4: Transparent
        pass.setPipeline(this.modelPipeline)
        for (const draw of this.drawCalls) {
          if (draw.type === "transparent" && this.shouldRenderDrawCall(draw)) {
            pass.setBindGroup(0, draw.bindGroup)
            pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
          }
        }

        this.drawOutlines(pass, true)
      }

      pass.end()
      this.device.queue.submit([encoder.finish()])

      this.applyBloom()

      this.updateStats(performance.now() - currentTime)
    }
  }

  private applyBloom() {
    if (!this.sceneRenderTexture || !this.bloomExtractTexture) {
      return
    }

    // Update bloom parameters
    const thresholdData = new Float32Array(8)
    thresholdData[0] = this.bloomThreshold
    this.device.queue.writeBuffer(this.bloomThresholdBuffer, 0, thresholdData)

    const intensityData = new Float32Array(8)
    intensityData[0] = this.bloomIntensity
    this.device.queue.writeBuffer(this.bloomIntensityBuffer, 0, intensityData)

    const encoder = this.device.createCommandEncoder()

    // Extract bright areas
    const extractPass = encoder.beginRenderPass({
      label: "bloom extract",
      colorAttachments: [
        {
          view: this.bloomExtractTexture.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    })

    extractPass.setPipeline(this.bloomExtractPipeline)
    extractPass.setBindGroup(0, this.bloomExtractBindGroup!)
    extractPass.draw(6, 1, 0, 0)
    extractPass.end()

    // Horizontal blur
    const hBlurData = new Float32Array(4)
    hBlurData[0] = 1.0
    hBlurData[1] = 0.0
    this.device.queue.writeBuffer(this.blurDirectionBuffer, 0, hBlurData)
    const blurHPass = encoder.beginRenderPass({
      label: "bloom blur horizontal",
      colorAttachments: [
        {
          view: this.bloomBlurTexture1.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    })

    blurHPass.setPipeline(this.bloomBlurPipeline)
    blurHPass.setBindGroup(0, this.bloomBlurHBindGroup!)
    blurHPass.draw(6, 1, 0, 0)
    blurHPass.end()

    // Vertical blur
    const vBlurData = new Float32Array(4)
    vBlurData[0] = 0.0
    vBlurData[1] = 1.0
    this.device.queue.writeBuffer(this.blurDirectionBuffer, 0, vBlurData)
    const blurVPass = encoder.beginRenderPass({
      label: "bloom blur vertical",
      colorAttachments: [
        {
          view: this.bloomBlurTexture2.createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    })

    blurVPass.setPipeline(this.bloomBlurPipeline)
    blurVPass.setBindGroup(0, this.bloomBlurVBindGroup!)
    blurVPass.draw(6, 1, 0, 0)
    blurVPass.end()

    // Compose to canvas
    const composePass = encoder.beginRenderPass({
      label: "bloom compose",
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView(),
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          loadOp: "clear",
          storeOp: "store",
        },
      ],
    })

    composePass.setPipeline(this.bloomComposePipeline)
    composePass.setBindGroup(0, this.bloomComposeBindGroup!)
    composePass.draw(6, 1, 0, 0)
    composePass.end()

    this.device.queue.submit([encoder.finish()])
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

  private updateRenderTarget() {
    // Use cached view (only recreated on resize in handleResize)
    const colorAttachment = (this.renderPassDescriptor.colorAttachments as GPURenderPassColorAttachment[])[0]
    if (this.sampleCount > 1) {
      colorAttachment.resolveTarget = this.sceneRenderTextureView
    } else {
      colorAttachment.view = this.sceneRenderTextureView
    }
  }

  private updateSkinMatrices() {
    if (!this.currentModel || !this.skinMatrixBuffer) return

    const skinMatrices = this.currentModel.getSkinMatrices()
    this.device.queue.writeBuffer(
      this.skinMatrixBuffer,
      0,
      skinMatrices.buffer,
      skinMatrices.byteOffset,
      skinMatrices.byteLength
    )

    // Increment version to invalidate cached skinned vertices
    this.skinMatricesVersion++
  }

  private drawOutlines(pass: GPURenderPassEncoder, transparent: boolean) {
    pass.setPipeline(this.outlinePipeline)
    const outlineType: DrawCallType = transparent ? "transparent-outline" : "opaque-outline"
    for (const draw of this.drawCalls) {
      if (draw.type === outlineType && this.shouldRenderDrawCall(draw)) {
        pass.setBindGroup(0, draw.bindGroup)
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
