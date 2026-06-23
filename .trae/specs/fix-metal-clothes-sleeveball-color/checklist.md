# Checklist

## 金属泛灰
- [ ] 通过 MCP 查询 Blender "金属"材质完整节点树（NPR 栈、Principled BSDF、MixShader、Voronoi、emission）
- [ ] 通过 MCP 查询所有金属类材质的顶层节点组名，确认是否使用同一节点组
- [ ] metal.ts 的 NPR emission 强度与 Blender 一致
- [ ] metal.ts 的 MixShader Factor 与 Blender 一致
- [ ] metal.ts 的 Principled BSDF 参数（metallic/roughness/specular）与 Blender 一致
- [ ] metal.ts 的 Voronoi 基色链与 Blender 一致
- [ ] 金属材质的 preset 映射（metal vs sr_clothes）与 Blender 节点组一致
- [ ] manifest.json 和 page.tsx 中金属材质映射一致
- [ ] docs/starrail-alignment-debug.md 已更新金属部分

## 外层衣服颜色
- [ ] page.tsx sun strength 已修复为 5.0
- [ ] 通过 MCP 核对 Blinn-Phong 半向量计算（Incoming+SUN vs L+V）
- [ ] starrail_nodes.ts 中 blinn_phong 函数与 Blender 一致
- [ ] 通过 MCP 核对 ramp_lookup 的 Factor 是连续值还是二值
- [ ] 通过 MCP 核对 second_curved 是混合还是嵌套
- [ ] ramp_lookup 实现与 Blender 一致
- [ ] clothes.ts 逐节点与 Blender 节点树对比无遗漏
- [ ] docs/starrail-alignment-debug.md 已更新衣服部分

## 袖球颜色
- [ ] 通过 MCP 查询 Blender "袖球"材质完整节点树
- [ ] special.ts 降饱和参数与 Blender 一致
- [ ] special.ts Sphere UV 计算与 Blender 一致
- [ ] special.ts 增亮 MapRange 参数与 Blender 一致
- [ ] special.ts 乘法合成与输出方式与 Blender 一致
- [ ] special.ts 光照/亮度处理与 Blender 一致
- [ ] docs/starrail-alignment-debug.md 已更新袖球部分

## 全局验证
- [ ] sun strength=5.0 后所有材质亮度无回归
- [ ] `npm run clean && npm run build` 编译通过
- [ ] 所有修复均经 MCP 验证
