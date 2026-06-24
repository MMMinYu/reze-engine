# Tasks

- [x] Task 1: 确认 Blender 身体材质最终输出公式（emission 包装）
  - [x] SubTask 1.1: 查询 StarRailShader.身体变体_v17 组的 Group Output 输入链（Mix.001.Result）
  - [x] SubTask 1.2: 递归追溯 Mix.001 的 A/B 输入到所有叶节点（校色、ramp、noseShadow、texColor）
  - [x] SubTask 1.3: 确认 Color→Surface 隐式 Emission 包装：strength=1.0，color=组输出
  - [x] SubTask 1.4: 推导 Blender 最终公式：`emission_color = (校色(texColor) × ramp) × noseShadow`（无 ambient 加法项）

**Task 1 关键发现**：
1. **SUN 属性确实存在**（经几何节点修改器添加）：SUN Z-up = (0.296, -0.814, 0.5)，Y-up = (0.296, 0.500, -0.814)，与引擎 `-light.direction = (0.296, 0.500, -0.814)` **完全一致**
2. **虚拟日光的 Image 输入 = 固定 (0.8, 0.8, 0.8)**，green_smooth = smoothstep(0,0.2,0.8) = 1.0
3. **SDF.tex 的 UV = (0,0,0) 固定值**（身体组内 Group.010 输入 Vector=(0,0,0)），但引擎 body.ts 用 `input.uv` 采样 sdfTexture — **这是差异**
4. **Blender 最终公式无 ambient 加法项**：`emission_color = (校色 × ramp) × noseShadow`

- [x] Task 2: 节点级数值化对比（固定 UV + 固定 SUN）
  - [x] SubTask 2.1: 选定参考点 N=(0,0.707,0.707), V=(0,0,1), UV=(0.5,0.5), dot(N,SUN)=-0.22
  - [x] SubTask 2.2: texColor linear=(0.930,0.791,0.776) → corrected=(1.641,1.019,0.942) (HSV V×1.85 不clamp)
  - [x] SubTask 2.3: virtual_sun: half_lambert=0.278, step3=0.639, sunVal=0.408
  - [x] SubTask 2.4: ramp_lookup: sunMapped=0.493, ramp_color=(0.792,0.773,0.918), final_ramp=(0.353,0.330,0.599) (误差<0.006)
  - [x] SubTask 2.5: nose_shadow: **SDF.tex at UV=(0,0) = (0,0,0)** → noseShadow=1.0 (恒等于1，不影响)
  - [x] SubTask 2.6: **Blender emission_color=(0.580,0.336,0.564), 引擎=(0.662,0.387,0.611)，引擎比 Blender 亮 14%！**

**Task 2 关键发现**：
1. **引擎在该参考点比 Blender 亮**（与"整体偏暗"矛盾），说明偏暗根因不在 body 节点级公式
2. **SDF.tex 用固定 UV=(0,0) 采样 = (0,0,0)** → noseShadow 恒等于 1.0，引擎用动态 UV 是差异（但影响小）
3. **引擎 `+ ambient` 项使引擎比 Blender 亮** ~14%（在该参考点）
4. **ramp_lookup 21 点 LUT 误差 < 0.006**，可接受
5. **真正的偏暗根因可能在色调映射环节**（1D LUT vs EEVEE Next tonemapper）

- [x] Task 3: 重新评估 ambient 补偿项（分析在 Task 2 中完成）
  - [x] SubTask 3.1: Blender emission 公式无任何等效 ambient 项（Task 1 确认）
  - [x] SubTask 3.2: 引擎 `+ ambient` 来源于初版错误的 Cycles GI 假设（已推翻）
  - [x] SubTask 3.3: 正确处理方式 = **(a) 移除**（emission 不接收 ambient/GI）
  - [x] SubTask 3.4: 移除后材质输出降低 ~5-8%（ambient = 0.05 × corrected ≈ 0.03-0.08）

**Task 3 结论**：ambient 项完全多余，应移除。Blender emission_color = (校色 × ramp × noseShadow)，无加法项。

- [x] Task 4: 验证 brightnessScale 语义（分析在 Task 1/2 中完成）
  - [x] SubTask 4.1: Blender emission strength = 1.0（Color→Surface 隐式包装，Task 1 确认）
  - [x] SubTask 4.2: 引擎 `brightnessScale = sun.strength / 5.0`，sun.strength=5.0 → brightnessScale=1.0（no-op）
  - [x] SubTask 4.3: brightnessScale 当前 = 1.0，值正确但语义混乱（Blender 无 light strength 概念）

**Task 4 结论**：brightnessScale = 1.0 对结果无影响，但应移除以消除歧义。

- [x] Task 5: ramp 采样精确度验证（分析在 Task 2 中完成）
  - [x] SubTask 5.1: ramp 子组节点链已在 Task 2 逐环节计算中验证
  - [x] SubTask 5.2: second_factor = select(1.0, 0.0, alpha > 0.10) 二值逻辑确认（body alpha=0.0 → factor=1.0）
  - [x] SubTask 5.3: 21 点 LUT 误差 < 0.006（Task 2 SubTask 2.4 确认）
  - [x] SubTask 5.4: ramp 环节误差可忽略（< 0.006/通道）

**Task 5 结论**：ramp 采样精确度足够，无需修改。

- [x] Task 6: EEVEE Next 色调映射链路验证
  - [x] SubTask 6.1: 查询 Blender 5.0 OCIO config，确认 Filmic sRGB ViewTransform 结构
  - [x] SubTask 6.2: 确认 look=High Contrast 在 Filmic Log 空间应用 (filmic_to_0.99_1-0075.spi1d + inverse base)
  - [x] SubTask 6.3: **引擎 1D LUT 与 Blender OCIO 在低光/中间调显著不一致**
  - [x] SubTask 6.4: **量化差异：linear 0.05-0.5 范围引擎暗 0.08-0.17，是偏暗主要根因**
  - [x] SubTask 6.5: **生成正确的 256 点 LUT 数据**（已保存，用于 Task 7 修改清单）

**Task 6 关键发现（偏暗根因 #1 — 致命）**：
| linear | 正确LUT(Blender+HC) | 当前引擎LUT | 差异 |
|--------|---------------------|------------|------|
| 0.05 | 0.214 | 0.121 | -0.093 |
| 0.10 | 0.355 | 0.234 | -0.121 |
| 0.30 | 0.630 | 0.526 | -0.104 |
| 0.50 | 0.745 | 0.670 | -0.075 |
| 0.58 (emission_color) | 0.774 | 0.708 | -0.066 |
| 1.00 | 0.863 | 0.825 | -0.038 |

1. **引擎 1D LUT 在整个范围都比 Blender Filmic + HC 暗**，差异 0.02-0.12
2. **根因确认**：引擎 LUT 提取来源有误（可能未包含完整 look 链路，或从错误 .spi1d 提取）
3. **正确的 256 点 LUT 数据已生成**（见 Task 7 修改清单）

- [x] Task 7: 综合根因排序与新对齐方案
  - [x] SubTask 7.1: 汇总 Task 2-6 各环节误差，按影响大小排序
  - [x] SubTask 7.2: 设计新的精确对齐方案（替代已废弃的方案 C + 方案 E）
  - [x] SubTask 7.3: 列出具体修改清单（文件、行号、旧值、新值、理由）
  - [x] SubTask 7.4: 量化预期效果

**Task 7 综合分析结果**：

### 根因排序（按影响大小）

| 排名 | 根因 | 影响范围 | 误差量级 | 来源 |
|------|------|---------|---------|------|
| **#1 致命** | composite.ts 1D LUT 缺少 High Contrast look | 全局，所有亮度 | 0.02–0.12 | Task 6 |
| **#2 中等** | sr_* 材质多余 `+ ambient` 项 | 材质输出偏亮 ~14% | 0.03–0.08 | Task 2/3 |
| **#3 轻微** | `brightnessScale` 语义混乱（值=1.0，no-op） | 无实际影响 | 0 | Task 4 |
| **#4 可忽略** | ramp 21 点 LUT 精度 | 单通道 < 0.006 | < 0.006 | Task 5 |
| **#5 可忽略** | SDF.tex UV 差异 | noseShadow ≈ 1.0 | ~0 | Task 2 |

### 新对齐方案：LUT-Fix + Ambient-Remove

**替代已废弃的方案 C（乘法增益 1.9375x）+ 方案 E（3D LUT）**

核心思路：
1. **LUT-Fix**：替换 composite.ts 的 256 点 LUT 为从 Blender 5.0 OCIO 完整链路提取的正确数据（含 HC look）
2. **Ambient-Remove**：移除 5 个材质中的 `+ ambient` 项和 `brightnessScale`

### 修改清单

#### 修改 1: composite.ts — 替换 256 点 LUT（根因 #1）

**文件**: [composite.ts](file:///e:/reze-engine/engine/src/shaders/passes/composite.ts) lines 34–51

**旧值**（当前 LUT，缺少 HC look，整体偏暗）:
```
0.000000, 0.000050, 0.000108, ...（共 256 值）
```

**新值**（从 Blender 5.0 OCIO 完整链路提取，含 HC look）:
```
0.004462, 0.004671, 0.004888, 0.005113, 0.005346, 0.005589, 0.005840, 0.006101,
0.006372, 0.006653, 0.006945, 0.007248, 0.007562, 0.007889, 0.008227, 0.008578,
0.008943, 0.009321, 0.009713, 0.010121, 0.010543, 0.010981, 0.011436, 0.011908,
0.012398, 0.012905, 0.013432, 0.013979, 0.014545, 0.015133, 0.015743, 0.016376,
0.017032, 0.017712, 0.018417, 0.019149, 0.019907, 0.020694, 0.021509, 0.022354,
0.023231, 0.024140, 0.025081, 0.026057, 0.027068, 0.028117, 0.029203, 0.030328,
0.031494, 0.032703, 0.033954, 0.035251, 0.036593, 0.037983, 0.039423, 0.040914,
0.042457, 0.044055, 0.045709, 0.047420, 0.049192, 0.051024, 0.052920, 0.054880,
0.056908, 0.059006, 0.061175, 0.063417, 0.065735, 0.068130, 0.070604, 0.073160,
0.075800, 0.078528, 0.081343, 0.084249, 0.087249, 0.090345, 0.093539, 0.096832,
0.100228, 0.103728, 0.107336, 0.111053, 0.114883, 0.118827, 0.122888, 0.127068,
0.131367, 0.135788, 0.140334, 0.145010, 0.149812, 0.154745, 0.159812, 0.165013,
0.170349, 0.175822, 0.181432, 0.187182, 0.193072, 0.199104, 0.205278, 0.211595,
0.218056, 0.224659, 0.231404, 0.238290, 0.245318, 0.252490, 0.259801, 0.267250,
0.274839, 0.282564, 0.290422, 0.298411, 0.306529, 0.314772, 0.323138, 0.331624,
0.340227, 0.348943, 0.357767, 0.366695, 0.375721, 0.384839, 0.394045, 0.403336,
0.412705, 0.422144, 0.431650, 0.441217, 0.450836, 0.460500, 0.470204, 0.479939,
0.489699, 0.499479, 0.509252, 0.519030, 0.528806, 0.538572, 0.548321, 0.558043,
0.567733, 0.577387, 0.586999, 0.596555, 0.606056, 0.615493, 0.624859, 0.634148,
0.643353, 0.652469, 0.661491, 0.670414, 0.679234, 0.687946, 0.696545, 0.705028,
0.713389, 0.721624, 0.729730, 0.737704, 0.745550, 0.753253, 0.760820, 0.768248,
0.775534, 0.782675, 0.789671, 0.796521, 0.803223, 0.809779, 0.816189, 0.822451,
0.828567, 0.834537, 0.840361, 0.846038, 0.851571, 0.856960, 0.862210, 0.867317,
0.872285, 0.877117, 0.881814, 0.886376, 0.890806, 0.895106, 0.899278, 0.903324,
0.907248, 0.911050, 0.914734, 0.918301, 0.921755, 0.925095, 0.928327, 0.931451,
0.934471, 0.937389, 0.940208, 0.942929, 0.945556, 0.948091, 0.950535, 0.952891,
0.955162, 0.957349, 0.959456, 0.961485, 0.963437, 0.965315, 0.967121, 0.968857,
0.970524, 0.972126, 0.973664, 0.975140, 0.976555, 0.977913, 0.979214, 0.980461,
0.981654, 0.982796, 0.983888, 0.984933, 0.985930, 0.986883, 0.987792, 0.988659,
0.989486, 0.990273, 0.991022, 0.991734, 0.992410, 0.993053, 0.993662, 0.994239,
0.994785, 0.995301, 0.995789, 0.996248, 0.996681, 0.997088, 0.997470, 0.997827,
0.998161, 0.998473, 0.998763, 0.999033, 0.999282, 0.999511, 0.999722, 0.999915,
```

**理由**: 当前 LUT 提取时遗漏了 High Contrast look 链路（OCIO 2.4 的 `DisplayViewTransform` 无 `setLooks` 方法）。正确数据通过手动构建 5 步 GroupTransform 链生成：scene_linear → Filmic Log → HC look (filmic_to_0.99_1-0075.spi1d ∘ inverse(filmic_to_0-70_1-03.spi1d)) → scene_linear → sRGB display。

**同步更新注释**（line 30-32）:
```wgsl
// OCIO Filmic + High Contrast 256-point LUT (extracted from Blender 5.0 via OCIO 2.4 API).
// Pipeline: scene_linear → reference → Filmic Log → look(HC) → reference → Filmic view → sRGB display.
// Index maps log2(linear) from [-10, 4] → [0, 255] (14 stops).
```

#### 修改 2-8: sr_* 材质 — 移除 ambient + brightnessScale（根因 #2 + #3）

**⚠️ 复检补充（2026-06-24）**：初版方案遗漏了 3 个材质（special.ts / eye.ts / stocking.ts），现已补全。

**类型 A：emission 模型 — 移除 `+ ambient` + `brightnessScale`**（7 处）

```wgsl
// 旧值
let ambient = light.ambientColor.xyz * corrected;
let brightnessScale = light.lights[0].color.w / 5.0;
out.color = vec4f((finalColor + ambient) * brightnessScale, alpha);
// 新值
out.color = vec4f(finalColor, alpha);
```

| # | 文件 | 修改行号 | finalColor 变量 |
|---|------|---------|----------------|
| 2 | [body.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/body.ts) | 54–62 | `withShadow` |
| 3 | [clothes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/clothes.ts) (outer) | 74–81 | `base * specScaled` |
| 4 | [clothes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/clothes.ts) (inner) | 142–149 | `base * specScaled` |
| 5 | [face.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/face.ts) | 47–58 | `withShadow` |
| 6 | [hair.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/hair.ts) | 120–135 | `emissionColor`（含 DEBUG_MODE switch） |
| **7** | **[special.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/special.ts)**（袖球） | **137–145** | `base * specScaled` |
| **8** | **[eye.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/eye.ts)**（眼部） | **89–96** | `corrected` |

**hair.ts 特殊处理**: DEBUG_MODE 分支（case 1-8）中的 `brightnessScale` 也需移除，debug 输出直接用原色。

**理由**: emission 材质不接收 ambient/GI（PBR 定义）。Blender emission_color = (校色 × ramp × noseShadow)，无加法项、无外部乘数。

**类型 B：Principled BSDF 模型 — 仅移除 `brightnessScale`**（1 处）

| # | 文件 | 修改行号 | 说明 |
|---|------|---------|------|
| **9** | **[stocking.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts)**（丝袜） | **481–482** | 仅移除 `brightnessScale`（=1.0 no-op）。**保留** `amb`（line 329），因 Principled BSDF 的 `eval_principled()` 需要 ambient 光照输入 |

```wgsl
// stocking.ts 旧值 (line 481-482)
let brightnessScale = light.lights[0].color.w / 5.0;
out.color = vec4f(finalColor * brightnessScale, alpha);
// 新值
out.color = vec4f(finalColor, alpha);
```

**无需修改的 sr_* 材质**（已确认无 ambient/brightnessScale）：
- eyeshadow.ts — 纯色半透明，`out.color = vec4f(shadowColor, alpha)`
- edge.ts — 描边，`out.color = vec4f(edgeColor, srMaterial.alpha)`
- mmd.ts — 用自己的 `ambient = vec3f(0.15)` 常量，不用 `light.ambientColor`

### Gamma 链路验证（无双重 gamma 问题）

**结论**：gamma=1.0 时引擎使用 `compositePipelineIdentity`（APPLY_GAMMA=false），跳过 `pow(disp, invGamma)`。因此 LUT 数据包含 sRGB OETF 是正确的——filmic() 直接输出 sRGB 编码值，无需额外 gamma 处理。

```typescript
// engine.ts line 4297-4298
const compositePipeline =
  this.viewTransform.gamma === 1.0 ? this.compositePipelineIdentity : this.compositePipelineGamma
```

当前 gamma=1.0（[page.tsx:459](file:///e:/reze-engine/web/app/page.tsx#L459)），使用 identity pipeline，LUT 含 OETF = 正确行为。

### 预期效果量化

以参考点 N=(0,0.707,0.707) emission_color R 通道为例：

| 环节 | 当前引擎 | 修复后 | Blender |
|------|---------|--------|---------|
| 材质输出 | 0.662 (+ ambient) | 0.580 (无 ambient) | 0.580 |
| tonemap | 0.708 (错误 LUT) | 0.774 (正确 LUT) | 0.774 |
| **最终显示** | **0.708** | **0.774** | **0.774** |
| 与 Blender 差异 | -9.2% | **0%** | — |

全局亮度变化（tonemap 环节）：

| linear 输入 | 当前显示 | 修复后显示 | 变化 |
|------------|---------|-----------|------|
| 0.05 | 0.121 | 0.214 | +77% |
| 0.10 | 0.234 | 0.355 | +52% |
| 0.30 | 0.526 | 0.630 | +20% |
| 0.50 | 0.670 | 0.745 | +11% |
| 1.00 | 0.825 | 0.863 | +5% |

**结论**：修复后引擎在材质输出和色调映射两个环节都与 Blender 精确对齐。低光区提亮显著（+50-77%），中间调适度提亮（+11-20%），高光区微调（+5%）。

- [x] Task 8: 更新文档
  - [x] SubTask 8.1: 在 docs/lighting-audit-debug.md 中追加新分析结果
  - [x] SubTask 8.2: 在 project_memory.md 中更新过时约束
  - [x] SubTask 8.3: 在 audit-lighting-brightness-alignment/spec.md 顶部标注 OBSOLETE

# Task Dependencies
- Task 2 依赖 Task 1（需要先知道最终公式才能逐环节计算）
- Task 3, 4, 5, 6 可并行（独立验证不同环节）
- Task 7 依赖 Task 2-6 全部完成
- Task 8 依赖 Task 7
