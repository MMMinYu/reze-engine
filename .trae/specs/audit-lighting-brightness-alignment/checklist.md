# Checklist

## Task 1: Blender 光照配置根本性差异确认
- [x] 已通过 MCP 确认两个 SunLight energy 均为 0.0
- [x] 已记录 SunLight rotation_euler (60°, 0°, 20°) 和 color (1.0, 0.3849, 0.1631)
- [x] 已通过 MCP 确认 World Background Color=(0.0508, 0.0508, 0.0508), Strength=1.0
- [x] 已通过 MCP 确认 view_transform=Filmic, look=High Contrast, exposure=0.0, gamma=1.0
- [x] 已通过 MCP 确认 display_device=sRGB
- [x] 已通过 MCP 确认 render engine=Cycles, samples=1, use_denoising=true, max_bounces=12
- [x] 已记录结论：Blender 无实际方向光，光照完全由材质内部"虚拟日光"节点组计算

## Task 2: Body 材质逐节点审计
- [x] 已查询"虚拟日光"子节点组内部实现并推导半兰伯特公式
- [x] 已对比引擎 virtual_sun() (starrail_nodes.ts 第 118-126 行)，列出差异
- [x] 已查询"校色"子节点组内部实现（RGB Curves / HSV）
- [x] 已对比引擎 _c_curve_lut (256 点 LUT)，列出差异
- [x] 已查询"ramp"子节点组内部实现（Map Range、ramp 纹理、RGB Curves）
- [x] 已对比引擎 ramp_lookup() (starrail_nodes.ts 第 197-228 行)，列出差异
- [x] 已查询"鼻尖阴影"和"SDF.tex"子节点组
- [x] 已对比引擎 sdf_face_shadow() 实现，列出差异
- [x] 已查询"matcap"和"matcap.hair"子节点组
- [x] 已对比引擎 matcap 采样实现，列出差异
- [x] 已推导 Blender body 最终输出公式
- [x] 已对比引擎 body.ts 第 57-62 行 `(withShadow + ambient) × brightnessScale`
- [x] 已列出 body 材质所有差异（公式/参数/顺序/缺失），标注严重程度和修复优先级

## Task 3: Clothes 材质逐节点审计
- [x] 已查询"虚拟日光.001"子节点组并对比引擎 virtual_sun()
- [x] 已查询"布林冯光照模型.001"子节点组并对比引擎 blinn_phong()（重点：半向量 H 计算）
- [x] 已查询"校色.001"子节点组并对比引擎 _c_curve_lut
- [x] 已查询"ilm.clothes.001"子节点组并对比引擎 ILM 处理
- [x] 已查询"ramp.001"子节点组并对比引擎 ramp_lookup()（重点：second_curved mix vs 嵌套）
- [x] 已查询"smoothstep.001"子节点组（两组参数）并对比引擎 smoothstep
- [x] 已查询"matcap.001"和"matcap.hair.001"子节点组并对比引擎 matcap
- [x] 已推导 Blender clothes 最终输出公式（多层 Mix 链）
- [x] 已对比引擎 clothes.ts 第 77-81 行 `(finalColor + ambient) × brightnessScale`
- [x] 已列出 clothes 材质所有差异，标注严重程度和修复优先级

## Task 4: Face 材质逐节点审计
- [x] 已查询 face 节点组完整内部结构（19 节点 9 连接）
- [x] 已查询 face 的"虚拟日光"和"SDF"子节点组并对比引擎 face.ts + sdf_face_shadow()
- [x] 已查询 face 的"ramp"和"校色"子节点组并对比引擎实现
- [x] 已推导 Blender face 最终输出公式
- [x] 已对比引擎 face.ts 第 50-58 行 `(withShadow + ambient) × brightnessScale`
- [x] 已列出 face 材质所有差异，标注严重程度和修复优先级

## Task 5: Hair 材质逐节点审计
- [x] 已查询 hair 节点组完整内部结构（25 节点 28 连接）
- [x] 已查询 hair 的"虚拟日光"、"布林冯光照模型"、"ramp.hair"、"ilm.hair"、"matcap.hair"子节点组
- [x] 已对比引擎 hair.ts 第 122-135 行的 emissionColor + ambient + brightnessScale 链路
- [x] 已列出 hair 材质所有差异，标注严重程度和修复优先级

## Task 6: 后处理链路审计
- [x] 已查询 Blender 5.0 .spi1d 文件并对比引擎 composite.ts 的 256 点 LUT 值
- [x] 已验证 Blender exposure 应用顺序并对比引擎 composite.ts 第 78 行
- [x] 已验证 Blender sRGB display 转换是否在引擎 composite.ts 末尾正确实现
- [x] 已验证 Blender High Contrast look 是否已包含在引擎 256 点 LUT 中
- [x] 已列出后处理链路所有差异，标注严重程度和修复优先级

## Task 7: 整体亮度差异根因分析与精确对齐方案
- [x] 已汇总 Task 2-6 的所有差异，按"致命/中等/轻微"分级
- [x] 已针对每个致命差异提出具体修复方案（公式修正、参数调整、链路重构）
- [x] 已确定是否需要移除 brightnessScale 缩放
- [x] 已确定是否需要调整 ambient 项数值
- [x] 已确定是否需要调整 sun.strength
- [x] 已产出精确对齐方案文档，列出修改清单（文件、行号、旧值、新值、理由）

## Task 8: 创建调试文档与最终报告
- [x] 已创建 docs/lighting-audit-debug.md
- [x] 已记录所有 MCP 查询证据、Blender 公式、引擎公式、差异清单
- [x] 已记录精确对齐方案，包括修改清单和预期效果
- [x] 已更新 project_memory.md 中过时的信息（Filmic 公式、virtual_sun pow 指数等）

## Task 9: MCP 复核与重大修正（2026-06-24 新增）
- [x] 已确认 Blender 渲染引擎 = EEVEE Next（非 Cycles）
- [x] 已确认场景无任何 Light 对象（0 个，不是 energy=0）
- [x] 已确认场景无相机（.blend 仅用于材质编辑）
- [x] 已确认身体材质 = StarRailShader.身体变体_v17（与 sr_body 对应）
- [x] 已确认 emission 材质不接收 GI bounce（PBR 定义）
- [x] 已确认 HSV V 通道不 clamp（引擎和 Blender 一致）
- [x] 已确认校色环节引擎和 Blender 输出一致（中心点 corrected=(1.641, 1.019, 0.942)）
- [x] 已修正 lighting-audit-debug.md 中的错误结论
- [x] 已修正 project_memory.md 中的过时约束
- [x] 已标记初版"Cycles 1.9375x 增益"和"方案 C"为 OBSOLETE
