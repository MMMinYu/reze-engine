# 整体提亮 / 丝袜流程对齐 / 脸部光照方向修复 Spec

## Why

用户观察到三个渲染问题：
1. 引擎整体渲染偏暗，需要对照 Blender 确定提亮幅度
2. 丝袜材质（sr_stocking）渲染流程与 Blender 不一致，当前 stocking.ts 末尾有 DEBUG 测试代码（输出固定 testFW/testResult），未走真实着色管线
3. 脸部 SDF 阴影光照方向与身体/衣服/头发不一致，怀疑 face.ts 中 Z-up→Y-up 坐标转换公式错误

## What Changes

- **整体提亮**：通过 MCP 连接 Blender，核对 Blender 场景的 SunLight Strength、World ambient、Exposure、Color Management 设置；与引擎 page.tsx 中 `sun.strength=5.0`、`world.color=(0.05,0.05,0.05)`、`view.exposure=0.0` 对比，确定提亮来源（可能是 sun strength、ambient、exposure 或 brightnessScale 基准）
- **丝袜流程对齐**：通过 MCP 逐节点核对 Blender `SockAIO.021` 完整节点树与 engine `stocking.ts` 实现，列出所有缺失的文件/公式/节点连接，移除 DEBUG 测试代码，按 Blender 流程完整实现
- **脸部光照方向**：通过 MCP 核对 Blender `星铁@Minyu-Shader.face` 中 SDF 子组的 SUN 方向来源，以及 faceFront/faceRight/faceUp 的坐标空间；核对 face.ts 中 `vec3f(faceFront.x, faceFront.z, -faceFront.y)` 转换公式是否与 body/clothes 使用的 `-light.lights[0].direction.xyz` 一致
- 每个问题修复后更新对应的 docs/ 调试记录文档

## Impact

- Affected specs: 全局亮度配置、sr_stocking 材质预设、sr_face 材质预设
- Affected code:
  - [page.tsx](file:///e:/reze-engine/web/app/page.tsx) — sun strength / world / exposure 配置
  - [engine.ts](file:///e:/reze-engine/engine/src/engine.ts) — 默认亮度参数、composite tone mapping
  - [composite.ts](file:///e:/reze-engine/engine/src/shaders/passes/composite.ts) — Filmic + exposure 应用
  - [stocking.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts) — 丝袜完整流程实现
  - [face.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/face.ts) — 脸部 SDF 光照方向
  - [starrail_nodes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/starrail_nodes.ts) — `sdf_face_shadow` 坐标转换
  - [manifest.json](file:///e:/reze-engine/web/public/models/风堇/manifest.json) — 丝袜贴图/uniforms 配置

## ADDED Requirements

### Requirement: Blender MCP 验证
所有涉及 Blender/PMX 模型数据、材质设置的结论，必须通过 MCP 连接 Blender 验证，不得凭猜测下结论。每个问题的根因分析必须有 MCP 查询证据支撑。

#### Scenario: 验证场景亮度配置
- **WHEN** 检查 Blender 场景的亮度设置
- **THEN** 通过 `execute_blender_code` 查询 SunLight strength、World ambient、View exposure、Color Management look
- **AND** 记录查询结果到调试文档

### Requirement: 调试文档记录
复杂调试任务必须在 docs/ 创建调试记录文档，每步修改后更新文档。

#### Scenario: 修改 shader 代码
- **WHEN** 修改任何 shader 代码以修复对齐问题
- **THEN** 在对应调试文档记录：问题、MCP 查询证据、根因、修复内容、验证结果

## MODIFIED Requirements

### Requirement: 整体提亮
当前引擎 `sun.strength=5.0`、`world.color=(0.05,0.05,0.05)`、`view.exposure=0.0`。各 sr_* 材质用 `brightnessScale = light.lights[0].color.w / 5.0` 归一化。需通过 MCP 核对 Blender 实际 SunLight strength、World ambient strength、View exposure，确定引擎应使用的提亮参数。可能的修复点：
1. page.tsx 的 sun.strength 值
2. page.tsx 的 world.color / world.strength
3. page.tsx 的 view.exposure
4. 各 sr_* 材质的 brightnessScale 基准（当前 /5.0）
5. composite.ts 的 Filmic LUT 或 exposure 应用

### Requirement: 丝袜材质 (sr_stocking) 流程对齐
当前 [stocking.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts) 末尾（第 480-488 行）有 DEBUG 测试代码，直接输出 `vec4f(testFW, testResult, scaledFiberWidth * 100.0, 1.0)`，未走真实着色管线。需：
1. 移除 DEBUG 测试代码，恢复真实着色输出
2. 通过 MCP 逐节点核对 Blender `SockAIO.021` 完整节点树（含 SockV3.027、ThighhighsInfoGen.023、PantyhoseThicknessSelector.023、ViewDependentCoverage.028 等子组）
3. 列出所有与 Blender 不一致的公式/节点连接/贴图绑定
4. 按 Blender 流程完整实现，缺什么文件/公式明确告知用户

### Requirement: 脸部光照方向 (sr_face) 对齐
当前 [face.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/face.ts) 第 31 行使用 `let l = -light.lights[0].direction.xyz;` 作为 SDF 的 sun 参数。`sdf_face_shadow` 函数（starrail_nodes.ts 第 262-278 行）将 faceFront/faceRight 从 Z-up 转为 Y-up 时使用 `vec3f(faceFront.x, faceFront.z, -faceFront.y)` 公式（含 Y 轴取负）。而 body.ts/clothes.ts 直接用 `-light.lights[0].direction.xyz` 作为 SUN（已是 Y-up）。需通过 MCP 核对：
1. Blender 中 SDF 子组的 SUN 方向来源（几何节点修改器输出的 SUN 属性 vs 直接用灯光方向）
2. faceFront/faceRight/faceUp 在 PMX 中的实际值与坐标空间（MMD Y-up 还是 Blender Z-up）
3. `vec3f(faceFront.x, faceFront.z, -faceFront.y)` 转换公式是否正确（项目记忆中坐标转换为 (x,z,y) 无取负）
4. 修复后确保脸部 SDF 阴影方向与身体/衣服/头发的 virtual_sun 方向一致
