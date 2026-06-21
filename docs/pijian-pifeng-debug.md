# 披肩/披風渲染调试记录

> 本文档记录披肩+/披風+ 渲染异常的调查过程。每步修改后必须更新本文档。

## 问题描述

- 披肩+、披風+ 全黑色
- 披肩 闪面（z-fighting）

## 已确认的事实 (MCP 验证)

### Blender 场景材质设置

| Material | blend_method | use_backface_culling | show_transparent_back | EEVEE通道 | depthWrite |
|----------|-------------|---------------------|----------------------|-----------|-----------|
| 披肩 | HASHED | True | True | Opaque | ON |
| 披肩+ | HASHED | True | True | Opaque | ON |
| 披風 | BLEND | True | False | Transparent | OFF |
| 披風+ | BLEND | True | False | Transparent | OFF |

### PMX 导出材质 (actual_)

| Material | blend_method |
|----------|-------------|
| actual_披肩 | HASHED |
| actual_披肩+ | BLEND |
| actual_披風 | BLEND |
| actual_披風+ | HASHED |

> 注意：PMX 导出材质的 blend_mode 与场景材质**不一致**（mmd_tools 转换导致）。

### 几何关系

- 所有材质在同一个 mesh 对象 `星铁@Minyu-风堇` 上
- 披肩: slot 49, 506 triangles
- 披肩+: slot 50, 506 triangles（与披肩不同三角，仅 16/502 精确匹配顶点）
- 披風+: slot 52, 428 triangles
- 披風: slot 53, 428 triangles
- 披風金属: slot 54, 680 triangles

### Shader

- `actual_披肩` ~ `actual_披風+` 都使用 `mmd_shader` 节点组
- `mmd_shader` 包含 Geometry 节点（Backfacing 可用）
- StarRail clothes 节点组 `星铁@Minyu-Shader.clothes.001` 无 Geometry/Backfacing 节点

## 已尝试的方案

| # | sr_clothes | sr_clothes_inner | 结果 |
|---|-----------|-----------------|------|
| 1 | cull=front, dw=true | cull=back, dw=true, depthBias=0.001 | 披風+ 全黑（原始代码） |
| 2 | cull=front, dw=true | cull=none, dw=true | 反的 |
| 3 | cull=front, dw=true | cull=back, dw=true（no bias） | 反的 |
| 4 | cull=front, dw=true | cull=none, dw=true + frontFacing | 反的 |
| 5 | cull=front, dw=true | cull=none, dw=true + n=-n | 反的 |
| 6 | cull=none, dw=true | cull=none, dw=true | 混在一起 |
| 7 | cull=front, dw=true | cull=front, dw=false | 披風+ 黑色 |
| 8 | cull=front, dw=false | cull=front, dw=false | 全身异常（回退） |

> 说明：方案 1-5 未验证是否真正生效（sync-engine 问题导致 dist 未同步到 node_modules）。
> 方案 6-8 已验证生效。

## 当前状态

- `sr_clothes`: cullMode="front", depthWriteEnabled=true
- `sr_clothes_inner`: cullMode="front", depthWriteEnabled=false
- 全身材质正常，披風+ 仍显示黑色

## 待调查

1. ~~披風+ 和 披風三角形实际空间位置关系~~ → **已确认：完全共面，距离 0.000，法线相反，顶点 0 共享**
2. 披風+ 的 actual_ 材质贴图是否正确
3. 渲染顺序是否导致披風遮挡披風+

---

## Step 1 结论 (MCP 验证)

披風+(slot 52) 和披風(slot 53) 的空间关系：
- 三角数量：各 428，一一对应
- 三角中心距离：min=0.0, max=0.0, avg=0.0 → **完全共面**
- 法线方向：50/50 全部 **相反** (dot < -0.9)
- 共享顶点：0 → 各自独立顶点

**根因分析：** 披風+ 的法线指向体内。引擎 `cullMode="front"` 渲染 CW 面，法线朝内 → NPR shader `dot(N, L)` 为负 → **输出黑色**。

**方案：** 披風+ 需用 `cullMode="back"` 渲染 CCW 面，且翻转法线 `n = -n`。

## Step 2：渲染顺序问题

披風+ (slot 52) 在 PMX 中先于披風 (slot 53)，同为 opaque → 披風+ 先画，披風后画覆盖。

**根因3：** depthBias 无法消除完全共面的深度精度 z-fighting。

**方案：** `depthCompare="always"` 无条件通过深度测试，配合排序披風+ 后在披風上绘制。

## 最终方案 (已验证)

| 配置项 | sr_clothes (披風/披肩) | sr_clothes_inner (披風+/披肩+) |
|--------|----------------------|---------------------------|
| cullMode | front | front |
| depthWrite | true | true |
| depthCompare | less-equal | less-equal |
| depthBias | 无 | -10, slopeScale=-1, clamp=-0.0001 |
| shader normal | `n = normalize` | `n = -normalize` |
| render order | rank 0 | rank 1 (在 clothes 之后) |

**根因总结：**
1. 披風+ 法线指向体内，需翻转法线
2. 披風+ 与披風共面但三角顶点不同 → 深度插值差异 → z-fighting
3. depthBias=-10 clamp=-0.0001 刚好克服插值差异

## 后续改进

引擎忽略 PMX 双面标记 (`flag & 0x01`) 和 mmd_tools 导出的 `blend_method`。最佳实践应读取这些数据动态决定 cullMode，而非硬编码。

- [ ] 读取 PMX `flag & 0x01` 双面标记，为标记材质使用 cullMode="none"
- [ ] 读取 actual_ 材质 blend_method，BLEND 模式走透明渲染通道
- [ ] **纹理 alpha 镂空支持**：结花边使用 `衣.png`（`alpha_mode=STRAIGHT`），`Base Alpha` 链接到纹理 alpha 通道用于镂空（lace cutouts）。引擎 ignore 纹理 alpha → 镂空区域不透明。结花边+ 若用 depthBias 会填充镂空区域为白色。需引擎支持 texture alpha discard/blend。
- [ ] 所有 `+` 材质（衣1+、袖+、裙+、裙1+、帽结+、头饰+、蝴蝶结+、结花边+、披肩+、披风+）现用 sr_clothes_inner + depthBias 补丁，应迁移到上述最佳实践
- [ ] 髪+ 法线也相反（samples: 1/10 opposite），现用 sr_hair cullMode="none" 双面渲染遮住了问题，应迁移到最佳实践
- [ ] **蝴蝶结+ 特殊处理**：薄片几何（260 tri 完全共面），sr_clothes 和 sr_clothes_inner 都无法完美处理。保持 sr_clothes，z-fighting 仅边缘角度可见。需引擎级 PMX flag 读取或 per-material depthCompare 控制
