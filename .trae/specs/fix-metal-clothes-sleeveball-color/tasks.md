# Tasks

- [x] Task 1: 金属泛灰深入检查与修复
  - [x] SubTask 1.1: 通过 MCP 连接 Blender，查询"金属"材质的完整节点树（NPR 栈、Principled BSDF 参数、MixShader Factor、Voronoi 基色链、emission 强度）
  - [x] SubTask 1.2: 通过 MCP 查询所有金属类材质（衣金属/袖金属/帽金属/披风金属/挂金属/背金属/足金属/领金属/眼罩金属/口枷金属1/口枷金属2）的顶层节点组名，判断是否与"金属"使用同一节点组
  - [x] SubTask 1.3: 对比 metal.ts 与 Blender 节点树，定位泛灰根因（NPR emission 过强、MixShader 比例错误、Principled 反射不足、或应使用 sr_clothes 而非 metal）
  - [x] SubTask 1.4: 修复 metal.ts 或材质映射（可能涉及 metal.ts shader 修正、manifest.json preset 修改、page.tsx 映射调整）
  - [x] SubTask 1.5: 更新 docs/starrail-alignment-debug.md（金属部分）

- [x] Task 2: 外层衣服颜色对齐深入检查与修复
  - [x] SubTask 2.1: 修复 page.tsx 中 sun strength 7.25 → 5.0（brightnessScale 1.45 → 1.0）
  - [x] SubTask 2.2: 通过 MCP 核对 `星铁@Minyu-Shader.clothes.001` 中 Blinn-Phong 高光的半向量计算（Incoming+SUN vs L+V），修正 starrail_nodes.ts 中 blinn_phong 函数
  - [x] SubTask 2.3: 通过 MCP 核对 ramp.002 子组中 RGB Curves 的 Factor 值（连续 vs 二值），修正 ramp_lookup 中 second_factor 逻辑
  - [x] SubTask 2.4: 通过 MCP 核对 second_curved 是 mix(first, c2(first), factor) 还是 c2(first) 嵌套，修正 ramp_lookup 实现
  - [x] SubTask 2.5: 逐节点完整对比 clothes.ts 与 Blender 节点树，确认无遗漏（移除 matcap、添加 smoothstep/tint/Blinn-Phong specular）
  - [x] SubTask 2.6: 更新 docs/starrail-alignment-debug.md（衣服部分）

- [x] Task 3: 袖球颜色对齐深入检查与修复
  - [x] SubTask 3.1: 通过 MCP 查询 Blender "袖球"材质的完整节点树（所有节点、参数、连接关系）
  - [x] SubTask 3.2: 逐节点对比 special.ts 与 Blender 节点树（降饱和参数、Sphere UV 计算、增亮 MapRange、乘法合成、输出方式）
  - [x] SubTask 3.3: 检查 special.ts 是否缺少光照或亮度缩放（Blender 中是否真的无光照 emission）
  - [x] SubTask 3.4: 修复 special.ts 实现（完全重写 + 修复 blinn_phong pow 缺失 + manifest.json 贴图修正）
  - [x] SubTask 3.5: 更新 docs/starrail-alignment-debug.md（袖球部分）

- [x] Task 4: 全局验证与回归检查
  - [x] SubTask 4.1: 确认 sun strength=5.0 后所有材质亮度无回归（同时修复 sun direction 匹配 Blender）
  - [x] SubTask 4.2: 确认 metal/sr_clothes/sr_special 修复后与 Blender 视觉一致（代码层面，待运行时验证）
  - [x] SubTask 4.3: `npm run clean && npm run build` 验证编译通过
  - [x] SubTask 4.4: 汇总所有修改到调试文档

# Task Dependencies
- Task 1-3 相互独立，可并行执行（均依赖 Blender MCP）
- Task 4 依赖 Task 1-3 完成
