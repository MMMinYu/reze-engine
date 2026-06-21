# 渲染管线文档

## 概述

Reze Engine 使用 WebGPU 实现完整的 HDR 渲染管线，专为动漫/MMD 风格角色设计。管线结合了 NPR（非真实感渲染）和 PBR（基于物理的渲染）的混合方案。

## 管线配置

### MSAA 与 HDR 格式

- **MSAA**: 4× 多重采样
- **HDR 格式优先**: `rg11b10ufloat`（4 bytes/texel，Apple TBDR tile 友好）
- **HDR 格式回退**: `rgba16float`（8 bytes/texel，兼容性保底）
- **辅助 MRT**: `rg8unorm`（bloom mask + accumulated alpha）

选择 `rg11b10ufloat` 的原因：Apple Silicon 的 TBDR 架构下，`rgba16float` + 4× MSAA = 32 bytes/texel，超出 tile 内存容量，导致每帧 ~300MB 系统内存往返。`rg11b10ufloat` + 4× MSAA = 16 bytes/texel，可在 tile 内完成 MSAA resolve。

### 纹理尺寸

| 纹理 | 尺寸 | 格式 |
|------|------|------|
| 阴影贴图 | 2048×2048 | `depth32float` |
| MSAA 颜色 | canvas 尺寸 × DPR | `rg11b10ufloat` / `rgba16float` |
| MSAA 深度 | canvas 尺寸 × DPR | `depth24plus-stencil8` |
| MSAA 辅助 | canvas 尺寸 × DPR | `rg8unorm` |
| HDR Resolve | canvas 尺寸 × DPR | 同 HDR 格式 |
| Bloom Down/Up | 半分辨率 mip 金字塔 | `rgba16float` |
| Pick | canvas 尺寸 | `rgba32uint` |
| Selection Mask | canvas 尺寸 | `r8unorm` |

## 渲染 Pass 序列

每帧按以下顺序执行：

### 1. Shadow Depth Pass

- **管线**: `shadowDepthPipeline`
- **输出**: `shadowMapTexture` (depth32float)
- **绘制**: 所有模型的阴影 DrawCall（opaque + transparent 均投射阴影）
- **光源 VP**: 从 `sun.direction` 计算正交投影，覆盖场景包围盒
- **偏移**: normal bias + depth bias 防止 shadow acne

### 2. Main Color Pass

- **输出**: MSAA 颜色 + MSAA 辅助 (MRT)
- **深度/模板**: `depth24plus-stencil8`
- **绘制顺序**:
  1. **Opaque** — 不透明材质，按材质预设分派到对应管线
  2. **Transparent** — 透明材质，alpha < 1
  3. **Hair-over-eyes** — 头发覆盖眼睛的特殊 pass（stencil 门控）
  4. **Stockings** — 丝袜材质（alpha-hashed 透明）
  5. **Ground** — 地面阴影接收面

**Stencil 约定**:
- 眼睛绘制时 stamp `STENCIL_EYE_VALUE = 1`
- 主头发 pass 跳过 stencil = 1 的像素
- `hairOverEyesPipeline` 匹配 stencil = 1，以 25% alpha 混合

### 3. MSAA Resolve

- 颜色 resolve 到 `hdrResolveTexture`
- 辅助 resolve 到 `maskResolveTexture`

### 4. Selection Mask Pass（条件执行）

- 当 `selectedMaterial` 非空时执行
- 将选中材质的像素写入 `selectionMaskTexture` (r8unorm)

### 5. Bloom 金字塔

EEVEE 风格 Bloom，镜像 Blender 3.6 的 `effect_bloom_frag.glsl`：

```
Blit (HDR → 半分辨率)
  → 4-tap Karis 平均 + soft threshold/knee
  → 输出到 bloomDown mip 0

Downsample × (N-1)
  → 13-tap Jimenez/COD box filter，5 组平均
  → 逐级半分辨率

Upsample × (N-1)
  → 9-tap tent 上采样
  → 与对应 downsample mip 加法混合

最终: bloomUp mip 0 × (color × intensity) 在 composite 中叠加
```

- **最大级数**: `BLOOM_MAX_LEVELS = 5`
- **Bloom mask**: 辅助 MRT 的 .r 通道门控（模型 = 1，地面 = 0）
- **阈值/膝部**: 可通过 `setBloomOptions()` 运行时调整

### 6. Composite Pass

- **输入**: HDR resolve + bloom up mip 0 + mask resolve
- **色调映射**: Filmic（从 Blender 3.6 OCIO "Filmic / Medium High Contrast" 提取的 LUT）
- **曝光**: `linear *= 2^exposure`
- **Gamma**: `pow(rgb, 1/gamma)`
- **两个管线变体**:
  - `compositePipelineIdentity` — gamma = 1.0 时跳过 pow（Safari Metal 不优化 pow(x,1)）
  - `compositePipelineGamma` — gamma ≠ 1.0 时使用 pow
- **输出**: canvas 可绘制纹理

### 7. Outline Pass

- **管线**: `outlinePipeline`
- **技术**: 倒 hull 法（沿法线外扩顶点，正面剔除）
- **绘制**: 不透明 + 透明材质的轮廓线

### 8. Selection Edge Pass（条件执行）

- **输入**: selection mask texture
- **输出**: 屏幕空间橙色选中高亮轮廓
- **管线**: `selectionEdgePipeline` — 边缘检测 + 颜色叠加

### 9. Gizmo Pass（条件执行）

- **条件**: `selectedBone` 非空
- **绘制**: 3 个旋转环 + 3 个平移轴
- **参数**: `GIZMO_RING_SEGMENTS = 96`, `GIZMO_RING_RADIUS = 0.8`, `GIZMO_AXIS_LENGTH = 1.25`
- **屏幕尺寸**: `GIZMO_WORLD_SIZE = 1.5`, `GIZMO_THICKNESS_PX = 15.0`
- **交互**: 拖拽时锁定相机，鼠标事件路由到 Gizmo 处理器

### 10. Pick Pass（条件执行）

- **条件**: `pendingPick` 非空（双击/双触时设置）
- **管线**: `pickPipeline` — 每像素编码 model index + material index + bone index
- **格式**: `rgba32uint`
- **回读**: 通过 `pickReadbackBuffer` 异步映射读取

## 材质预设与管线分派

每个 DrawCall 根据材质预设分派到对应的渲染管线：

| 预设 | 管线字段 | 渲染特性 |
|------|---------|---------|
| `default` | `modelPipeline` | Principled BSDF, metallic=0, rough=0.5 |
| `face` | `facePipeline` | Toon + 暖色 rim + 双 fresnel rim + 亮度门控 + noise bump |
| `hair` | `hairPipeline` | Toon + fresnel + bevel + 亮度门控, 20% PBR 混合 |
| `body` | `bodyPipeline` | Toon + 暖色 rim + fresnel + facing rim + noise bump |
| `eye` | `eyePipeline` | Principled + 发光 ×1.5 |
| `stockings` | `stockingsPipeline` | 梯度 × facing mask + HSV 发光 ×5, sheen=0.7, alpha-hashed |
| `metal` | `metalPipeline` | Toon + 发光 ×8, Voronoi 闪光, metallic=1 |
| `cloth_smooth` | `clothSmoothPipeline` | Toon + bevel + 发光 ×18 |
| `cloth_rough` | `clothRoughPipeline` | 同 cloth_smooth + noise bump, rough=0.82 |

### DrawCall 创建

在 `createDrawCalls()` 中，每个 PMX 材质生成一个 DrawCall：
- 按 `resolvePreset(materialName, materialPresets)` 确定预设
- 按 alpha 值分为 opaque / transparent
- 特殊处理：eye 材质设置 stencil stamp，stockings 使用 alpha-hashed 管线

## 阴影系统

- **类型**: 方向光阴影（正交投影）
- **分辨率**: 2048×2048
- **过滤**: PCF（3×3 采样）
- **光源 VP**: 从 `sun.direction` 计算，与着色器中的光照方向一致
- **偏移**: normal bias + depth bias
- **地面接收**: `groundShadowPipeline` 使用阴影贴图在地面平面上渲染阴影

## Alpha-Hashed 透明

仅用于 `stockings` 预设，基于 Wyman & McGuire 2017：
- 世界空间哈希 + 导数感知随机 discard
- 保持不透明风格的深度写入
- MSAA 下 dither 不会随相机游动
- 解决自重叠透明网格（如丝袜）的排序问题

## See-Through Hair Over Eyes

MMD 的 post-alpha-eye 技术：
1. 眼睛 pass stamp stencil = 1
2. 主头发 pass 跳过 stencil = 1 的像素
3. 额外 `hairOverEyesPipeline` 匹配 stencil = 1，以 25% alpha 在线性 HDR 空间混合
4. 轮廓线 pass 也跳过 stencil stamp，保持虹膜可读性

## Bind Group 布局

所有材质管线共享相同的 bind group 布局：

| Group | Binding | 内容 | 频率 |
|-------|---------|------|------|
| 0 | 0 | Camera uniforms (view, projection, viewPos) | per-frame |
| 0 | 1 | Light uniforms (ambient, directional) | per-frame |
| 0 | 2 | diffuseSampler | per-frame |
| 0 | 3 | shadowMap | per-frame |
| 0 | 4 | shadowComparisonSampler | per-frame |
| 0 | 5 | shadowLightVP | per-frame |
| 0 | 6 | materialSampler | per-frame |
| 0 | 7 | fallbackMaterialTexture | per-frame |
| 0 | 8 | brdfLut | per-frame |
| 0 | 9 | brdfLut (nodes.ts 声明) | per-frame |
| 1 | 0 | skinMatrixBuffer | per-model |
| 1 | 1 | jointsBuffer | per-model |
| 1 | 2 | weightsBuffer | per-model |
| 2 | 0 | diffuseTexture | per-material |
| 2 | 1 | materialUniforms | per-material |

## 运行时配置

```typescript
// 光照
engine.setWorld({ color?, strength? })
engine.setSun({ color?, strength?, direction? })

// Bloom
engine.setBloomOptions({ threshold?, knee?, radius?, color?, intensity?, clamp? })

// 视图变换
engine.setViewTransform({ exposure?, gamma?, look? })
```
