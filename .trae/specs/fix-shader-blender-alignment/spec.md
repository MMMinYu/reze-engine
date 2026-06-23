# 着色器与 Blender 对齐修复 Spec

## Why

风堇模型有 5 处材质渲染结果与 Blender 参考不一致：目影颜色、披风+光照、衣服金属部件颜色、袖球材质、白裤袜厚度梯度。这些差异源于 shader 实现错误、材质预设映射错误、以及参数与 Blender 节点不符。需要通过 MCP 连接 Blender 逐节点深入验证，修复所有差异。

## What Changes

- **目影 (sr_eyeshadow)**：通过 MCP 核对 Blender 中"目影"材质的实际 Transparent BSDF 颜色与 alpha，修正固定灰色输出
- **披风+ (sr_clothes_inner)**：修复 `virtual_sun(n, vec3f(0.0), ilmGreen)` 中光线方向传零向量的 bug，改为正确的光照方向；核对法线翻转逻辑
- **金属部件**：核对 Blender 中"衣金属/袖金属/帽金属/披风金属/金属"等材质实际使用的节点组，判断应使用 `metal` 预设还是 `sr_clothes`，修正 manifest 映射
- **袖球**：核对 Blender 中"袖球"材质的节点组结构，判断应使用 `sr_special` 还是 `sr_clothes`，修正 manifest 映射与 shader 实现
- **白裤袜厚度**：核对 Blender 中 `UseCustomThickness` 标志与 `CustomThickness` Float Curve，修正 `custom_thickness_curve` 使厚度均匀（Blender 为均匀）
- 每个问题修复后更新对应的 docs/ 调试记录文档

## Impact

- Affected specs: sr_eyeshadow, sr_clothes_inner, metal, sr_special, sr_stocking 材质预设
- Affected code:
  - [eyeshadow.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/eyeshadow.ts)
  - [clothes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/clothes.ts) (sr_clothes_inner)
  - [metal.ts](file:///e:/reze-engine/engine/src/shaders/materials/metal.ts)
  - [special.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/special.ts)
  - [stocking.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts)
  - [manifest.json](file:///e:/reze-engine/web/public/models/风堇/manifest.json)
  - [page.tsx](file:///e:/reze-engine/web/app/page.tsx) (材质预设映射)

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

### Requirement: 目影材质 (sr_eyeshadow)
当前实现输出固定灰色 (0.2214, 0.2214, 0.2214)。需通过 MCP 核对 Blender "目影"材质的实际颜色与 alpha 值，若不一致则修正。

### Requirement: 披风+材质 (sr_clothes_inner)
当前 `virtual_sun` 调用传零向量作为光线方向，导致光照完全错误。需修复为正确光照方向，并核对法线翻转逻辑是否与 Blender Backfacing 行为一致。

### Requirement: 金属部件材质
当前所有金属材质（衣金属/袖金属/帽金属/披风金属/挂金属/背金属/足金属/领金属/眼罩金属/口枷金属/金属）映射为 `sr_clothes`。需通过 MCP 核对 Blender 中这些材质的实际节点组，判断是否应使用 `metal` 预设或保持 `sr_clothes`。

### Requirement: 袖球材质
当前映射为 `sr_clothes`。需通过 MCP 核对 Blender "袖球"材质节点组，判断是否应使用 `sr_special` 或其他预设，并修正 shader 实现。

### Requirement: 白裤袜厚度
当前 `custom_thickness_curve` 将 bodyUvY 映射为递增厚度 (0.0625→1.85)，导致越往上越厚。用户反馈 Blender 中厚度均匀。需通过 MCP 核对 `UseCustomThickness` 标志与 Float Curve 实际值，修正为均匀厚度。
