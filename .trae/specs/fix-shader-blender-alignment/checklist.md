# Checklist

## 目影 (sr_eyeshadow)
- [x] 通过 MCP 查询 Blender "目影"材质节点树，记录 Transparent BSDF 颜色与 alpha
- [x] eyeshadow.ts 输出颜色与 Blender 一致
- [x] eyeshadow.ts alpha 值与 Blender 一致
- [x] docs/ 调试文档已更新目影部分

## 披风+ (sr_clothes_inner)
- [x] 通过 MCP 查询 Blender "披风+"材质节点组与法线处理
- [x] clothes.ts 中 sr_clothes_inner 的 virtual_sun 使用正确光照方向（非零向量）
- [x] 法线翻转逻辑与 Blender Backfacing 行为一致
- [x] docs/pijian-pifeng-debug.md 已更新

## 金属部件
- [x] 通过 MCP 查询 Blender 中所有金属材质（衣金属/袖金属/帽金属/披风金属/挂金属/背金属/足金属/领金属/眼罩金属/口枷金属/金属）的顶层节点组
- [x] manifest.json 中金属材质的 preset 映射与 Blender 节点组一致
- [x] page.tsx 中 setMaterialPresets 的金属映射与 manifest 一致
- [x] docs/ 调试文档已更新金属部分

## 袖球
- [x] 通过 MCP 查询 Blender "袖球"材质完整节点树
- [x] 袖球使用的 preset 与 Blender 节点组一致
- [x] special.ts（若使用）实现与 Blender 节点一致
- [x] docs/ 调试文档已更新袖球部分

## 白裤袜厚度
- [x] 通过 MCP 查询 Blender SockAIO.021 的 UseCustomThickness 与 Float Curve
- [x] stocking.ts 中厚度计算结果均匀（不随 bodyUvY 递增）
- [x] docs/stockings-alignment-debug.md 已更新

## 全节点深入检查
- [x] starrail_prelude.ts / starrail_nodes.ts 共享函数与 Blender 子组一致
- [x] common.ts 光照 uniform 与 Blender SunLight 设置一致
- [x] page.tsx sun 配置与 Blender 场景一致
- [x] 所有 5 个问题的修复均经 MCP 验证
