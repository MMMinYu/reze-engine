import { bezierInterpolate } from "./bezier-interpolate"
import { Camera } from "./camera"
import { Mat4, Quat, Vec3 } from "./math"
import { Model } from "./model"
import { PmxLoader } from "./pmx-loader"
import { Physics } from "./physics"
import { BoneFrame, MorphFrame, VMDKeyFrame, VMDLoader } from "./vmd-loader"

export type EngineOptions = {
  ambientColor?: Vec3
  bloomIntensity?: number
  rimLightIntensity?: number
  cameraDistance?: number
  cameraTarget?: Vec3
}

export interface EngineStats {
  fps: number
  frameTime: number // ms
}

interface DrawCall {
  count: number
  firstIndex: number
  bindGroup: GPUBindGroup
}

export class Engine {
  private canvas: HTMLCanvasElement
  private device!: GPUDevice
  private context!: GPUCanvasContext
  private presentationFormat!: GPUTextureFormat
  private camera!: Camera
  private cameraUniformBuffer!: GPUBuffer
  private cameraMatrixData = new Float32Array(36)
  private cameraDistance: number = 26.6
  private cameraTarget: Vec3 = new Vec3(0, 12.5, 0)
  private lightUniformBuffer!: GPUBuffer
  private lightData = new Float32Array(4)
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
  private worldMatrixBuffer?: GPUBuffer
  private inverseBindMatrixBuffer?: GPUBuffer
  private skinMatrixComputePipeline?: GPUComputePipeline
  private skinMatrixComputeBindGroup?: GPUBindGroup
  private boneCountBuffer?: GPUBuffer
  private multisampleTexture!: GPUTexture
  private readonly sampleCount = 4
  private renderPassDescriptor!: GPURenderPassDescriptor
  // Constants
  private readonly STENCIL_EYE_VALUE = 1
  private readonly COMPUTE_WORKGROUP_SIZE = 64
  private readonly BLOOM_DOWNSCALE_FACTOR = 2

  // Default values
  private static readonly DEFAULT_BLOOM_THRESHOLD = 0.01
  private static readonly DEFAULT_BLOOM_INTENSITY = 0.12
  private static readonly DEFAULT_RIM_LIGHT_INTENSITY = 0.45
  private static readonly DEFAULT_CAMERA_DISTANCE = 26.6
  private static readonly DEFAULT_CAMERA_TARGET = new Vec3(0, 12.5, 0)
  private static readonly TRANSPARENCY_EPSILON = 0.001
  private static readonly STATS_FPS_UPDATE_INTERVAL_MS = 1000
  private static readonly STATS_FRAME_TIME_ROUNDING = 100

  // Ambient light settings
  private ambientColor: Vec3 = new Vec3(1.0, 1.0, 1.0)
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
  private bloomThreshold: number = Engine.DEFAULT_BLOOM_THRESHOLD
  private bloomIntensity: number = Engine.DEFAULT_BLOOM_INTENSITY
  // Rim light settings
  private rimLightIntensity: number = Engine.DEFAULT_RIM_LIGHT_INTENSITY

  private currentModel: Model | null = null
  private modelDir: string = ""
  private physics: Physics | null = null
  private materialSampler!: GPUSampler
  private textureCache = new Map<string, GPUTexture>()
  private vertexBufferNeedsUpdate = false
  // Draw lists
  private opaqueDraws: DrawCall[] = []
  private eyeDraws: DrawCall[] = []
  private hairDrawsOverEyes: DrawCall[] = []
  private hairDrawsOverNonEyes: DrawCall[] = []
  private transparentDraws: DrawCall[] = []
  private opaqueOutlineDraws: DrawCall[] = []
  private eyeOutlineDraws: DrawCall[] = []
  private hairOutlineDraws: DrawCall[] = []
  private transparentOutlineDraws: DrawCall[] = []

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

  private animationFrames: VMDKeyFrame[] = []
  private animationTimeouts: number[] = []
  private hasAnimation = false // Set to true when loadAnimation is called
  private playingAnimation = false // Set to true when playAnimation is called
  private animationStartTime: number = 0 // When animation started playing
  private animationDuration: number = 0 // Total animation duration in seconds
  private boneTracks: Map<string, Array<{ boneFrame: BoneFrame; time: number }>> = new Map()
  private morphTracks: Map<string, Array<{ morphFrame: MorphFrame; time: number }>> = new Map()

  constructor(canvas: HTMLCanvasElement, options?: EngineOptions) {
    this.canvas = canvas
    if (options) {
      this.ambientColor = options.ambientColor ?? new Vec3(1.0, 1.0, 1.0)
      this.bloomIntensity = options.bloomIntensity ?? Engine.DEFAULT_BLOOM_INTENSITY
      this.rimLightIntensity = options.rimLightIntensity ?? Engine.DEFAULT_RIM_LIGHT_INTENSITY
      this.cameraDistance = options.cameraDistance ?? Engine.DEFAULT_CAMERA_DISTANCE
      this.cameraTarget = options.cameraTarget ?? Engine.DEFAULT_CAMERA_TARGET
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

  private createPipelines() {
    this.materialSampler = this.device.createSampler({
      magFilter: "linear",
      minFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "repeat",
    })

    const shaderModule = this.device.createShaderModule({
      label: "model shaders",
      code: /* wgsl */ `
        struct CameraUniforms {
          view: mat4x4f,
          projection: mat4x4f,
          viewPos: vec3f,
          _padding: f32,
        };

        struct LightUniforms {
          ambientColor: vec3f,
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

          let lightAccum = light.ambientColor;
          
          // Rim light calculation
          let viewDir = normalize(camera.viewPos - input.worldPos);
          var rimFactor = 1.0 - max(dot(n, viewDir), 0.0);
          rimFactor = rimFactor * rimFactor; // Optimized: direct multiply instead of pow(x, 2.0)
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

    this.modelPipeline = this.device.createRenderPipeline({
      label: "model pipeline",
      layout: mainPipelineLayout,
      vertex: {
        module: shaderModule,
        buffers: [
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
        ],
      },
      fragment: {
        module: shaderModule,
        targets: [
          {
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
          },
        ],
      },
      primitive: { cullMode: "none" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
      multisample: {
        count: this.sampleCount,
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

    this.outlinePipeline = this.device.createRenderPipeline({
      label: "outline pipeline",
      layout: outlinePipelineLayout,
      vertex: {
        module: outlineShaderModule,
        buffers: [
          {
            arrayStride: 8 * 4,
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: "float32x3" as GPUVertexFormat,
              },
              {
                shaderLocation: 1,
                offset: 3 * 4,
                format: "float32x3" as GPUVertexFormat,
              },
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
        ],
      },
      fragment: {
        module: outlineShaderModule,
        targets: [
          {
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
          },
        ],
      },
      primitive: {
        cullMode: "back",
      },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal",
      },
      multisample: {
        count: this.sampleCount,
      },
    })

    // Hair outline pipeline
    this.hairOutlinePipeline = this.device.createRenderPipeline({
      label: "hair outline pipeline",
      layout: outlinePipelineLayout,
      vertex: {
        module: outlineShaderModule,
        buffers: [
          {
            arrayStride: 8 * 4,
            attributes: [
              {
                shaderLocation: 0,
                offset: 0,
                format: "float32x3" as GPUVertexFormat,
              },
              {
                shaderLocation: 1,
                offset: 3 * 4,
                format: "float32x3" as GPUVertexFormat,
              },
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
        ],
      },
      fragment: {
        module: outlineShaderModule,
        targets: [
          {
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
          },
        ],
      },
      primitive: {
        cullMode: "back",
      },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: false, // Don't write depth - let hair geometry control depth
        depthCompare: "less-equal", // Only draw where hair depth exists (no stencil test needed)
        depthBias: -0.0001, // Small negative bias to bring outline slightly closer for depth test
        depthBiasSlopeScale: 0.0,
        depthBiasClamp: 0.0,
      },
      multisample: {
        count: this.sampleCount,
      },
    })

    // Eye overlay pipeline (renders after opaque, writes stencil)
    this.eyePipeline = this.device.createRenderPipeline({
      label: "eye overlay pipeline",
      layout: mainPipelineLayout,
      vertex: {
        module: shaderModule,
        buffers: [
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
        ],
      },
      fragment: {
        module: shaderModule,
        targets: [
          {
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
          },
        ],
      },
      primitive: { cullMode: "front" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true, // Write depth to occlude back of head
        depthCompare: "less-equal", // More lenient to reduce precision conflicts
        depthBias: -0.00005, // Reduced bias to minimize conflicts while still occluding back face
        depthBiasSlopeScale: 0.0,
        depthBiasClamp: 0.0,
        stencilFront: {
          compare: "always",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "replace", // Write stencil value 1
        },
        stencilBack: {
          compare: "always",
          failOp: "keep",
          depthFailOp: "keep",
          passOp: "replace",
        },
      },
      multisample: { count: this.sampleCount },
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
    this.hairDepthPipeline = this.device.createRenderPipeline({
      label: "hair depth pre-pass",
      layout: mainPipelineLayout,
      vertex: {
        module: depthOnlyShaderModule,
        buffers: [
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
        ],
      },
      fragment: {
        module: depthOnlyShaderModule,
        entryPoint: "fs",
        targets: [
          {
            format: this.presentationFormat,
            writeMask: 0, // Disable all color writes - we only care about depth
          },
        ],
      },
      primitive: { cullMode: "front" },
      depthStencil: {
        format: "depth24plus-stencil8",
        depthWriteEnabled: true,
        depthCompare: "less-equal", // Match the color pass compare mode for consistency
        depthBias: 0.0,
        depthBiasSlopeScale: 0.0,
        depthBiasClamp: 0.0,
      },
      multisample: { count: this.sampleCount },
    })

    // Hair pipelines for rendering over eyes vs non-eyes (only differ in stencil compare mode)
    const createHairPipeline = (isOverEyes: boolean): GPURenderPipeline => {
      return this.device.createRenderPipeline({
        label: `hair pipeline (${isOverEyes ? "over eyes" : "over non-eyes"})`,
        layout: mainPipelineLayout,
        vertex: {
          module: shaderModule,
          buffers: [
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
          ],
        },
        fragment: {
          module: shaderModule,
          targets: [
            {
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
            },
          ],
        },
        primitive: { cullMode: "front" },
        depthStencil: {
          format: "depth24plus-stencil8",
          depthWriteEnabled: false, // Don't write depth (already written in pre-pass)
          depthCompare: "less-equal", // More lenient than "equal" to avoid precision issues with MSAA
          stencilFront: {
            compare: isOverEyes ? "equal" : "not-equal", // Over eyes: stencil == 1, over non-eyes: stencil != 1
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
        multisample: { count: this.sampleCount },
      })
    }

    this.hairPipelineOverEyes = createHairPipeline(true)
    this.hairPipelineOverNonEyes = createHairPipeline(false)
  }

  // Create compute shader for skin matrix computation
  private createSkinMatrixComputePipeline() {
    const computeShader = this.device.createShaderModule({
      label: "skin matrix compute",
      code: /* wgsl */ `
        struct BoneCountUniform {
          count: u32,
          _padding1: u32,
          _padding2: u32,
          _padding3: u32,
          _padding4: vec4<u32>,
        };
        
        @group(0) @binding(0) var<uniform> boneCount: BoneCountUniform;
        @group(0) @binding(1) var<storage, read> worldMatrices: array<mat4x4f>;
        @group(0) @binding(2) var<storage, read> inverseBindMatrices: array<mat4x4f>;
        @group(0) @binding(3) var<storage, read_write> skinMatrices: array<mat4x4f>;
        
        @compute @workgroup_size(64) // Must match COMPUTE_WORKGROUP_SIZE
        fn main(@builtin(global_invocation_id) globalId: vec3<u32>) {
          let boneIndex = globalId.x;
          if (boneIndex >= boneCount.count) {
            return;
          }
          let worldMat = worldMatrices[boneIndex];
          let invBindMat = inverseBindMatrices[boneIndex];
          skinMatrices[boneIndex] = worldMat * invBindMat;
        }
      `,
    })

    this.skinMatrixComputePipeline = this.device.createComputePipeline({
      label: "skin matrix compute pipeline",
      layout: "auto",
      compute: {
        module: computeShader,
      },
    })
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

    this.camera = new Camera(Math.PI, Math.PI / 2.5, this.cameraDistance, this.cameraTarget)

    this.camera.aspect = this.canvas.width / this.canvas.height
    this.camera.attachControl(this.canvas)
  }

  // Step 5: Create lighting buffers
  private setupLighting() {
    this.lightUniformBuffer = this.device.createBuffer({
      label: "light uniforms",
      size: 4 * 4, // 4 floats: ambientColor vec3f (3) + padding (1)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })

    this.setAmbientColor(this.ambientColor)

    this.device.queue.writeBuffer(this.lightUniformBuffer, 0, this.lightData)
  }

  private setAmbientColor(color: Vec3) {
    // Layout: ambientColor (0-2), padding (3)
    this.lightData[0] = color.x
    this.lightData[1] = color.y
    this.lightData[2] = color.z
    this.lightData[3] = 0.0 // Padding for vec3f alignment
  }

  public async loadAnimation(url: string) {
    const frames = await VMDLoader.load(url)
    this.animationFrames = frames
    this.hasAnimation = true
  }

  public playAnimation() {
    if (this.animationFrames.length === 0) return

    this.stopAnimation()

    this.playingAnimation = true

    // Process bone frames
    const allBoneKeyFrames: Array<{ boneFrame: BoneFrame; time: number }> = []
    for (const keyFrame of this.animationFrames) {
      for (const boneFrame of keyFrame.boneFrames) {
        allBoneKeyFrames.push({
          boneFrame,
          time: keyFrame.time,
        })
      }
    }

    const boneKeyFramesByBone = new Map<string, Array<{ boneFrame: BoneFrame; time: number }>>()
    for (const { boneFrame, time } of allBoneKeyFrames) {
      if (!boneKeyFramesByBone.has(boneFrame.boneName)) {
        boneKeyFramesByBone.set(boneFrame.boneName, [])
      }
      boneKeyFramesByBone.get(boneFrame.boneName)!.push({ boneFrame, time })
    }

    for (const keyFrames of boneKeyFramesByBone.values()) {
      keyFrames.sort((a, b) => a.time - b.time)
    }

    // Process morph frames
    const allMorphKeyFrames: Array<{ morphFrame: MorphFrame; time: number }> = []
    for (const keyFrame of this.animationFrames) {
      for (const morphFrame of keyFrame.morphFrames) {
        allMorphKeyFrames.push({
          morphFrame,
          time: keyFrame.time,
        })
      }
    }

    const morphKeyFramesByMorph = new Map<string, Array<{ morphFrame: MorphFrame; time: number }>>()
    for (const { morphFrame, time } of allMorphKeyFrames) {
      if (!morphKeyFramesByMorph.has(morphFrame.morphName)) {
        morphKeyFramesByMorph.set(morphFrame.morphName, [])
      }
      morphKeyFramesByMorph.get(morphFrame.morphName)!.push({ morphFrame, time })
    }

    for (const keyFrames of morphKeyFramesByMorph.values()) {
      keyFrames.sort((a, b) => a.time - b.time)
    }

    // Store tracks for frame-based animation
    this.boneTracks = boneKeyFramesByBone
    this.morphTracks = morphKeyFramesByMorph

    // Calculate animation duration from max frame time (already in seconds)
    let maxFrameTime = 0
    for (const keyFrames of this.boneTracks.values()) {
      if (keyFrames.length > 0) {
        const lastTime = keyFrames[keyFrames.length - 1].time
        if (lastTime > maxFrameTime) {
          maxFrameTime = lastTime
        }
      }
    }
    for (const keyFrames of this.morphTracks.values()) {
      if (keyFrames.length > 0) {
        const lastTime = keyFrames[keyFrames.length - 1].time
        if (lastTime > maxFrameTime) {
          maxFrameTime = lastTime
        }
      }
    }
    this.animationDuration = maxFrameTime > 0 ? maxFrameTime : 0
    this.animationStartTime = performance.now()

    // Initialize bones and morphs to time 0 pose
    if (this.currentModel) {
      const skeleton = this.currentModel.getSkeleton()
      const bonesWithTime0 = new Set<string>()

      // Apply time 0 bone keyframes
      for (const [boneName, keyFrames] of this.boneTracks.entries()) {
        if (keyFrames.length > 0 && keyFrames[0].time === 0) {
          const boneFrame = keyFrames[0].boneFrame
          this.rotateBones([boneName], [boneFrame.rotation], 0)
          this.moveBones([boneName], [boneFrame.translation], 0)
          bonesWithTime0.add(boneName)
        }
      }

      // Reset bones without time 0 keyframes
      const bonesToReset: string[] = []
      for (const bone of skeleton.bones) {
        if (!bonesWithTime0.has(bone.name)) {
          bonesToReset.push(bone.name)
        }
      }

      if (bonesToReset.length > 0) {
        const identityQuat = new Quat(0, 0, 0, 1)
        const identityQuats = new Array(bonesToReset.length).fill(identityQuat)
        this.rotateBones(bonesToReset, identityQuats, 0)
      }

      // Apply time 0 morph keyframes
      for (const [morphName, keyFrames] of this.morphTracks.entries()) {
        if (keyFrames.length > 0 && keyFrames[0].time === 0) {
          const morphFrame = keyFrames[0].morphFrame
          this.setMorphWeight(morphName, morphFrame.weight, 0)
        }
      }

      // Reset physics immediately and upload matrices to prevent A-pose flash
      if (this.physics) {
        this.currentModel.evaluatePose()

        const worldMats = this.currentModel.getBoneWorldMatrices()
        this.physics.reset(worldMats, this.currentModel.getBoneInverseBindMatrices())

        // Upload matrices immediately so next frame shows correct pose
        this.device.queue.writeBuffer(
          this.worldMatrixBuffer!,
          0,
          worldMats.buffer,
          worldMats.byteOffset,
          worldMats.byteLength
        )
        const encoder = this.device.createCommandEncoder()
        this.computeSkinMatrices(encoder)
        this.device.queue.submit([encoder.finish()])
      }
    }
  }

  public stopAnimation() {
    for (const timeoutId of this.animationTimeouts) {
      clearTimeout(timeoutId)
    }
    this.animationTimeouts = []
    this.playingAnimation = false
    this.boneTracks.clear()
    this.morphTracks.clear()
  }

  // Frame-based animation update (called every frame)
  // Similar to reference: MmdRuntimeModelAnimation.animate(frameTime)
  // frameTime is in seconds (already converted from VMD frame numbers in loader)
  private animate(frameTime: number): void {
    if (!this.currentModel) return

    // Helper to find upper bound index (binary search)
    const upperBoundFrameIndex = (time: number, keyFrames: Array<{ boneFrame: BoneFrame; time: number }>): number => {
      let left = 0
      let right = keyFrames.length
      while (left < right) {
        const mid = Math.floor((left + right) / 2)
        if (keyFrames[mid].time <= time) {
          left = mid + 1
        } else {
          right = mid
        }
      }
      return left
    }

    const boneNamesToRotate: string[] = []
    const rotationsToApply: Quat[] = []
    const boneNamesToMove: string[] = []
    const translationsToApply: Vec3[] = []
    const morphNamesToSet: string[] = []
    const morphWeightsToSet: number[] = []

    // Process each bone track
    for (const [boneName, keyFrames] of this.boneTracks.entries()) {
      if (keyFrames.length === 0) continue

      // Clamp frame time to track range (all times are in seconds)
      const startTime = keyFrames[0].time
      const endTime = keyFrames[keyFrames.length - 1].time
      const clampedFrameTime = Math.max(startTime, Math.min(endTime, frameTime))

      const upperBoundIndex = upperBoundFrameIndex(clampedFrameTime, keyFrames)
      const upperBoundIndexMinusOne = upperBoundIndex - 1

      if (upperBoundIndexMinusOne < 0) continue

      const timeB = keyFrames[upperBoundIndex]?.time
      const boneFrameA = keyFrames[upperBoundIndexMinusOne].boneFrame

      if (timeB === undefined) {
        // Last keyframe or beyond - use the last keyframe value
        boneNamesToRotate.push(boneName)
        rotationsToApply.push(boneFrameA.rotation)
        boneNamesToMove.push(boneName)
        translationsToApply.push(boneFrameA.translation)
      } else {
        // Interpolate between two keyframes
        const timeA = keyFrames[upperBoundIndexMinusOne].time
        const boneFrameB = keyFrames[upperBoundIndex].boneFrame
        const gradient = (clampedFrameTime - timeA) / (timeB - timeA)

        // Interpolate rotation using Bezier
        const interp = boneFrameB.interpolation
        const rotWeight = bezierInterpolate(
          interp[0] / 127, // x1
          interp[1] / 127, // x2
          interp[2] / 127, // y1
          interp[3] / 127, // y2
          gradient
        )
        const interpolatedRotation = Quat.slerp(boneFrameA.rotation, boneFrameB.rotation, rotWeight)

        // Interpolate translation using Bezier (separate curves for X, Y, Z)
        // VMD interpolation layout (from reference, 4x4 grid, row-major):
        // Row 0: X_x1, Y_x1, phy1, phy2,
        // Row 1: X_y1, Y_y1, Z_y1, R_y1,
        // Row 2: X_x2, Y_x2, Z_x2, R_x2,
        // Row 3: X_y2, Y_y2, Z_y2, R_y2,
        // Row 4: Y_x1, Z_x1, R_x1, X_y1,
        // Row 5: Y_y1, Z_y1, R_y1, X_x2,
        // Row 6: Y_x2, Z_x2, R_x2, X_y2,
        // Row 7: Y_y2, Z_y2, R_y2, 00,
        // Row 8: Z_x1, R_x1, X_y1, Y_y1,
        // Row 9: Z_y1, R_y1, X_x2, Y_x2,
        // Row 10: Z_x2, R_x2, X_y2, Y_y2,
        // Row 11: Z_y2, R_y2, 00, 00,
        // Row 12: R_x1, X_y1, Y_y1, Z_y1,
        // Row 13: R_y1, X_x2, Y_x2, Z_x2,
        // Row 14: R_x2, X_y2, Y_y2, Z_y2,
        // Row 15: R_y2, 00, 00, 00
        // For rotation: R_x1=16, R_y1=20, R_x2=24, R_y2=28
        // For position X: X_x1=0, X_y1=4, X_x2=8, X_y2=12
        // For position Y: Y_x1=16, Y_y1=20, Y_x2=24, Y_y2=28
        // For position Z: Z_x1=32, Z_y1=36, Z_x2=40, Z_y2=44
        const xWeight = bezierInterpolate(
          interp[0] / 127, // X_x1
          interp[8] / 127, // X_x2
          interp[4] / 127, // X_y1
          interp[12] / 127, // X_y2
          gradient
        )
        const yWeight = bezierInterpolate(
          interp[16] / 127, // Y_x1
          interp[24] / 127, // Y_x2
          interp[20] / 127, // Y_y1
          interp[28] / 127, // Y_y2
          gradient
        )
        const zWeight = bezierInterpolate(
          interp[32] / 127, // Z_x1
          interp[40] / 127, // Z_x2
          interp[36] / 127, // Z_y1
          interp[44] / 127, // Z_y2
          gradient
        )

        const interpolatedTranslation = new Vec3(
          boneFrameA.translation.x + (boneFrameB.translation.x - boneFrameA.translation.x) * xWeight,
          boneFrameA.translation.y + (boneFrameB.translation.y - boneFrameA.translation.y) * yWeight,
          boneFrameA.translation.z + (boneFrameB.translation.z - boneFrameA.translation.z) * zWeight
        )

        boneNamesToRotate.push(boneName)
        rotationsToApply.push(interpolatedRotation)
        boneNamesToMove.push(boneName)
        translationsToApply.push(interpolatedTranslation)
      }
    }

    // Helper to find upper bound index for morph frames
    const upperBoundMorphIndex = (time: number, keyFrames: Array<{ morphFrame: MorphFrame; time: number }>): number => {
      let left = 0
      let right = keyFrames.length
      while (left < right) {
        const mid = Math.floor((left + right) / 2)
        if (keyFrames[mid].time <= time) {
          left = mid + 1
        } else {
          right = mid
        }
      }
      return left
    }

    // Process each morph track
    for (const [morphName, keyFrames] of this.morphTracks.entries()) {
      if (keyFrames.length === 0) continue

      // Clamp frame time to track range
      const startTime = keyFrames[0].time
      const endTime = keyFrames[keyFrames.length - 1].time
      const clampedFrameTime = Math.max(startTime, Math.min(endTime, frameTime))

      const upperBoundIndex = upperBoundMorphIndex(clampedFrameTime, keyFrames)
      const upperBoundIndexMinusOne = upperBoundIndex - 1

      if (upperBoundIndexMinusOne < 0) continue

      const timeB = keyFrames[upperBoundIndex]?.time
      const morphFrameA = keyFrames[upperBoundIndexMinusOne].morphFrame

      if (timeB === undefined) {
        // Last keyframe or beyond - use the last keyframe value
        morphNamesToSet.push(morphName)
        morphWeightsToSet.push(morphFrameA.weight)
      } else {
        // Linear interpolation between two keyframes
        const timeA = keyFrames[upperBoundIndexMinusOne].time
        const morphFrameB = keyFrames[upperBoundIndex].morphFrame
        const gradient = (clampedFrameTime - timeA) / (timeB - timeA)
        const interpolatedWeight = morphFrameA.weight + (morphFrameB.weight - morphFrameA.weight) * gradient

        morphNamesToSet.push(morphName)
        morphWeightsToSet.push(interpolatedWeight)
      }
    }

    // Apply all rotations, translations, and morphs at once (no tweening - direct application)
    if (boneNamesToRotate.length > 0) {
      this.rotateBones(boneNamesToRotate, rotationsToApply, 0)
    }
    if (boneNamesToMove.length > 0) {
      this.moveBones(boneNamesToMove, translationsToApply, 0)
    }
    if (morphNamesToSet.length > 0) {
      for (let i = 0; i < morphNamesToSet.length; i++) {
        this.setMorphWeight(morphNamesToSet[i], morphWeightsToSet[i], 0)
      }
    }
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

    this.physics = new Physics(model.getRigidbodies(), model.getJoints())
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
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.VERTEX,
    })

    this.worldMatrixBuffer = this.device.createBuffer({
      label: "world matrices",
      size: Math.max(256, matrixSize),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
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

    this.boneCountBuffer = this.device.createBuffer({
      label: "bone count uniform",
      size: 32, // Minimum uniform buffer size is 32 bytes
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    const boneCountData = new Uint32Array(8) // 32 bytes total
    boneCountData[0] = boneCount
    this.device.queue.writeBuffer(this.boneCountBuffer, 0, boneCountData)

    this.createSkinMatrixComputePipeline()

    // Create compute bind group once (reused every frame)
    this.skinMatrixComputeBindGroup = this.device.createBindGroup({
      layout: this.skinMatrixComputePipeline!.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: this.boneCountBuffer } },
        { binding: 1, resource: { buffer: this.worldMatrixBuffer } },
        { binding: 2, resource: { buffer: this.inverseBindMatrixBuffer } },
        { binding: 3, resource: { buffer: this.skinMatrixBuffer } },
      ],
    })

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

    this.opaqueDraws = []
    this.eyeDraws = []
    this.hairDrawsOverEyes = []
    this.hairDrawsOverNonEyes = []
    this.transparentDraws = []
    this.opaqueOutlineDraws = []
    this.eyeOutlineDraws = []
    this.hairOutlineDraws = []
    this.transparentOutlineDraws = []
    let currentIndexOffset = 0

    for (const mat of materials) {
      const indexCount = mat.vertexCount
      if (indexCount === 0) continue

      const diffuseTexture = await loadTextureByIndex(mat.diffuseTextureIndex)
      if (!diffuseTexture) throw new Error(`Material "${mat.name}" has no diffuse texture`)

      const materialAlpha = mat.diffuse[3]
      const isTransparent = materialAlpha < 1.0 - Engine.TRANSPARENCY_EPSILON

      // Create material uniform data
      const materialUniformData = new Float32Array(8)
      materialUniformData[0] = materialAlpha
      materialUniformData[1] = 1.0 // alphaMultiplier: 1.0 for non-hair materials
      materialUniformData[2] = this.rimLightIntensity
      materialUniformData[3] = 0.0 // _padding1
      materialUniformData[4] = 1.0 // rimColor.r
      materialUniformData[5] = 1.0 // rimColor.g
      materialUniformData[6] = 1.0 // rimColor.b
      materialUniformData[7] = 0.0 // isOverEyes

      const materialUniformBuffer = this.device.createBuffer({
        label: `material uniform: ${mat.name}`,
        size: materialUniformData.byteLength,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      })
      this.device.queue.writeBuffer(materialUniformBuffer, 0, materialUniformData)

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

      if (mat.isEye) {
        if (indexCount > 0) {
          this.eyeDraws.push({
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup,
          })
        }
      } else if (mat.isHair) {
        // Hair materials: create separate bind groups for over-eyes vs over-non-eyes
        const createHairBindGroup = (isOverEyes: boolean) => {
          const uniformData = new Float32Array(8)
          uniformData[0] = materialAlpha
          uniformData[1] = 1.0 // alphaMultiplier (shader adjusts based on isOverEyes)
          uniformData[2] = this.rimLightIntensity
          uniformData[3] = 0.0 // _padding1
          uniformData[4] = 1.0 // rimColor.rgb
          uniformData[5] = 1.0
          uniformData[6] = 1.0
          uniformData[7] = isOverEyes ? 1.0 : 0.0 // isOverEyes

          const buffer = this.device.createBuffer({
            label: `material uniform (${isOverEyes ? "over eyes" : "over non-eyes"}): ${mat.name}`,
            size: uniformData.byteLength,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          })
          this.device.queue.writeBuffer(buffer, 0, uniformData)

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

        if (indexCount > 0) {
          this.hairDrawsOverEyes.push({
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup: bindGroupOverEyes,
          })

          this.hairDrawsOverNonEyes.push({
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup: bindGroupOverNonEyes,
          })
        }
      } else if (isTransparent) {
        if (indexCount > 0) {
          this.transparentDraws.push({
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup,
          })
        }
      } else {
        if (indexCount > 0) {
          this.opaqueDraws.push({
            count: indexCount,
            firstIndex: currentIndexOffset,
            bindGroup,
          })
        }
      }

      // Edge flag is at bit 4 (0x10) in PMX format
      if ((mat.edgeFlag & 0x10) !== 0 && mat.edgeSize > 0) {
        const materialUniformData = new Float32Array(8)
        materialUniformData[0] = mat.edgeColor[0] // edgeColor.r
        materialUniformData[1] = mat.edgeColor[1] // edgeColor.g
        materialUniformData[2] = mat.edgeColor[2] // edgeColor.b
        materialUniformData[3] = mat.edgeColor[3] // edgeColor.a
        materialUniformData[4] = mat.edgeSize
        materialUniformData[5] = 0.0 // isOverEyes
        materialUniformData[6] = 0.0
        materialUniformData[7] = 0.0

        const materialUniformBuffer = this.device.createBuffer({
          label: `outline material uniform: ${mat.name}`,
          size: materialUniformData.byteLength,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        this.device.queue.writeBuffer(materialUniformBuffer, 0, materialUniformData)

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
          if (mat.isEye) {
            this.eyeOutlineDraws.push({
              count: indexCount,
              firstIndex: currentIndexOffset,
              bindGroup: outlineBindGroup,
            })
          } else if (mat.isHair) {
            this.hairOutlineDraws.push({
              count: indexCount,
              firstIndex: currentIndexOffset,
              bindGroup: outlineBindGroup,
            })
          } else if (isTransparent) {
            this.transparentOutlineDraws.push({
              count: indexCount,
              firstIndex: currentIndexOffset,
              bindGroup: outlineBindGroup,
            })
          } else {
            this.opaqueOutlineDraws.push({
              count: indexCount,
              firstIndex: currentIndexOffset,
              bindGroup: outlineBindGroup,
            })
          }
        }
      }

      currentIndexOffset += indexCount
    }
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
    for (const draw of this.eyeDraws) {
      pass.setBindGroup(0, draw.bindGroup)
      pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
    }
  }

  // Helper: Render hair with post-alpha-eye effect (depth pre-pass + stencil-based shading + outlines)
  private renderHair(pass: GPURenderPassEncoder) {
    // Hair depth pre-pass (reduces overdraw via early depth rejection)
    const hasHair = this.hairDrawsOverEyes.length > 0 || this.hairDrawsOverNonEyes.length > 0
    if (hasHair) {
      pass.setPipeline(this.hairDepthPipeline)
      for (const draw of this.hairDrawsOverEyes) {
        pass.setBindGroup(0, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
      for (const draw of this.hairDrawsOverNonEyes) {
        pass.setBindGroup(0, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    }

    // Hair shading (split by stencil for transparency over eyes)
    if (this.hairDrawsOverEyes.length > 0) {
      pass.setPipeline(this.hairPipelineOverEyes)
      pass.setStencilReference(this.STENCIL_EYE_VALUE)
      for (const draw of this.hairDrawsOverEyes) {
        pass.setBindGroup(0, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    }

    if (this.hairDrawsOverNonEyes.length > 0) {
      pass.setPipeline(this.hairPipelineOverNonEyes)
      pass.setStencilReference(this.STENCIL_EYE_VALUE)
      for (const draw of this.hairDrawsOverNonEyes) {
        pass.setBindGroup(0, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
    }

    // Hair outlines
    if (this.hairOutlineDraws.length > 0) {
      pass.setPipeline(this.hairOutlinePipeline)
      for (const draw of this.hairOutlineDraws) {
        pass.setBindGroup(0, draw.bindGroup)
        pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
      }
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

      // Animate VMD animation if playing
      if (this.playingAnimation && this.currentModel && this.animationDuration > 0) {
        const elapsedSeconds = (currentTime - this.animationStartTime) / 1000
        if (elapsedSeconds >= this.animationDuration) {
          // Animation has ended, stop it
          this.stopAnimation()
        } else {
          const frameTime = elapsedSeconds
          this.animate(frameTime)
        }
      } else if (this.playingAnimation && this.animationDuration <= 0) {
        // Animation has no duration or invalid, stop it immediately
        this.stopAnimation()
      }

      // Update model pose first (this may update morph weights via tweens)
      // We need to do this before creating the encoder to ensure vertex buffer is ready
      if (this.currentModel) {
        const hasActiveMorphTweens = this.currentModel.evaluatePose()
        if (hasActiveMorphTweens) {
          this.vertexBufferNeedsUpdate = true
        }
      }

      // Update vertex buffer if morphs changed
      if (this.vertexBufferNeedsUpdate) {
        this.updateVertexBuffer()
        this.vertexBufferNeedsUpdate = false
      }

      // Use single encoder for both compute and render (reduces sync points)
      const encoder = this.device.createCommandEncoder()

      this.updateModelPose(deltaTime, encoder)

      // Hide model if animation is loaded but hasn't started playing yet (prevents A-pose flash)
      // Once animation has played (even if it stopped), continue rendering normally
      // Still update physics and poses, just don't render visually before first play
      if (this.hasAnimation && !this.playingAnimation && this.animationStartTime === 0) {
        // Submit encoder to ensure matrices are uploaded and physics initializes
        this.device.queue.submit([encoder.finish()])
        return
      }

      const pass = encoder.beginRenderPass(this.renderPassDescriptor)

      if (this.currentModel) {
        pass.setVertexBuffer(0, this.vertexBuffer)
        pass.setVertexBuffer(1, this.jointsBuffer)
        pass.setVertexBuffer(2, this.weightsBuffer)
        pass.setIndexBuffer(this.indexBuffer!, "uint32")

        // Pass 1: Opaque
        pass.setPipeline(this.modelPipeline)
        for (const draw of this.opaqueDraws) {
          pass.setBindGroup(0, draw.bindGroup)
          pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
        }

        // Pass 2: Eyes (writes stencil value for hair to test against)
        this.renderEyes(pass)

        this.drawOutlines(pass, false)

        // Pass 3: Hair rendering (depth pre-pass + shading + outlines)
        this.renderHair(pass)

        // Pass 4: Transparent
        pass.setPipeline(this.modelPipeline)
        for (const draw of this.transparentDraws) {
          pass.setBindGroup(0, draw.bindGroup)
          pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
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

  private updateModelPose(deltaTime: number, encoder: GPUCommandEncoder) {
    // Note: evaluatePose is called earlier in render() to update vertex buffer before encoder creation
    // Here we just get the matrices and update physics/compute
    const worldMats = this.currentModel!.getBoneWorldMatrices()

    if (this.physics) {
      this.physics.step(deltaTime, worldMats, this.currentModel!.getBoneInverseBindMatrices())
    }

    this.device.queue.writeBuffer(
      this.worldMatrixBuffer!,
      0,
      worldMats.buffer,
      worldMats.byteOffset,
      worldMats.byteLength
    )
    this.computeSkinMatrices(encoder)
  }

  private computeSkinMatrices(encoder: GPUCommandEncoder) {
    const boneCount = this.currentModel!.getSkeleton().bones.length
    const workgroupCount = Math.ceil(boneCount / this.COMPUTE_WORKGROUP_SIZE)

    const pass = encoder.beginComputePass()
    pass.setPipeline(this.skinMatrixComputePipeline!)
    pass.setBindGroup(0, this.skinMatrixComputeBindGroup!)
    pass.dispatchWorkgroups(workgroupCount)
    pass.end()
  }

  private drawOutlines(pass: GPURenderPassEncoder, transparent: boolean) {
    pass.setPipeline(this.outlinePipeline)
    const draws = transparent ? this.transparentOutlineDraws : this.opaqueOutlineDraws
    for (const draw of draws) {
      pass.setBindGroup(0, draw.bindGroup)
      pass.drawIndexed(draw.count, 1, draw.firstIndex, 0, 0)
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
    this.stats.frameTime =
      Math.round((this.frameTimeSum / this.frameTimeCount) * Engine.STATS_FRAME_TIME_ROUNDING) /
      Engine.STATS_FRAME_TIME_ROUNDING

    // FPS tracking
    const now = performance.now()
    this.framesSinceLastUpdate++
    const elapsed = now - this.lastFpsUpdate

    if (elapsed >= Engine.STATS_FPS_UPDATE_INTERVAL_MS) {
      this.stats.fps = Math.round((this.framesSinceLastUpdate / elapsed) * Engine.STATS_FPS_UPDATE_INTERVAL_MS)
      this.framesSinceLastUpdate = 0
      this.lastFpsUpdate = now
    }
  }
}
