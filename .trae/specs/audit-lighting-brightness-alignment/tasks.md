# Tasks

- [x] Task 1: Blender 光照配置根本性差异确认
  - [x] SubTask 1.1: 通过 MCP 确认 Blender 场景两个 SunLight 的 energy 均为 0.0，记录 rotation_euler (60°, 0°, 20°) 和 color (1.0, 0.3849, 0.1631)
  - [x] SubTask 1.2: 通过 MCP 确认 World Background Color=(0.0508, 0.0508, 0.0508), Strength=1.0
  - [x] SubTask 1.3: 通过 MCP 确认 view_transform=Filmic, look=High Contrast, exposure=0.0, gamma=1.0, display_device=sRGB
  - [x] SubTask 1.4: 通过 MCP 确认 render engine=Cycles, samples=1, use_denoising=true, max_bounces=12
  - [x] SubTask 1.5: 记录 Blender 光照模型结论：无实际方向光，光照完全由材质内部"虚拟日光"节点组计算

- [x] Task 2: Body 材质逐节点审计 (StarRailShader.身体变体_v17)
  - [x] SubTask 2.1: 通过 MCP 查询"虚拟日光"子节点组内部实现，推导半兰伯特公式，对比引擎 virtual_sun() (starrail_nodes.ts 第 118-126 行)
  - [x] SubTask 2.2: 通过 MCP 查询"校色"子节点组内部实现（RGB Curves / HSV），对比引擎 _c_curve_lut (256 点 LUT)
  - [x] SubTask 2.3: 通过 MCP 查询"ramp"子节点组内部实现（Map Range 范围、ramp 纹理采样、RGB Curves），对比引擎 ramp_lookup() (starrail_nodes.ts 第 197-228 行)
  - [x] SubTask 2.4: 通过 MCP 查询"鼻尖阴影"和"SDF.tex"子节点组，对比引擎 sdf_face_shadow() 实现
  - [x] SubTask 2.5: 通过 MCP 查询"matcap"和"matcap.hair"子节点组，对比引擎 matcap 采样实现
  - [x] SubTask 2.6: 推导 Blender body 最终输出公式（校色 × ramp × 鼻尖阴影），对比引擎 body.ts 第 57-62 行 `(withShadow + ambient) × brightnessScale`
  - [x] SubTask 2.7: 列出 body 材质所有差异（公式/参数/顺序/缺失），标注严重程度和修复优先级

- [x] Task 3: Clothes 材质逐节点审计 (星铁@Minyu-Shader.clothes.001)
  - [x] SubTask 3.1: 通过 MCP 查询"虚拟日光.001"子节点组，对比引擎 virtual_sun() — 重点关注 pow 指数和 ILM green 门控
  - [x] SubTask 3.2: 通过 MCP 查询"布林冯光照模型.001"子节点组，对比引擎 blinn_phong() (starrail_nodes.ts 第 87-93 行) — 重点关注半向量 H = normalize(v+l) 还是 normalize(Incoming+SUN)
  - [x] SubTask 3.3: 通过 MCP 查询"校色.001"子节点组，对比引擎 _c_curve_lut
  - [x] SubTask 3.4: 通过 MCP 查询"ilm.clothes.001"子节点组，对比引擎 ILM 处理（Red/Green/Blue 通道用途）
  - [x] SubTask 3.5: 通过 MCP 查询"ramp.001"子节点组（Value=1.0, alpha=0.5），对比引擎 ramp_lookup() — 重点关注 second_curved 是 mix 还是嵌套
  - [x] SubTask 3.6: 通过 MCP 查询"smoothstep.001"子节点组（a=0,b=1 和 a=0.06,b=0.10 两组），对比引擎 smoothstep 实现
  - [x] SubTask 3.7: 通过 MCP 查询"matcap.001"和"matcap.hair.001"子节点组，对比引擎 matcap 实现
  - [x] SubTask 3.8: 推导 Blender clothes 最终输出公式（多层 Mix 链），对比引擎 clothes.ts 第 77-81 行 `(finalColor + ambient) × brightnessScale`
  - [x] SubTask 3.9: 列出 clothes 材质所有差异，标注严重程度和修复优先级

- [x] Task 4: Face 材质逐节点审计 (星铁@Minyu-Shader.face)
  - [x] SubTask 4.1: 通过 MCP 查询 face 节点组完整内部结构（19 节点 9 连接）
  - [x] SubTask 4.2: 通过 MCP 查询 face 的"虚拟日光"和"SDF"子节点组，对比引擎 face.ts + sdf_face_shadow()
  - [x] SubTask 4.3: 通过 MCP 查询 face 的"ramp"和"校色"子节点组，对比引擎实现
  - [x] SubTask 4.4: 推导 Blender face 最终输出公式，对比引擎 face.ts 第 50-58 行 `(withShadow + ambient) × brightnessScale`
  - [x] SubTask 4.5: 列出 face 材质所有差异，标注严重程度和修复优先级

- [x] Task 5: Hair 材质逐节点审计 (星铁@Minyu-Shader.hair)
  - [x] SubTask 5.1: 通过 MCP 查询 hair 节点组完整内部结构（25 节点 28 连接）
  - [x] SubTask 5.2: 通过 MCP 查询 hair 的"虚拟日光"、"布林冯光照模型"、"ramp.hair"、"ilm.hair"、"matcap.hair"子节点组
  - [x] SubTask 5.3: 对比引擎 hair.ts 第 122-135 行的 emissionColor + ambient + brightnessScale 链路
  - [x] SubTask 5.4: 列出 hair 材质所有差异，标注严重程度和修复优先级

- [x] Task 6: 后处理链路审计
  - [x] SubTask 6.1: 通过 MCP 查询 Blender 5.0 安装目录下 datafiles/colormanagement/filmic/ 的 .spi1d 文件，对比引擎 composite.ts 的 256 点 LUT 值
  - [x] SubTask 6.2: 验证 Blender exposure 应用顺序（Filmic 前还是后），对比引擎 composite.ts 第 78 行 `exposed = combined × exp2(exposure)` 后再 filmic()
  - [x] SubTask 6.3: 验证 Blender sRGB display 转换是否在引擎 composite.ts 末尾正确实现
  - [x] SubTask 6.4: 验证 Blender High Contrast look 是否已包含在引擎 256 点 LUT 中，还是需要单独步骤
  - [x] SubTask 6.5: 列出后处理链路所有差异，标注严重程度和修复优先级

- [x] Task 7: 整体亮度差异根因分析与精确对齐方案
  - [x] SubTask 7.1: 汇总 Task 2-6 的所有差异，按"致命/中等/轻微"分级
  - [x] SubTask 7.2: 针对每个致命差异，提出具体修复方案（公式修正、参数调整、链路重构）
  - [x] SubTask 7.3: 确定是否需要移除 brightnessScale 缩放（因 Blender 无外部 light strength）
  - [x] SubTask 7.4: 确定是否需要调整 ambient 项数值（Blender World Background 0.0508 vs 引擎 0.05）
  - [x] SubTask 7.5: 确定是否需要调整 sun.strength（Blender energy=0.0，但引擎需要非零值驱动 virtual_sun 方向）
  - [x] SubTask 7.6: 产出精确对齐方案文档，列出修改清单（文件、行号、旧值、新值、理由）

- [x] Task 8: 创建调试文档与最终报告
  - [x] SubTask 8.1: 创建 docs/lighting-audit-debug.md，记录所有 MCP 查询证据、Blender 公式、引擎公式、差异清单
  - [x] SubTask 8.2: 记录精确对齐方案，包括修改清单和预期效果
  - [x] SubTask 8.3: 更新 project_memory.md 中过时的信息（Filmic 公式、virtual_sun pow 指数等）

# Task Dependencies
- Task 1 必须最先完成（确认 Blender 光照模型根本性差异）
- Task 2-5 相互独立，可并行执行（均依赖 Task 1 完成）
- Task 6 独立于 Task 2-5，可并行执行
- Task 7 依赖 Task 2-6 全部完成（汇总所有差异）
- Task 8 依赖 Task 7 完成
