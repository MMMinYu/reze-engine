# Checklist

## Task 1: Blender 身体材质最终输出公式确认
- [x] 已查询 StarRailShader.身体变体_v17 组的 Group Output Result 输入链
- [x] 已递归追溯 Mix.001 的 A/B 输入到所有叶节点
- [x] 已确认 Color→Surface 隐式 Emission 包装（strength=1.0）
- [x] 已推导 Blender 最终公式（明确无 ambient 加法项）

## Task 2: 节点级数值化对比
- [x] 已选定参考 UV 点（中心 + 边缘）
- [x] 已在 Blender Python 计算 texColor → corrected 链路
- [x] 已计算 virtual_sun 输出
- [x] 已计算 ramp_lookup 输出
- [x] 已计算 nose_shadow 输出
- [x] 已合成最终输出并与引擎 body.ts 公式逐项对比

## Task 3: Ambient 补偿项重新评估
- [x] 已确认 Blender emission 公式中无等效 ambient 项
- [x] 已分析引擎 `+ ambient` 的来源（错误的 Cycles GI 假设）
- [x] 已确定正确处理方式：移除
- [x] 已量化移除后的亮度变化（材质输出降低 ~5-8%）

## Task 4: brightnessScale 语义验证
- [x] 已确认 Blender emission strength = 1.0
- [x] 已分析 `brightnessScale = sun.strength / 5.0` 的设计意图（历史遗留）
- [x] 已确定 brightnessScale 当前 = 1.0（no-op），应移除以消除歧义

## Task 5: ramp 采样精确度验证
- [x] 已查询 Blender ramp 子组完整节点链
- [x] 已确认 second_factor 二值逻辑（alpha > 0.10）
- [x] 已对比 _ramp_c1_lut 和 _ramp_c2_lut 21 点数据精度（误差 < 0.006）
- [x] 已量化 ramp 环节误差（可忽略）

## Task 6: EEVEE Next 色调映射链路验证
- [x] 已查询 EEVEE Next 色调映射实现（OCIO 2.4, Filmic + HC look）
- [x] 已确认 view_transform=Filmic + look=High Contrast 的 OCIO 链路结构
- [x] 已提取正确的 256 点 LUT 数据（通过 GroupTransform 手动构建 HC look 链路）
- [x] 已量化色调映射环节误差（0.02-0.12，偏暗根因 #1）

## Task 7: 综合根因排序与新对齐方案
- [x] 已汇总 Task 2-6 各环节误差并按影响排序（#1 LUT, #2 ambient, #3-5 可忽略）
- [x] 已设计新的精确对齐方案（LUT-Fix + Ambient-Remove，替代方案 C + E）
- [x] 已列出具体修改清单（composite.ts LUT 替换 + 5 处 ambient/brightnessScale 移除）
- [x] 已量化预期效果（修复后与 Blender 差异 0%）

## Task 8: 更新文档
- [x] 已在 docs/lighting-audit-debug.md 追加"第 0 节：最终根因定位与新对齐方案"
- [x] 已在 project_memory.md 更新 Filmic LUT 约束和 Sun strength 约束
- [x] 已在 audit-lighting-brightness-alignment/spec.md 顶部标注 OBSOLETE
