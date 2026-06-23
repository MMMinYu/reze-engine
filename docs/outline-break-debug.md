# 边缘线断裂调试记录

## 问题现象
- **Blender**：描边均匀连续，所有启用 edge 的材质边界都有完整线条
- **引擎**：描边时断时续，部分区域缺失

## Blender 端验证结果（2026-06-22）

### 模型信息
- 对象：`星铁@Minyu-风堇`
- 顶点数：69933，面数：103549
- 材质槽：78，材质总数：149

### Edge 材质配置
| 项目 | 值 |
|------|-----|
| 启用 edge 的材质数 | 32 |
| edge_weight | 全部 0.618（唯一值） |
| edge_color | 多数 `[0,0,0,1]`，皮肤类 `[0.502,0,0,1]` |
| 实现方式 | mmd_material 自定义属性 `enabled_toon_edge` |

### Mesh 法线状态
| 项目 | 值 |
|------|-----|
| 平滑着色 | 100%（103549/103549 面） |
| 锐边标记 | 0 条 |
| 自定义法线 | 是 |

**关键**：Blender 中模型使用全平滑着色 + 自定义法线，所以法线连续无突变。

## 引擎端实现分析

### 当前实现
文件：`engine/src/shaders/passes/outline.ts`

算法：**屏幕空间法线挤出**
1. 每个顶点沿其世界法线在 clip 空间偏移
2. `offset = ndcDir * edgeSize * edgeScale * clipPos.w`
3. `cullMode: "back"`（engine.ts:1662）

### 问题根因

#### 根因 1：`cullMode: "back"` 导致断裂
当曲面弯曲较大时，挤出后的三角形绕序可能反转：
- 原始三角形：正面朝向相机
- 挤出后：法线偏移导致顶点位置变化，三角形绕序反转
- 结果：被 back-face culling 剔除 → **边缘线消失**

Blender 描边渲染不依赖绕序（渲染所有几何），所以无此问题。

#### 根因 2：`normalize` 零向量不稳定
```wgsl
let pixelDir = normalize(vec2f(clipNormal.x * aspect, clipNormal.y));
let ndcDir = normalize(vec2f(pixelDir.x / aspect, pixelDir.y));
```
当法线几乎平行于视线时，`clipNormal.xy` 接近零向量，`normalize` 结果未定义 → 描边消失或抖动。

#### 根因 3：edgeScale 固定常数
`edgeScale = 0.0028` 对应 edgeSize=1.0 时约 1.5px。但本模型 edgeSize=0.618，实际像素厚度 ≈ 1px，接近亚像素级别，容易被片段覆盖或锯齿吞没。

## 修复方案

### 修复 1：cullMode 改为 "none"
描边 Pass 的目的是绘制边缘线，不应剔除任何面。MMD 原版描边也不做 back-face culling。

### 修复 2：normalize 安全处理
当 `clipNormal.xy` 长度过小时，回退到屏幕空间偏移方向（如沿 (1,0) 或基于位置投影的方向）。

### 修复 3：edgeScale 最小厚度保障
确保最小 1px 厚度，避免亚像素吞没。

## 修改记录

| 步骤 | 文件 | 修改 | 结果 |
|------|------|------|------|
| 1 | engine.ts:1662 | `cullMode: "back"` → `"none"` | ✅ 构建通过 |
| 2 | outline.ts | normalize 零向量保护 | ✅ 构建通过 |
| 3 | clean + build | tsc 编译 | ✅ 成功 |

## 根因总结

边缘线时断时续的两个原因：

1. **`cullMode: "back"`**（主因）：法线挤出后，曲面上的三角形顶点位置变化，绕序可能反转。反转的三角形被背面剔除丢弃，导致该区域描边消失。Blender 描边不做绕序剔除，所以连续。

2. **`normalize` 零向量**（次因）：当表面法线与视线方向接近垂直时（ grazing angle ），投影到 clip 空间的 xy 分量接近零，`normalize` 行为未定义，导致偏移方向不稳定或为零，描边消失。

## 验证
需要用户在浏览器中加载模型查看效果。如果仍有少量断裂，可能需要进一步调整 edgeScale 或增加深度偏移。
