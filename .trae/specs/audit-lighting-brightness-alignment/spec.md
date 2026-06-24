> ⚠️ **OBSOLETE (2026-06-24)**：本 Spec 的核心假设已被推翻。Blender 实际使用 EEVEE Next（非 Cycles），场景无任何 Light 对象，emission 材质不接收 GI bounce。所有基于"Cycles 1.9375x 增益"的结论和"方案 C + 方案 E"均已废弃。新分析见 `re-audit-lighting-eevee-emission/spec.md`。

# 引擎光照与 Blender 逐节点对齐审计 Spec

## Why

用户反馈模型整体比 Blender 暗。经初步 MCP 查询发现一个**根本性差异**：Blender 场景中两个 SunLight 的 `energy` 都为 **0.0**，场景无实际方向光照射，光照完全由材质节点组内部的"虚拟日光"（半兰伯特）节点组计算；而引擎使用 `sun.strength=5.0` 作为真实方向光，并通过 `brightnessScale = sun.strength / 5.0` 缩放材质输出。这两种光照模型在数值链路上存在本质差异，需要逐节点深入对比 Blender 材质节点组与引擎 WGSL 实现，精确定位偏暗根因并找到对齐方法。

## What Changes

- **逐节点审计 Blender 材质节点组**：通过 MCP 深入查询 `StarRailShader.身体变体_v17`（body）、`星铁@Minyu-Shader.clothes.001`（clothes）、`星铁@Minyu-Shader.face`（face）、`星铁@Minyu-Shader.hair`（hair）四个核心节点组的**完整内部节点树**，包括所有子节点组（虚拟日光、校色、ramp、布林冯光照模型、matcap、ilm、SDF 等）的内部实现、参数值、连接关系
- **逐函数对比引擎 WGSL 实现**：将 Blender 每个子节点组的输出公式与引擎 `starrail_nodes.ts` 中对应函数（`virtual_sun`、`ramp_lookup`、`blinn_phong`、`sdf_face_shadow`、校色 LUT 等）逐行对比，列出所有数值/公式差异
- **审计整体乘法链路**：对比 Blender 材质的最终输出公式（`校色 × ramp × matcap × ...`）与引擎的 `(NPR + ambient) × brightnessScale`，找出乘法顺序、加法项、缩放系数的差异
- **审计后处理链路**：对比 Blender 的 Filmic + High Contrast look + sRGB display 与引擎 composite.ts 的 256 点 LUT + gamma 链路
- **确定精确对齐方法**：基于逐节点差异清单，提出具体的参数/公式修正方案，使引擎输出数值与 Blender 像素级对齐
- 每个差异点修复后更新 docs/ 调试记录文档

## Impact

- Affected specs: 全局亮度配置、sr_body / sr_clothes / sr_face / sr_hair 材质预设、composite 后处理
- Affected code:
  - [engine.ts](file:///e:/reze-engine/engine/src/engine.ts) — 光照 uniform 写入、brightnessScale 基准、HDR 格式
  - [composite.ts](file:///e:/reze-engine/engine/src/shaders/passes/composite.ts) — Filmic LUT、exposure、gamma
  - [starrail_nodes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/starrail_nodes.ts) — virtual_sun / ramp_lookup / blinn_phong / 校色 LUT
  - [body.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/body.ts) — 身体材质亮度链
  - [clothes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/clothes.ts) — 衣服材质亮度链
  - [face.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/face.ts) — 脸部材质亮度链
  - [hair.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/hair.ts) — 头发材质亮度链
  - [page.tsx](file:///e:/reze-engine/web/app/page.tsx) — sun.strength / world / exposure 配置

## ADDED Requirements

### Requirement: Blender MCP 逐节点验证
所有涉及 Blender 材质节点组、子节点组、参数值的结论，必须通过 MCP 连接 Blender 逐节点查询验证，不得凭猜测下结论。每个差异点的根因分析必须有 MCP 查询证据支撑（包括节点类型、参数值、连接关系）。

#### Scenario: 查询子节点组内部实现
- **WHEN** 需要对比某个子节点组（如"虚拟日光"、"校色"、"ramp"）的内部公式
- **THEN** 通过 `execute_blender_code` 进入 `bpy.data.node_groups[子节点组名].nodes` 和 `.links`，列出所有内部节点、参数、连接
- **AND** 推导出该子节点组的输入→输出数学公式
- **AND** 与引擎 WGSL 对应函数逐行对比

### Requirement: 调试文档记录
复杂调试任务必须在 docs/ 创建调试记录文档，每步修改后更新文档。

#### Scenario: 修改 shader 代码
- **WHEN** 修改任何 shader 代码以修复亮度对齐问题
- **THEN** 在 docs/lighting-audit-debug.md 记录：问题、MCP 查询证据、Blender 公式、引擎当前公式、差异、修复内容、验证结果

### Requirement: 逐节点差异清单
审计完成后，必须产出一份完整的"Blender 节点 → 引擎函数 → 差异 → 修复方案"对照表，覆盖四个核心材质（body/clothes/face/hair）的所有子节点组。

#### Scenario: 审计完成
- **WHEN** 四个核心材质的所有子节点组均已对比
- **THEN** 在 docs/lighting-audit-debug.md 列出完整对照表
- **AND** 每个差异项标注：差异类型（公式/参数/顺序/缺失）、严重程度（致命/中等/轻微）、修复优先级

## MODIFIED Requirements

### Requirement: 光照模型根本性差异修正
**Blender 现状**（经 MCP 验证）：
- 场景 SunLight energy=0.0，无实际方向光
- World Background Color=(0.0508, 0.0508, 0.0508)，Strength=1.0
- 光照完全由材质内部"虚拟日光"节点组计算（半兰伯特 + 硬编码 SUN 方向）
- 最终颜色 = 校色(color) × ramp(half_lambert) × matcap × ... （纯材质内部计算，无外部 light strength 缩放）

**引擎现状**：
- sun.strength=5.0，作为真实方向光
- world.color=(0.05, 0.05, 0.05)，strength=1.0 → ambient=(0.05, 0.05, 0.05)
- brightnessScale = sun.strength / 5.0 = 1.0
- 最终颜色 = (NPR_result + ambient) × brightnessScale

**需通过逐节点对比确定**：
1. Blender"虚拟日光"节点组的半兰伯特公式是否与引擎 `virtual_sun()` 完全一致（包括 pow 指数、wrap 系数、ILM green 门控）
2. Blender"校色"节点组的颜色校正是否与引擎 `_c_curve_lut` / `_ramp_c1_lut` / `_ramp_c2_lut` 一致
3. Blender"ramp"节点组的 ramp 采样与引擎 `ramp_lookup()` 是否一致（包括 Map Range 范围、second_curved 嵌套）
4. Blender 最终乘法链（`校色 × ramp × matcap`）与引擎（`(NPR + ambient) × brightnessScale`）的加法 vs 乘法差异
5. 是否需要移除 brightnessScale 缩放（因为 Blender 无外部 light strength）
6. ambient 项的数值是否需要调整（Blender World Background 0.0508 vs 引擎 0.05）

### Requirement: 后处理链路对齐
**Blender 现状**（经 MCP 验证）：
- view_transform: Filmic
- look: High Contrast
- exposure: 0.0
- gamma: 1.0
- display_device: sRGB
- render engine: Cycles, samples=1, use_denoising=true, max_bounces=12

**引擎现状**：
- composite.ts 使用 256 点 LUT（从 Blender 5.0 .spi1d 提取的 High Contrast 曲线）
- exposure 在 bloom 合并后、Filmic 前应用：`exposed = combined × exp2(view.exposure)`
- gamma=1.0 → 使用 identity pipeline，跳过 pow
- bloom.enabled=false

**需验证**：
1. 引擎 256 点 LUT 是否与 Blender 5.0 当前安装版本的 .spi1d 文件完全一致
2. exposure 应用顺序是否与 Blender 一致（Blender 在 Filmic 前还是后应用 exposure）
3. Blender 的 sRGB display 转换是否在引擎中正确实现（composite.ts 末尾是否有 sRGB 编码）
4. 是否缺少 Blender 的 High Contrast look 步骤（LUT 是否已包含 look）

### Requirement: 四个核心材质逐节点审计
对 body / clothes / face / hair 四个核心材质，逐节点对比 Blender 节点组与引擎 WGSL：

**Body (StarRailShader.身体变体_v17, 19 节点)**：
- 校色 → 虚拟日光 → Map Range → ramp → Mix(校色×ramp) → Mix.001(×鼻尖阴影) → Result
- 对比 body.ts 的 `corrected × ramp + ambient` 链路

**Clothes (星铁@Minyu-Shader.clothes.001, 37 节点)**：
- 校色.001 → 虚拟日光.001 → 布林冯光照模型.001 → ilm.clothes.001 → smoothstep → ramp.001 → 多层 Mix → Result
- 对比 clothes.ts 的 `corrected × ramp + matcap + blinn_phong + ambient` 链路

**Face (星铁@Minyu-Shader.face, 19 节点)**：
- 对比 face.ts 的 SDF 阴影 + ramp + 校色链路

**Hair (星铁@Minyu-Shader.hair, 25 节点)**：
- 对比 hair.ts 的 virtual_sun + ramp + matcap + emission + ambient 链路
