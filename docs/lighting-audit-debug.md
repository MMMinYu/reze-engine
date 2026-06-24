# 引擎光照与 Blender 逐节点对齐审计报告

> 审计日期：2026-06-23（初版），2026-06-24（MCP 复核重大修正）
> 审计范围：Body / Clothes / Face / Hair 四个核心材质 + 后处理链路
> 审计方法：MCP 连接 Blender 逐节点查询 + 引擎 WGSL 代码逐行对比

## ⚠️ 重大修正（2026-06-24 MCP 复核）

经 MCP 再次连接 Blender（Blender 5.0.0）逐项复核，发现初版审计存在多处错误：

| 初版错误结论 | MCP 复核正确事实 |
|-------------|----------------|
| 渲染引擎 = Cycles (samples=1, max_bounces=12, diffuse_bounces=4) | **渲染引擎 = EEVEE Next**：taa_render_samples=64, use_fast_gi=True, gi_diffuse_bounces=3, use_raytracing=False |
| 两个 SunLight energy=0.0 | **场景无任何 Light 对象**（0 个），连 energy=0 的都没有 |
| Cycles 间接光照提供 ~1.9375x 增益 | **emission 材质不接收 GI bounce**（PBR 定义：emission 只发光不收光） |
| 方案 C：乘法增益 1.9375x | **错误方案**：基于不存在的 GI 增益假设 |
| （未提及相机） | **场景无相机**，此 .blend 文件仅用于材质/模型编辑，不能直接渲染对比 |
| actual_肌 材质类型未确认 | **身体材质 = StarRailShader.身体变体_v17**（与引擎 sr_body 对应） |

**核心修正**：emission 材质（Color→Surface 隐式包装）的最终渲染颜色 = emission_color × strength(1.0) × tonemap(exposure)，**无任何 GI 增益**。引擎 [body.ts:54-57](file:///e:/reze-engine/engine/src/shaders/materials/starrail/body.ts#L54-L57) 的 `+ ambient` 补偿基于错误的 GI 假设，需要重新评估。

## 0. 最终根因定位与新对齐方案（2026-06-24 MCP 深入分析）

> 以下结论基于 MCP 连接 Blender 5.0 逐节点数值化对比 + OCIO 2.4 API 完整链路验证，替代下方第 3-8 节的所有旧分析。

### 偏暗根因排序

| 排名 | 根因 | 影响范围 | 误差量级 |
|------|------|---------|---------|
| **#1 致命** | [composite.ts](file:///e:/reze-engine/engine/src/shaders/passes/composite.ts) 256 点 LUT 缺少 High Contrast look | 全局，所有亮度 | 0.02–0.12 |
| **#2 中等** | sr_* 材质多余 `+ ambient` 项 | 材质输出偏亮 ~14% | 0.03–0.08 |
| #3 轻微 | `brightnessScale` 语义混乱（值=1.0，no-op） | 无实际影响 | 0 |
| #4 可忽略 | ramp 21 点 LUT 精度 | < 0.006/通道 | < 0.006 |
| #5 可忽略 | SDF.tex UV 差异 | noseShadow ≈ 1.0 | ~0 |

**根因 #1 详细对比**（MCP 通过 OCIO 2.4 GroupTransform 手动构建完整链路验证）：

| linear 输入 | 正确 LUT (Blender+HC) | 当前引擎 LUT | 差异 |
|------------|----------------------|-------------|------|
| 0.05 | 0.214 | 0.121 | **-0.093** |
| 0.10 | 0.355 | 0.234 | **-0.121** |
| 0.30 | 0.630 | 0.526 | **-0.104** |
| 0.50 | 0.745 | 0.670 | **-0.075** |
| 1.00 | 0.863 | 0.825 | -0.038 |

引擎 LUT 偏暗的原因：提取时使用了 `DisplayViewTransform`，但 OCIO 2.4 的 `DisplayViewTransform` 无 `setLooks()` 方法，导致 High Contrast look 未被应用。正确方法：手动构建 GroupTransform 链 (scene_linear → Filmic Log → HC look → scene_linear → sRGB display)。

### 新对齐方案：LUT-Fix + Ambient-Remove

**替代已废弃的方案 C（乘法增益 1.9375x）+ 方案 E（3D LUT）**

#### 修改 1: 替换 composite.ts 256 点 LUT

正确的 256 点 LUT 数据已通过 MCP 从 Blender 5.0 OCIO 完整链路提取（含 HC look），详见 `re-audit-lighting-eevee-emission/tasks.md` Task 7 修改清单。

#### 修改 2-8: 移除 8 处 ambient + brightnessScale

**类型 A：emission 模型 — 移除 `+ ambient` + `brightnessScale`**（7 处）

| # | 文件 | 说明 |
|---|------|------|
| 2 | body.ts (54-62) | `withShadow` |
| 3 | clothes.ts outer (74-81) | `base * specScaled` |
| 4 | clothes.ts inner (142-149) | `base * specScaled` |
| 5 | face.ts (47-58) | `withShadow` |
| 6 | hair.ts (120-135) | `emissionColor`（含 DEBUG_MODE switch） |
| **7** | **special.ts (137-145)** | 袖球，`base * specScaled` |
| **8** | **eye.ts (89-96)** | 眼部，`corrected` |

**类型 B：Principled BSDF 模型 — 仅移除 `brightnessScale`**（1 处）

| # | 文件 | 说明 |
|---|------|------|
| **9** | **stocking.ts (481-482)** | 仅移除 brightnessScale，保留 `amb`（Principled BSDF 需要） |

**无需修改**：eyeshadow.ts、edge.ts、mmd.ts（无 ambient/brightnessScale）

### 预期效果

以参考点 N=(0,0.707,0.707) emission_color R 通道为例：

| 环节 | 当前引擎 | 修复后 | Blender |
|------|---------|--------|---------|
| 材质输出 | 0.662 (+ambient) | 0.580 (无ambient) | 0.580 |
| tonemap | 0.708 (错误LUT) | 0.774 (正确LUT) | 0.774 |
| **最终显示** | **0.708** | **0.774** | **0.774** |
| 与 Blender 差异 | -9.2% | **0%** | — |

修复后引擎在材质输出和色调映射两个环节都与 Blender 精确对齐。

---

> **注意**：下方第 1-8 节为初版分析（2026-06-23），基于错误的 Cycles 假设。保留作为历史记录，但所有结论已被本节取代。

## 1. 根本性差异发现（已修正）

### 1.1 Blender 光照配置（经 MCP 复核 2026-06-24）

| 配置项 | 值 | 说明 |
|--------|-----|------|
| Light 对象数 | **0** | 场景无任何 Light 对象（不是 energy=0，是根本不存在） |
| World Background Color | (0.0509, 0.0509, 0.0509) | 深灰色 |
| World Background Strength | 1.0 | |
| view_transform | Filmic | |
| look | High Contrast | |
| exposure | 0.0 | |
| gamma | 1.0 | |
| display_device | sRGB | |
| render engine | **EEVEE Next** | taa_render_samples=64, use_fast_gi=True, gi_diffuse_bounces=3, use_raytracing=False |
| 相机 | **无** | 场景无相机，.blend 文件仅用于材质编辑 |

**关键结论（修正）**：Blender 场景无任何光源，材质节点组内部的"虚拟日光"（半兰伯特）仅用于**调制 emission color**（决定材质表面的亮度分布），不是真实光照。emission 是纯发光体，不接收任何 GI bounce。World Background (0.05灰) 通过 EEVEE Fast GI 影响的是**非 emission 表面**（如场景中没有），对 emission 材质无影响。

### 1.2 引擎光照配置

| 配置项 | 值 | 文件位置 |
|--------|-----|---------|
| sun.strength | 5.0 | [page.tsx:457](file:///e:/reze-engine/web/app/page.tsx#L457) |
| sun.direction | (-0.296, -0.500, 0.814) | [page.tsx:457](file:///e:/reze-engine/web/app/page.tsx#L457) |
| world.color | (0.05, 0.05, 0.05) | [page.tsx:458](file:///e:/reze-engine/web/app/page.tsx#L458) |
| world.strength | 1.0 | [page.tsx:458](file:///e:/reze-engine/web/app/page.tsx#L458) |
| view.exposure | 0.0 | [page.tsx:459](file:///e:/reze-engine/web/app/page.tsx#L459) |
| brightnessScale | sun.strength / 5.0 = 1.0 | 各 sr_* shader |

**关键差异（修正）**：引擎 `sun.strength=5.0` 仅作为 `brightnessScale = strength/5.0 = 1.0` 的乘数（等效 1.0），不是真实方向光强度。Blender 隐式 emission strength=1.0，两者在 strength 上等效。真正的差异在 ambient 补偿项和节点级公式。

## 2. 逐节点审计结果汇总

### 2.1 节点级对齐度

| 材质 | 对齐项数 | 总项数 | 对齐率 | 节点级根因 |
|------|---------|--------|--------|-----------|
| Body | 20 | 22 | 91% | 节点级完全对齐，差异在最终输出公式 |
| Clothes | 12 | 15 | 80% | 节点级基本对齐，blinn_phong 半向量方向有争议 |
| Face | 20 | 22 | 91% | 节点级完全对齐，差异在最终输出公式 |
| Hair | 13 | 17 | 76% | 节点级完全对齐，差异在 ambient/GI 补偿 |

**结论**：四个材质的节点级实现（virtual_sun / ramp_lookup / blinn_phong / color_correct / nose_shadow / sdf_face_shadow / matcap_sample）与 Blender 基本完全对齐。整体偏暗的根因**不在节点级公式**，而在**光照模型层面**和**后处理链路**。

### 2.2 关键节点级发现

| 函数 | Blender 公式 | 引擎实现 | 状态 |
|------|------------|---------|------|
| virtual_sun | `pow((half_lambert × green_smooth) × 0.5 + 0.5, 2.0)` | [starrail_nodes.ts:125](file:///e:/reze-engine/engine/src/shaders/materials/starrail/starrail_nodes.ts#L125) `pow(step3, 2.0)` | ✅ 一致（平方，非 sqrt） |
| ramp_lookup | `mix(c1(color), c2(c1(color)), 1-(alpha>0.10))` | [starrail_nodes.ts:227](file:///e:/reze-engine/engine/src/shaders/materials/starrail/starrail_nodes.ts#L227) `mix(first, second, select(1,0,alpha>0.10))` | ✅ 一致（嵌套 + 二值） |
| blinn_phong | `dot(N, normalize(Incoming + SUN))` | [starrail_nodes.ts:91](file:///e:/reze-engine/engine/src/shaders/materials/starrail/starrail_nodes.ts#L91) `dot(n, normalize(v + l))` | ✅ 一致（v+l 正确） |
| color_correct | `HSV(RGB_Curves(c), 0.5, 1.0, 1.85)` | [starrail_nodes.ts:64](file:///e:/reze-engine/engine/src/shaders/materials/starrail/starrail_nodes.ts#L64) `hsv.z * 1.85` | ✅ 一致 |

## 3. 整体偏暗根因分析（按严重程度分级）

### P0 致命差异（直接导致整体偏暗）

| # | 差异 | 影响 | 当前值 | 期望值 |
|---|------|------|--------|--------|
| P0-1 | Cycles 间接光照缺失 | 全局偏暗 ~1.94x | 0（无 GI） | ~1.9375x 乘性增益 |
| P0-2 | World ambient 不足 | 暗部死黑 | `0.05 × corrected`（加法） | HDRI 0.778 + 间接 1.9375 |
| P0-3 | 加法 vs 乘法结构 | 高光区比例失调 | `(finalColor + ambient)` | `finalColor × (1 + indirect)` |
| P0-4 | 1D LUT 无法复现 3D filmic_desat_33 | 蓝紫色偏暗，高光 clipping | 256 点 1D LUT | 33³ 3D LUT + desaturation |
| P0-5 | brightnessScale 多余缩放 | 结构性差异 | `sun.strength/5.0 = 1.0` | Blender 无外部强度 |

### P1 中等差异

| # | 差异 | 影响 |
|---|------|------|
| P1-1 | clothes specScaled=20 阻碍全局增益 | 高光 ×1.9375=38.75 在 1D LUT 下 clipping |
| P1-2 | FILMIC_MODE 声明但未使用 | 无法切换 filmic 模式 |
| P1-3 | filmic_hc_32.bin 不存在 | 之前 3D LUT 修复未生效 |
| P1-4 | blinn_phong 注释矛盾 | 代码 `v+l` 正确，注释 `l-v` 错误 |

## 4. 精确对齐方案

### 4.1 推荐方案：方案 C（乘法增益）+ 方案 E（3D LUT）

**核心逻辑**：
1. **方案 C**：将 `(finalColor + ambient) × brightnessScale` 改为 `finalColor × INDIRECT_GAIN`，其中 `INDIRECT_GAIN = 1.9375`。这与 Blender Cycles 间接光照效果完全一致（乘性增益）。
2. **方案 E**：重新实施 3D LUT（33³ filmic_desat_33.cube）替代 1D LUT。方案 C 后 clothes 高光 = `base × 20 × 1.9375 = 38.75`，1D LUT 会 clip 到纯白，3D LUT 的 desaturation 会保留色彩。

**关键约束**：**必须先实施 3D LUT 再启用 1.9375x 增益**，否则 clothes 高光会 clipping。

### 4.2 不推荐方案

| 方案 | 不推荐理由 |
|------|-----------|
| 方案 A（分材质差异化增益） | 违反 GI 物理本质（GI 对所有材质统一作用），body 归类困难 |
| 方案 B（修复 clothes 高光上限） | 扭曲 Blender 真实参数（specScaled=20 是 MCP 核对值） |
| 方案 D（提高 ambient 强度） | 加法结构未解决，高光区域 ambient 占比失调 |

### 4.3 修改清单

#### 修改 1-5：四个 sr_* 材质 — 移除加法 ambient + brightnessScale，改乘法增益

**统一修改模式**（body.ts / clothes.ts / face.ts / hair.ts）：

```wgsl
// 旧值（所有材质统一）
let ambient = light.ambientColor.xyz * corrected;
let brightnessScale = light.lights[0].color.w / 5.0;
out.color = vec4f((finalColor + ambient) * brightnessScale, alpha);

// 新值（所有材质统一）
let indirectGain = 1.9375;  // Cycles 4 diffuse bounce 间接光照增益
out.color = vec4f(finalColor * indirectGain, alpha);
```

| 文件 | 修改行号 | 说明 |
|------|---------|------|
| [body.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/body.ts) | 54-62 | finalColor = withShadow |
| [clothes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/clothes.ts) | 74-81 | finalColor = base × specScaled |
| [clothes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/clothes.ts) | 142-149 | inner clothes 同上 |
| [face.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/face.ts) | 47-58 | finalColor = withShadow |
| [hair.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/hair.ts) | 121-136 | finalColor = emissionColor，含 DEBUG_MODE 分支 |

#### 修改 6：composite.ts — 3D LUT 替代 1D LUT

**文件**：[composite.ts](file:///e:/reze-engine/engine/src/shaders/passes/composite.ts)

| 行号 | 旧值 | 新值 | 理由 |
|------|------|------|------|
| 17-26 | group(0) bindings（无 3D 纹理） | 新增 `@group(0) @binding(5) var filmicLUT: texture_3d<f32>;` + sampler | 3D LUT 采样 |
| 33-56 | 1D `fn filmic(x: f32)` + 256 array | `fn filmic3d(rgb: vec3f) -> vec3f { ... textureSample(filmicLUT, ...) }` | 3D LUT 含 desaturation |
| 79 | `vec3f(filmic(exposed.r), filmic(exposed.g), filmic(exposed.b))` | `filmic3d(exposed)` | 3D tonemap |

**注意**：需从 Blender 提取 `filmic_desat_33.cube` 数据，在 engine.ts 中创建 3D 纹理并绑定。

#### 修改 7：page.tsx — 配置无需修改

| 配置 | 当前值 | 保持/修改 | 理由 |
|------|--------|----------|------|
| sun.strength | 5.0 | **保持** | 用于阴影/非 StarRail 材质；移除 brightnessScale 后不影响 StarRail 亮度 |
| world.color | (0.05, 0.05, 0.05) | **保持** | ambientColor 不再用于 StarRail 材质 |
| view.exposure | 0.0 | **保持** | 与 Blender 一致 |

#### 修改 8：starrail_nodes.ts — 修正注释

**文件**：[starrail_nodes.ts:82](file:///e:/reze-engine/engine/src/shaders/materials/starrail/starrail_nodes.ts#L82)

修正 blinn_phong 注释矛盾：代码 `v+l` 是正确的（v 是表面→相机，l 是表面→光源，H = normalize(v+l) 是标准半向量）。

## 5. 预期效果量化

### 5.1 亮度提升

| 材质 | 当前公式 | 修改后公式 | 提亮倍数 |
|------|---------|-----------|---------|
| body | `(withShadow + 0.05×corrected) × 1.0` | `withShadow × 1.9375` | ~1.94x |
| clothes | `(base×specScaled + 0.05×corrected) × 1.0` | `base×specScaled × 1.9375` | ~1.94x |
| face | `(withShadow + 0.05×corrected) × 1.0` | `withShadow × 1.9375` | ~1.94x |
| hair | `(emissionColor + 0.05×corrected) × 1.0` | `emissionColor × 1.9375` | ~1.94x |

### 5.2 高光 clipping 修复

| 场景 | 当前 (1D LUT) | 修改后 (3D LUT) | Blender |
|------|-------------|----------------|---------|
| clothes 高光 (38.75) | clip 到纯白 | desaturation 保留色彩 | desaturation 保留色彩 |
| 蓝紫色阴影 | 偏暗 | 准确 | 准确 |

## 6. 实施顺序建议

1. **阶段 1（后处理）**：实施 3D LUT（修改 6）——先解决 tonemap 容量问题
2. **阶段 2（光照）**：实施乘法增益（修改 1-5）——在 3D LUT 就绪后启用 1.9375x
3. **阶段 3（清理）**：修正注释（修改 8）、处理 FILMIC_MODE（P1-2）
4. **阶段 4（验证）**：MCP 连接 Blender 实测对比，微调 `indirectGain` 值

## 7. 风险评估

| 风险 | 等级 | 缓解措施 |
|------|------|---------|
| 3D LUT 数据提取失败 | 中 | 可用 Python 脚本从 Blender 导出 33³ 数据 |
| `indirectGain=1.9375` 值不准确 | 中 | 需 MCP 实测 Cycles 间接光照精确值 |
| clothes 高光在 3D LUT 前仍 clipping | 高 | **必须先实施 3D LUT，再启用 indirectGain** |
| 非 StarRail 材质受影响 | 低 | 修改仅涉及 starrail/ 目录的 4 个材质文件 |

## 8. 待 MCP 验证项

1. `actual_肌` 材质类型确认（MMDShaderDev vs StarRailShader.身体变体_v17）
2. Cycles 间接光照增益精确值（当前估算 1.9375x）
3. `filmic_desat_33.cube` 文件提取与 3D LUT 数据验证
4. blinn_phong 半向量方向最终确认（当前 `v+l` 正确）
