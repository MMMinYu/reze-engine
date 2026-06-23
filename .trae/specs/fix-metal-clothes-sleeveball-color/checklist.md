# Checklist

## 金属泛灰
- [x] 通过 MCP 查询 Blender "金属"材质完整节点树（NPR 栈、Principled BSDF、MixShader、Voronoi、emission）
- [x] 通过 MCP 查询所有金属类材质的顶层节点组名，确认是否使用同一节点组
- [x] metal.ts 的 NPR emission 强度与 Blender 一致（MCP 验证：Blender 中无 Principled BSDF/Voronoi/NPR emission，metal.ts 实现了不存在的节点树）
- [x] metal.ts 的 MixShader Factor 与 Blender 一致（MCP 验证：Blender 中无 MixShader）
- [x] metal.ts 的 Principled BSDF 参数（metallic/roughness/specular）与 Blender 一致（MCP 验证：Blender 中无 Principled BSDF）
- [x] metal.ts 的 Voronoi 基色链与 Blender 一致（MCP 验证：Blender 中无 Voronoi）
- [x] 金属材质的 preset 映射（metal vs sr_clothes）与 Blender 节点组一致（"金属"使用 StarRail clothes 节点组，归入 sr_clothes）
- [x] manifest.json 和 page.tsx 中金属材质映射一致（page.tsx 已将"金属"移至 sr_clothes，manifest.json 已是 sr_clothes）
- [x] docs/starrail-alignment-debug.md 已更新金属部分

## 外层衣服颜色
- [x] page.tsx sun strength 已修复为 5.0
- [x] 通过 MCP 核对 Blinn-Phong 半向量计算（Incoming+SUN vs L+V）
- [x] starrail_nodes.ts 中 blinn_phong 函数与 Blender 一致（H = normalize(l - v)，返回 dot(N,H) 无 pow）
- [x] 通过 MCP 核对 ramp_lookup 的 Factor 是连续值还是二值（确认为二值 GREATER_THAN）
- [x] 通过 MCP 核对 second_curved 是混合还是嵌套（确认为嵌套 c2(first)）
- [x] ramp_lookup 实现与 Blender 一致（无需修改，仅更新注释）
- [x] clothes.ts 逐节点与 Blender 节点树对比无遗漏（移除 matcap、添加 smoothstep/tint/Blinn-Phong specular）
- [x] docs/starrail-alignment-debug.md 已更新衣服部分

## 袖球颜色
- [x] 通过 MCP 查询 Blender "袖球"材质完整节点树
- [x] special.ts 降饱和参数与 Blender 一致（Hue=0.5, Sat=0.9, Val=1.0, Fac=1.0）
- [x] special.ts Sphere UV 计算与 Blender 一致（Normal → VECT_TRANSFORM → Mapping）
- [x] special.ts 增亮 MapRange 参数与 Blender 一致（0→0.42, 1→4.75）
- [x] special.ts 乘法合成与输出方式与 Blender 一致（MULTIPLY + clothes 管线 + brightnessScale）
- [x] special.ts 光照/亮度处理与 Blender 一致（添加完整 clothes 着色管线 + brightnessScale）
- [x] docs/starrail-alignment-debug.md 已更新袖球部分
- [x] manifest.json 袖球 color 贴图已修正（衣.png → Avatar_Hyacine_00_Body_Color_A_L.png）
- [x] special.ts blinn_phong pow 缺失已修复

## 全局验证
- [x] sun strength=5.0 后所有材质亮度无回归
- [x] sun direction 已修复匹配 Blender（(-0.296, -0.500, 0.814)）
- [x] `npm run clean && npm run build` 编译通过
- [x] 所有修复均经 MCP 验证
