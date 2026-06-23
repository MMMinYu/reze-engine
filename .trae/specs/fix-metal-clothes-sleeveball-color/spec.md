# 金属泛灰与衣服/袖球颜色对齐深入检查 Spec

## Why

上一轮 `fix-shader-blender-alignment` spec 标记为完成后，用户仍观察到三个问题：金属件在光照下泛灰、外层衣服颜色与 Blender 不一致、袖球颜色与 Blender 不一致。这些问题表明之前的修复未覆盖所有根因，需要通过 MCP 连接 Blender 逐节点深入验证，彻底定位并修复。

## What Changes

- **金属泛灰**：通过 MCP 核对 Blender 中"金属"及所有金属类材质（衣金属/袖金属/帽金属等）的实际节点树，判断 `metal.ts` 的 NPR+Principled 混合实现是否正确，以及金属材质是否应统一使用 `metal` 预设而非 `sr_clothes`
- **外层衣服颜色**：修复 sun strength 7.25→5.0；通过 MCP 核对 Blinn-Phong 高光半向量是否应包含 SUN 方向；核对 ramp_lookup 的 Factor 是连续值还是二值切换；核对 second_curved 是混合还是嵌套应用
- **袖球颜色**：通过 MCP 核对 Blender "袖球"材质的完整节点树（贴图、sphere UV、降饱和、增亮参数），逐节点对比 `special.ts` 实现
- 每个问题修复后更新对应的 docs/ 调试记录文档

## Impact

- Affected specs: metal, sr_clothes, sr_special 材质预设
- Affected code:
  - [metal.ts](file:///e:/reze-engine/engine/src/shaders/materials/metal.ts) — 金属 NPR+Principled 实现
  - [clothes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/clothes.ts) — 外层衣服 shader
  - [starrail_nodes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/starrail_nodes.ts) — 共享函数 (virtual_sun, ramp_lookup, blinn_phong)
  - [special.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/special.ts) — 袖球 shader
  - [page.tsx](file:///e:/reze-engine/web/app/page.tsx) — sun strength、材质预设映射
  - [manifest.json](file:///e:/reze-engine/web/public/models/风堇/manifest.json) — 材质 preset 映射

## ADDED Requirements

### Requirement: Blender MCP 验证
所有涉及 Blender/PMX 模型数据、材质设置的结论，必须通过 MCP 连接 Blender 验证，不得凭猜测下结论。每个问题的根因分析必须有 MCP 查询证据支撑。

#### Scenario: 验证材质节点
- **WHEN** 检查某个材质的 Blender 节点设置
- **THEN** 通过 `execute_blender_code` 查询该材质的节点树、参数值、连接关系
- **AND** 记录查询结果到调试文档

### Requirement: 调试文档记录
复杂调试任务必须在 docs/ 创建调试记录文档，每步修改后更新文档。

#### Scenario: 修改 shader 代码
- **WHEN** 修改任何 shader 代码以修复对齐问题
- **THEN** 在对应调试文档记录：问题、MCP 查询证据、根因、修复内容、验证结果

## MODIFIED Requirements

### Requirement: 金属材质 (metal preset)
当前仅"金属"映射为 `metal` 预设，其余金属类材质（衣金属/袖金属/帽金属/披风金属/挂金属/背金属/足金属/领金属/眼罩金属/口枷金属1/口枷金属2）均映射为 `sr_clothes`。`metal.ts` 中 NPR emission 乘以 8.1 后以 30.33% 权重与 Principled BSDF (69.67%) 混合，可能导致泛灰。需通过 MCP 核对：
1. Blender 中"金属"材质的完整节点树（NPR 栈 + Principled BSDF + MixShader）
2. 各金属类材质是否使用同一节点组，还是部分使用 StarRail clothes 节点组
3. `metal.ts` 的 NPR emission 强度、MixShader Factor、Voronoi 基色链是否与 Blender 一致
4. `eval_principled` 在 metallic=1.0 时的反射计算是否正确

### Requirement: 外层衣服材质 (sr_clothes)
当前 sun strength=7.25（应为 5.0），导致 brightnessScale=1.45。`clothes.ts` 中 Blinn-Phong 高光的半向量 `h = normalize(l + v)` 可能缺少 SUN 方向贡献。`ramp_lookup` 的 second_factor 使用二值切换 (`select(1.0, 0.0, alpha > 0.10)`)，而 Blender 中可能是连续值。需通过 MCP 核对：
1. `星铁@Minyu-Shader.clothes.001` 节点组中 Blinn-Phong 的半向量计算（是否 `Incoming + SUN` 而非 `L + V`）
2. ramp.002 子组中 RGB Curves 的 Factor 是连续值还是二值
3. second_curved 是 `mix(first, c2(first), factor)` 还是 `c2(first)` 直接替换
4. 修复 sun strength 至 5.0

### Requirement: 袖球材质 (sr_special)
当前 `special.ts` 实现 sphere mapping + 降饱和 + 增亮。需通过 MCP 核对 Blender "袖球"材质的完整节点树，逐节点对比：
1. 基础贴图采样与降饱和参数 (HueSaturation: Hue=0.5, Saturation=0.9, Value=1.0, Factor=1.0)
2. MMDTexUV.001 Sphere UV 计算 (Normal → VECT_TRANSFORM → Mapping)
3. Sphere 贴图增亮参数 (MapRange: 0→0.42, 1→2.0)
4. 乘法合成与输出方式（emission-like 无光照）
5. 是否缺少光照或亮度缩放
