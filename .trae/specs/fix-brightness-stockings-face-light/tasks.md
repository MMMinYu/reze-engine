# Tasks

- [ ] Task 1: 整体提亮 — Blender 亮度配置核对与修复
  - [x] SubTask 1.1: 通过 MCP 连接 Blender，查询场景 SunLight 的 strength/color、World 的 ambient color/strength、View 的 exposure、Color Management 的 look/view_transform
  - [x] SubTask 1.2: 对比引擎 page.tsx 中 `sun.strength=5.0`、`world.color=(0.05,0.05,0.05)`、`world.strength=1.0`、`view.exposure=0.0` 与 Blender 实际值，记录差异
  - [x] SubTask 1.3: 核对各 sr_* 材质的 `brightnessScale = light.lights[0].color.w / 5.0` 基准是否合理（5.0 是否匹配 Blender）
  - [x] SubTask 1.4: 核对 composite.ts 中 Filmic LUT + exposure 应用链是否与 Blender Color Management 一致
  - [x] SubTask 1.5: 根据差异修正 sr_* shader 添加 ambient 项（Blender Cycles 间接光照补偿）
  - [x] SubTask 1.6: 更新 docs/ 调试文档（亮度部分）

- [ ] Task 2: 丝袜材质流程对齐 — Blender SockAIO.021 完整核对
  - [x] SubTask 2.1: 移除 stocking.ts 末尾 DEBUG 测试代码（第 480-488 行），恢复真实着色输出
  - [x] SubTask 2.2: 通过 MCP 逐节点核对 Blender `SockAIO.021` 完整节点树（81 节点，含 SockV3.027、ThighhighsInfoGen.023、PantyhoseThicknessSelector.023、ViewDependentCoverage.028、AdjustCellUV.028、BuildCellUV.028、MappingSDF.028、UVByRatio.028 子组）
  - [x] SubTask 2.3: 列出 engine stocking.ts 与 Blender 所有不一致的公式/节点连接/贴图绑定，明确告知用户缺什么文件/公式
  - [x] SubTask 2.4: 修复 noise3d_fixed TEMP 代码，使用实际 noise3d 值
  - [x] SubTask 2.5: 核对 manifest.json 中丝袜材质的贴图路径与 uniforms 值是否与 Blender 一致
  - [ ] SubTask 2.6: 实现各向异性高光（Direction 贴图驱动）— 需扩展 eval_principled 支持 anisotropic
  - [x] SubTask 2.7: 更新 docs/stockings-alignment-debug.md

- [x] Task 3: 脸部光照方向对齐 — SDF 坐标转换核对
  - [x] SubTask 3.1: 通过 MCP 核对 Blender `星铁@Minyu-Shader.face` 中 SDF 子组的 SUN 方向来源（几何节点 SUN 属性 vs 灯光方向）
  - [x] SubTask 3.2: 通过 MCP 查询 PMX 中 faceFront/faceRight/faceUp 的实际值与坐标空间（MMD Y-up 还是 Blender Z-up）
  - [x] SubTask 3.3: 核对 starrail_nodes.ts 中 `sdf_face_shadow` 的转换公式 `vec3f(faceFront.x, faceFront.z, -faceFront.y)` 是否正确（对比项目记忆中 (x,z,y) 无取负的约定）
  - [x] SubTask 3.4: 核对 face.ts 中 `let l = -light.lights[0].direction.xyz` 与 body.ts/clothes.ts 的 SUN 方向是否一致
  - [x] SubTask 3.5: 修复坐标转换公式，确保脸部 SDF 阴影方向与身体/衣服/头发的 virtual_sun 方向一致
  - [x] SubTask 3.6: 更新 docs/ 调试文档（脸部光照方向部分）

# Task Dependencies
- Task 1-3 相互独立，可并行执行（均依赖 Blender MCP）
- Task 2 的 SubTask 2.1（移除 DEBUG）应在 SubTask 2.2-2.4 之前完成，避免 DEBUG 代码干扰核对
