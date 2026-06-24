# 重新深入分析光照偏暗根因（EEVEE Emission 模型）Spec

## Why

初版审计（2026-06-23）基于错误假设：认为 Blender 用 Cycles 渲染，SunLight energy=0.0，Cycles 通过 4 次 diffuse bounce 为 emission 材质提供 ~1.9375x 间接光照增益，并据此设计了"方案 C（乘法增益 1.9375x）+ 方案 E（3D LUT）"。

2026-06-24 MCP 复核推翻了这些假设：
- **渲染引擎实际是 EEVEE Next**（不是 Cycles）：taa_render_samples=64, use_fast_gi=True, gi_diffuse_bounces=3, use_raytracing=False
- **场景无任何 Light 对象**（0 个，不是 energy=0）：连几何节点引用的"灯光.001"对象都不存在
- **场景无相机**：.blend 文件仅用于材质/模型编辑，不能直接渲染对比
- **emission 不接收 GI bounce**（PBR 定义）：emission 是纯发光体，"Cycles 1.9375x 增益"完全错误
- **身体材质 = StarRailShader.身体变体_v17**：与引擎 sr_body 对应，已确认

因此引擎 [body.ts:54-57](file:///e:/reze-engine/engine/src/shaders/materials/starrail/body.ts#L54-L57) 的 `+ ambient` 补偿（基于错误的 GI 假设）需要重新评估，整体偏暗的真正根因需要重新定位。

## What Changes

本次为**纯分析任务**，不修改代码，只产出新的对齐方案：

- 在 EEVEE Next + emission 模型下，重新逐节点推导 Blender 的最终输出值
- 通过数值化对比（不依赖渲染）找出引擎与 Blender 的精确差异
- 重新评估 `+ ambient` 补偿项的角色：是否必要、应保留/移除/重新形式化
- 重新评估 `brightnessScale = sun.strength / 5.0` 的语义（既然 Blender 无 light strength 概念）
- 验证 ramp 采样是否真的对齐（包括嵌套 RGB Curves 和 second_factor 二值逻辑）
- 验证色调映射链路（1D LUT vs EEVEE Next 的实际 tonemapper）
- 产出新的精确对齐方案，替代已废弃的"方案 C + 方案 E"

## Impact

- **Affected specs**: 
  - `audit-lighting-brightness-alignment`（已完成但结论作废，需在新 spec 中明确标注 OBSOLETE）
- **Affected code** (分析对象，不修改):
  - `engine/src/shaders/materials/starrail/body.ts` (lines 40-65)
  - `engine/src/shaders/materials/starrail/clothes.ts` (lines 65-89)
  - `engine/src/shaders/materials/starrail/face.ts` (lines 45-62)
  - `engine/src/shaders/materials/starrail/hair.ts` (lines 118-141)
  - `engine/src/shaders/materials/starrail/starrail_nodes.ts` (校色/ramp/virtual_sun)
  - `engine/src/shaders/passes/composite.ts` (256 点 1D LUT)
  - `web/app/page.tsx` (光照配置)

## ADDED Requirements

### Requirement: EEVEE Emission 模型下的精确数值对比

系统 SHALL 通过 MCP 连接 Blender 5.0，在无相机、无灯光、EEVEE Next + Fast GI 配置下，逐节点数值化对比引擎与 Blender 的输出差异，不依赖直接渲染对比。

#### Scenario: 节点级数值对齐验证
- **WHEN** 在固定 UV 点（如 Body3.png 中心点）和固定 SUN 方向下评估
- **THEN** 引擎 WGSL 计算结果与 Blender 节点树 Python 评估结果在每个子环节（texColor → corrected → rampColor → withShadow → 最终输出）的数值差异应 < 0.005

### Requirement: Ambient 补偿项的重新评估

系统 SHALL 在 emission 不接收 GI 的事实下，重新分析引擎 `(finalColor + ambient) × brightnessScale` 公式中 `+ ambient` 项的来源和必要性，确定它是：
- (a) 完全多余（Blender emission 输出 = Mix.001 输出，无 ambient 加法）
- (b) 部分必要（用于补偿引擎缺失的其他效果）
- (c) 形式错误（应该是乘法而非加法）

#### Scenario: ambient 角色确认
- **WHEN** 查询 Blender 身体节点组的最终输出链（Mix.001 → Group Output Result → Material Output Surface）
- **THEN** 明确 Blender 最终 emission color 的精确公式，并与引擎对比，确定 ambient 项的正确处理方式

### Requirement: 色调映射链路重新验证

系统 SHALL 验证引擎 composite.ts 的 256 点 1D LUT 是否能准确复现 EEVEE Next 的色调映射链路（注意：EEVEE Next 的 tonemapper 与 Cycles 使用的 OCIO config 可能不同）。

#### Scenario: EEVEE tonemapper 验证
- **WHEN** 查询 Blender 5.0 EEVEE Next 在 view_transform=Filmic, look=High Contrast 下的实际色调映射公式
- **THEN** 与引擎 1D LUT 对比，确认是否一致；若不一致，提取 EEVEE 专用的 LUT 数据

## MODIFIED Requirements

### Requirement: 整体亮度差异根因定位（替代初版）

**初版（OBSOLETE）**：根因是 Cycles 间接光照缺失（~1.94x）+ World ambient 不足 + 1D LUT 限制。

**修正版**：在 EEVEE emission 模型下，根因候选列表（按优先级）：
1. **引擎 `+ ambient` 补偿方向错误**：Blender emission 无 ambient 加法项，引擎却加了 `light.ambientColor.xyz × corrected`
2. **brightnessScale 语义混乱**：Blender 无 light strength 概念，引擎 `sun.strength / 5.0` 是历史遗留
3. **ramp 采样精确度**：嵌套 RGB Curves + second_factor 二值逻辑是否真的对齐
4. **色调映射差异**：EEVEE Next tonemapper vs 引擎 1D LUT
5. **UV/法线/坐标变换差异**：导致 virtual_sun 和 ramp_lookup 输入值不同

系统 SHALL 通过逐项数值对比确认真正的根因，按影响大小排序。

## REMOVED Requirements

### Requirement: Cycles 1.9375x 增益补偿方案
**Reason**: 基于错误的 Cycles 假设。Blender 实际用 EEVEE Next，且 emission 不接收 GI bounce。
**Migration**: 新的对齐方案将在本 spec 的分析结果中提出，替代"方案 C（乘法增益 1.9375x）+ 方案 E（3D LUT）"。
