# Tasks

- [x] Task 1: 目影 (sr_eyeshadow) 颜色对齐
  - [x] SubTask 1.1: 通过 MCP 连接 Blender，查询"目影"材质的完整节点树（Transparent BSDF 颜色、alpha、Material Output 连接）
  - [x] SubTask 1.2: 对比 engine 中 eyeshadow.ts 的固定灰色 (0.2214) 与 Blender 实际值，记录差异
  - [x] SubTask 1.3: 修正 eyeshadow.ts 中的颜色/alpha 值（MCP 渲染测试证明 Transparent BSDF 是纯乘法暗化，src=0, alpha=0.7786）
  - [x] SubTask 1.4: 更新 docs/ 调试文档（目影部分）

- [x] Task 2: 披风+ (sr_clothes_inner) 光照修复
  - [x] SubTask 2.1: 通过 MCP 查询 Blender "披风+"材质的节点组（星铁@Minyu-Shader.clothes.001），核对法线/Backfacing 处理
  - [x] SubTask 2.2: 定位 clothes.ts 中 `virtual_sun(n, vec3f(0.0), ilmGreen)` 零向量 bug，修复为正确光照方向
  - [x] SubTask 2.3: 核对法线翻转逻辑 (`n = -normalize(input.normal)`) 是否与 Blender 行为一致
  - [x] SubTask 2.4: 更新 docs/pijian-pifeng-debug.md

- [x] Task 3: 金属部件颜色对齐
  - [x] SubTask 3.1: 通过 MCP 查询 Blender 中"衣金属/袖金属/帽金属/披风金属/金属"等材质的顶层节点组
  - [x] SubTask 3.2: 判断这些材质应使用 `metal` 预设还是 `sr_clothes`，记录每个材质的 Blender 节点组名
  - [x] SubTask 3.3: 若需修改，更新 manifest.json 中的 preset 映射和 page.tsx 中的 setMaterialPresets
  - [x] SubTask 3.4: 更新 docs/ 调试文档（金属部分）

- [x] Task 4: 袖球材质对齐
  - [x] SubTask 4.1: 通过 MCP 查询 Blender "袖球"材质的完整节点树（节点组名、贴图连接、参数）
  - [x] SubTask 4.2: 判断应使用 `sr_special`、`sr_clothes` 还是其他预设，记录依据
  - [x] SubTask 4.3: 若 sr_special 需细化，根据 Blender 节点修正 special.ts 实现
  - [x] SubTask 4.4: 更新 manifest.json 和 page.tsx 中的映射（如需）
  - [x] SubTask 4.5: 更新 docs/ 调试文档（袖球部分）

- [x] Task 5: 白裤袜厚度均匀化
  - [x] SubTask 5.1: 通过 MCP 查询 Blender SockAIO.021 中 `UseCustomThickness` 标志值与 `CustomThickness` Float Curve 的实际曲线点
  - [x] SubTask 5.2: 核对 PantyhoseThicknessSelector.023 子组的逻辑，确认 Pantyhose 模式下厚度是否应为常量
  - [x] SubTask 5.3: 修正 stocking.ts 中 `custom_thickness_curve` 或 `UseCustomThickness` 逻辑，使厚度均匀
  - [x] SubTask 5.4: 更新 docs/stockings-alignment-debug.md

- [x] Task 6: 全节点深入检查（不漏过细节）
  - [x] SubTask 6.1: 对 5 个问题涉及的每个材质，逐节点核对 Blender 节点树与 engine shader 代码
  - [x] SubTask 6.2: 检查 starrail_prelude.ts、starrail_nodes.ts 中的共享函数（color_correct、ilm_decode、virtual_sun、ramp_lookup、matcap_sample）是否与 Blender 子组一致
  - [x] SubTask 6.3: 检查 common.ts 中的光照 uniform（light.lights[0].direction/color）是否与 Blender SunLight 设置一致
  - [x] SubTask 6.4: 检查 page.tsx 中 sun 配置 (strength=7.25, direction=(-0.296,-0.500,0.814)) 是否与 Blender 场景一致
  - [x] SubTask 6.5: 汇总所有发现到调试文档

# Task Dependencies
- Task 1-5 相互独立，可并行执行（均依赖 Blender MCP）
- Task 6 依赖 Task 1-5 的 MCP 查询结果，在 Task 1-5 完成后执行汇总检查
