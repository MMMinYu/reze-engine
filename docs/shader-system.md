# 着色器系统文档

## 概述

Reze Engine 的着色器系统使用 WGSL (WebGPU Shading Language) 字符串拼接架构。每个材质/Pass 是一个独立的 TypeScript 模块，导出 WGSL 字符串常量，在运行时拼接为完整的着色器模块。

## 文件结构

```
shaders/
├── materials/           # 材质预设着色器
│   ├── nodes.ts         # 共享 WGSL 原语（BSDF、HSV、噪声、采样器）
│   ├── common.ts        # 统一变量、绑定声明、蒙皮 VS、PCF 阴影
│   ├── default.ts       # Principled BSDF 基准
│   ├── face.ts          # 脸部 NPR
│   ├── hair.ts          # 头发 NPR
│   ├── body.ts          # 身体 NPR
│   ├── eye.ts           # 眼睛
│   ├── stockings.ts     # 丝袜 (alpha-hashed)
│   ├── metal.ts         # 金属
│   ├── cloth_smooth.ts  # 光滑布料
│   ├── cloth_rough.ts   # 粗糙布料
│   └── starrail/        # StarRail NPR 预设族（多贴图绑定）
│       ├── starrail_nodes.ts   # 共享 NPR 函数（SDF/matcap/ramp/ILM 等）
│       ├── bindings.ts         # StarRail 专用 group(2) bind group layout
│       ├── starrail_prelude.ts # WGSL 拼接 prelude（替代 COMMON_MATERIAL_PRELUDE）
│       ├── face.ts             # sr_face（SDF 脸部阴影）
│       ├── hair.ts             # sr_hair
│       ├── body.ts             # sr_body
│       ├── clothes.ts          # sr_clothes
│       └── eye.ts              # sr_eye
├── passes/              # 后处理 & 工具 Pass
│   ├── shadow.ts        # 阴影深度
│   ├── ground.ts        # 地面阴影
│   ├── outline.ts       # 轮廓线
│   ├── bloom.ts         # Bloom (blit/down/up)
│   ├── composite.ts     # 色调映射 + gamma
│   ├── pick.ts          # GPU 拾取
│   ├── selection.ts     # 选中高亮 (mask + edge)
│   ├── gizmo.ts         # 变换 Gizmo
│   └── mipmap.ts        # 纹理 mipmap 生成
├── dfg_lut.ts           # BRDF DFG LUT 烘焙着色器
└── ltc_mag_lut.ts       # LTC 幅度 LUT 数据
```

## 拼接架构

### 材质着色器拼接顺序

每个材质管线的 WGSL 模块按以下顺序拼接：

```
1. NODES_WGSL              (nodes.ts — 数学/噪声/BSDF 辅助函数)
2. COMMON_BINDINGS_WGSL    (common.ts — 统一变量结构体 + @group/@binding 声明)
3. SAMPLE_SHADOW_WGSL      (common.ts — 3×3 PCF 阴影采样)
4. COMMON_VS_WGSL          (common.ts — 蒙皮顶点着色器)
5. <材质特有代码>           (各材质文件 — 常量 + @fragment fn fs)
```

WGSL 是整模块编译，模块级声明的顺序不影响编译，但可读性顺序为：类型 → 绑定 → 辅助 → 入口点。

### 为什么用字符串拼接

- WGSL 不支持 `#include` 或模块导入
- 共享代码（BSDF、阴影采样、蒙皮）只需维护一份
- 每个材质文件只包含使其视觉上独特的代码

## 共享模块详解

### nodes.ts — 共享 WGSL 原语

提供所有材质共享的辅助函数：

| 函数 | 用途 |
|------|------|
| `rgb_to_hsv` / `hsv_to_rgb` | 颜色空间转换 |
| `brdf_lut_sample` | 采样 BRDF DFG LUT |
| `F_brdf_schlick` | Schlick Fresnel 近似 |
| `eval_principled` | Principled BSDF 评估（GGX 微面元） |
| `fresnel_dielectric` | 电介质 Fresnel |
| `fwidth_aa` | 抗锯齿辅助 |
| `value_noise` / `voronoi_3d` | 程序化噪声 |
| `ltc_brdf_scale_from_lut` | LTC 直接镜面缩放 |

**PBR 核心** (`eval_principled`):
- GGX 微面元 + Schlick Fresnel
- Walter-Smith G1 遮挡函数
- Fdez-Agüera 2019 多次散射补偿
- Karis 2013 split-sum DFG LUT
- Heitz 2016 LTC 直接镜面缩放
- 可选 sheen

### common.ts — 统一变量与绑定

#### 统一变量结构体

```wgsl
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
  diffuseColor: vec3f,
  alpha: f32,
};

struct LightVP { viewProj: mat4x4f, };
```

#### Bind Group 声明

```wgsl
@group(0) @binding(0) var<uniform> camera: CameraUniforms;
@group(0) @binding(1) var<uniform> light: LightUniforms;
@group(0) @binding(2) var diffuseSampler: sampler;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowComparisonSampler: sampler_comparison;
@group(0) @binding(5) var<uniform> shadowLightVP: LightVP;
@group(0) @binding(6) var materialSampler: sampler;
@group(0) @binding(7) var fallbackTexture: texture_2d<f32>;
@group(0) @binding(8) var brdfLut: texture_2d<f32>;  // common.ts 声明
@group(0) @binding(9) var brdfLut: texture_2d<f32>;  // nodes.ts 声明（同一纹理）
@group(1) @binding(0) var<storage, read> skinMatrices: array<mat4x4f>;
@group(1) @binding(1) var<storage, read> joints: array<u32>;
@group(1) @binding(2) var<storage, read> weights: array<u32>;
@group(2) @binding(0) var diffuseTexture: texture_2d<f32>;
@group(2) @binding(1) var<uniform> material: MaterialUniforms;
```

#### 顶点着色器

`COMMON_VS_WGSL` 包含标准的蒙皮顶点着色器：
- 读取 4 个骨骼权重和关节索引
- 累积加权骨骼矩阵变换
- 输出 position、normal、uv、worldPos

#### 阴影采样

`SAMPLE_SHADOW_WGSL` 实现 3×3 PCF 阴影采样：
- 使用 `sampler_comparison` 硬件 PCF
- 9 次采样取平均
- 应用 normal bias + depth bias

## 材质着色器 7 阶段布局

每个片元着色器遵循统一的 7 阶段布局：

```
(A) Fragment setup    — 读取 VS 输出，初始化变量
(B) Texture + alpha   — 采样漫反射纹理，处理 alpha
(C) NPR stack         — Toon ramp、rim、HSV 重映射等（NPR 预设独有）
(D) Optional bump     — Noise bump / Voronoi bump（部分预设）
(E) Principled BSDF   — eval_principled() PBR 评估
(F) NPR ↔ PBR mix    — 混合 NPR 和 PBR 结果
(G) FSOut             — 输出结构体
```

`default` 预设只使用 A/B/E/G；NPR 预设在 E 之前叠加 C（有时还有 D），F 控制最终混合比例。

## 各材质预设详解

### default — Principled BSDF

纯 PBR，metallic=0, rough=0.5。阶段：A → B → E → G。

### face — 脸部 NPR

- **C 阶段**: Toon ramp + 暖色 rim + 双 fresnel rim + 亮度纹理门控
- **D 阶段**: Value noise bump（微妙表面细节）
- **F 阶段**: NPR 为主，PBR 贡献极低

亮度纹理门控：只在高亮度区域显示 rim，避免阴影中出现过亮的边缘光。

### hair — 头发 NPR

- **C 阶段**: Toon ramp + fresnel rim + bevel（模拟发丝圆柱体光照）
- **F 阶段**: 20% PBR 混合（保留一些金属感高光）

### body — 身体 NPR

- **C 阶段**: Toon ramp + 暖色 rim + fresnel + facing rim
- **D 阶段**: Value noise bump

### eye — 眼睛

- 纯 Principled BSDF + 后评估发光 ×1.5
- 不使用 NPR 栈

### stockings — 丝袜

- **Alpha-hashed 透明**: Wyman & McGuire 2017 导数感知随机 discard
- **C 阶段**: 梯度 × facing mask + HSV 发光 ×5
- **Sheen**: 0.7（模拟织物表面散射）
- 世界空间哈希避免 dither 随相机游动

### metal — 金属

- **C 阶段**: Toon + 发光叠加 ×8
- **D 阶段**: 3D Voronoi 闪光（金属颗粒感）
- metallic=1

### cloth_smooth — 光滑布料

- **C 阶段**: Toon + bevel + 发光叠加 ×18

### cloth_rough — 粗糙布料

- 同 cloth_smooth NPR 栈
- **D 阶段**: Live noise bump
- rough=0.82

## StarRail NPR 预设族（sr_face / sr_hair / sr_body / sr_clothes / sr_eye）

复现崩坏：星穹铁道风格 NPR Shader（社区 StarRailShader by 小二今天吃啥啊）的 5 个材质预设。与现有 9 个预设的核心区别：

### 多贴图绑定

StarRail 材质使用**独立的 group(2) bind group layout**（`srPerMaterialBindGroupLayout`），每材质可绑定最多 6 张贴图：

| 槽位 | 用途 | binding |
|------|------|---------|
| colorTexture | 基础颜色贴图 | 0 |
| srMaterial | StarRailMaterialUniforms（144 字节） | 1 |
| ilmTexture | ILM LightMap（R=AO, G=高光mask, B=阴影阈值, A=区域mask） | 2 |
| rampTexture | Toon 色阶 LUT | 3 |
| sdfTexture | SDF 脸部 FaceMap（仅 sr_face） | 4 |
| matcapTexture | matcap 球面贴图 | 5 |
| srSampler | 共用 sampler | 6 |

### WGSL 拼接

StarRail 材质不用 `COMMON_MATERIAL_PRELUDE_WGSL`（其 group(2) 与 StarRail 冲突），而用 `STARRAIL_PRELUDE_WGSL`（`starrail_prelude.ts`），拼接顺序：
```
NODES_WGSL + COMMON_BINDINGS_GROUP01_WGSL + STARRAIL_BINDINGS_WGSL
+ SAMPLE_SHADOW_WGSL + COMMON_VS_WGSL + COMMON_FS_OUT_WGSL + STARRAIL_NODES_WGSL
```

### 核心技术

- **SDF 脸部阴影**（sr_face）：预计算的 SDF FaceMap 存储阴影轮廓，用 `dot(faceRight, sun) > 0` 判断灯光在脸的左右半，据此镜像 UV.x 采样；最终阈值动态化 `dot(faceFront, sun)*0.5+0.5`，并带 backface guard
- **Toon ramp**：1D LUT 色阶采样，alpha 经 7 档阈值映射到 ramp 贴图的 V 行号；实际采样 Warm Ramp（不是 Cool）
- **matcap**：世界法线转视图空间后采样球面贴图；MetalMap 是 Non-Color，hair_s 是 sRGB，加载方式不同
- **ILM 控制贴图**：Non-Color 数据贴图，R=AO / G=specular mask / B=shadow threshold / A=material region
- **Blinn-Phong 高光**：受 ILM G 通道 mask 控制
- **虚拟日光**：半兰伯特 + ILM G 通道门控 + **平方**（`^2.0`，不是 gamma/开方）

### 资源导出

使用 `tools/blender-exporters/starrail_exporter.py` 从 Blender `.blend` 文件导出 PMX 模型 + 贴图 + `manifest.json`。详见 [StarRail 移植参考](starrail-shader-reference.md)。

## LUT 纹理

### BRDF DFG LUT

- **尺寸**: 64×64 `rgba8unorm`
- **内容**: .rg = split-sum DFG (Karis), .ba = Heitz 2016 LTC 幅度
- **生成**: `dfg_lut.ts` 在引擎初始化时用 compute shader 烘焙
- **采样**: 每片元一次 `brdf_lut_sample()`，同时获取 DFG 和 LTC 数据

### LTC 幅度 LUT

- **尺寸**: 64×64
- **数据**: `ltc_mag_lut.ts` 中的硬编码 Float32Array
- **用途**: Heitz 2016 LTC 直接镜面缩放

## 后处理着色器

### Bloom (bloom.ts)

三个管线：
1. **Blit** — HDR → 半分辨率，4-tap Karis 平均 + soft threshold/knee
2. **Downsample** — 13-tap Jimenez/COD box filter，5 组平均
3. **Upsample** — 9-tap tent 上采样，与 downsample mip 加法混合

### Composite (composite.ts)

两个管线变体（通过 WGSL pipeline-override constants）：
- `GAMMA_IDENTITY = 1` — 跳过 pow（gamma = 1.0 时）
- `GAMMA_IDENTITY = 0` — 执行 pow

处理流程：Bloom 叠加 → 曝光 → Filmic 色调映射 → Gamma → 输出

### Outline (outline.ts)

倒 hull 法：沿法线外扩顶点，正面剔除，只渲染背面轮廓。

### Pick (pick.ts)

每像素编码 `rgba32uint`：
- R = 模型索引
- G = 材质索引
- B = 骨骼索引（主导关节）

### Selection (selection.ts)

两个管线：
1. **Mask** — 将选中材质像素写入 r8unorm
2. **Edge** — 对 mask 做边缘检测，渲染橙色高亮轮廓

### Gizmo (gizmo.ts)

3 个旋转环 + 3 个平移轴，使用屏幕空间固定尺寸（世界空间大小随距离缩放）。

## 添加新材质预设的步骤

### 标准预设（单贴图，使用 COMMON_MATERIAL_PRELUDE_WGSL）

1. 在 `shaders/materials/` 新建 `my_preset.ts`
2. 导出 `MY_PRESET_SHADER_WGSL` 字符串，遵循 7 阶段布局
3. 在 `engine.ts` 中：
   - 添加 `import { MY_PRESET_SHADER_WGSL } from "./shaders/materials/my_preset"`
   - 在 `MaterialPreset` 联合类型添加 `"my_preset"`
   - 在 `init()` 中创建 `myPresetPipeline`（使用 `mainPipelineLayout`）
   - 在 `pipelineForPreset()` 添加 case
4. 在 `setMaterialPresets()` 的映射中使用新预设名

### StarRail 类预设（多贴图，使用 STARRAIL_PRELUDE_WGSL）

如果新预设需要每材质多张贴图（如 ILM/ramp/matcap），参考 `shaders/materials/starrail/` 的架构：
1. 在 `shaders/materials/starrail/` 新建材质文件，用 `STARRAIL_PRELUDE_WGSL` 拼接
2. 复用 `STARRAIL_BINDINGS_WGSL` 的 group(2) layout（或扩展新的）
3. 在 `engine.ts` 中用 `srPipelineLayout`（而非 `mainPipelineLayout`）创建 pipeline
4. 在 `setupMaterialsForInstance` 的 `isStarRail` 分支中处理新预设
