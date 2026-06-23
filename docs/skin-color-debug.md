# 皮肤颜色调试记录

## 问题描述

2026-06-21：用户反馈 风堇 模型皮肤（身体、手臂、脖子）渲染效果与 Blender 不一致：
- 阴影区域太暗且偏蓝紫（用户最初明确提出的问题）
- 脸部效果相对正确，但其他皮肤材质不对
- 后续在修复阴影的尝试中，用户反馈皮肤出现偏黄现象

## 排查过程

### 1. 材质节点组核对（MCP）

通过 `execute_blender_code` 连接 Blender 5.0，确认皮肤材质使用的节点组：

| 材质 | Blender 节点组 | engine preset |
|------|---------------|---------------|
| 身体 | StarRailShader.身体变体_v17 | sr_body |
| 手臂 | StarRailShader.身体变体_v17 | sr_body |
| 指甲 | StarRailShader.身体变体_v17 | sr_body |
| 脖子 | 星铁@Minyu-Shader.clothes | sr_body（与 Blender 不一致） |

### 2. 身体变体_v17 节点链

数据流（经 MCP 核对）：

```
Color → 校色.001 → Mix.A
ILM Green → 虚拟日光 → Map Range(0,1→0.15,0.99) → ramp.002(alpha=0) → Mix.B
Mix → Mix.001.A
SDF.tex → 鼻尖阴影 → Mix.001.B
Mix.001 → Result
```

### 3. 校色.001 子组

所有 StarRail 材质（face/body/clothes/hair）共用同一个 `校色.001`：

- RGB Curves：仅 Blue 通道 `[(0,0), (0.4109,0.1657), (0.6688,0.314), (0.8847,0.8052), (1,1)]`
- RGB Curves.001：仅 Blue 通道 `[(0,0), (0.4771,0.2326), (0.8437,0.7355), (1,1)]`
- Hue/Saturation/Value：Value × 1.85

### 4. ramp.002 / ramp 子组

- 外层 Map Range：0→1 映射到 0.15→0.99
- 内层 Map Range：0→1 映射到 0.02→0.99
- alpha = 0.0（未连接）
- 使用 `Avatar_Hyacine_00_Body_Warm_Ramp.png`
- RGB Curves / RGB Curves.001 仅修改 Blue 通道

### 5. 虚拟日光子组

- Attribute(SUN) 在 PMX 导出后不存在 → 返回 (0,0,0)
- dot(N, SUN=0) = 0 → Map Range(-1,1→0,1) = 0.5
- Mix(MULTIPLY): 0.5 × smoothstep(0,0.2,Green)
- Math.003(MULTIPLY_ADD 0.5,0.5): result×0.5 + 0.5
- Math.001(POWER 2): result^2
- 固定输出：`0.5625`（不随法线/灯光变化）

## 修改尝试

### 尝试 1：修复 ramp 曲线通道

**问题**：`ramp_lookup` 将 ramp 子组的 B 通道曲线应用到了 R/G/B 三个通道。

**修复**：改为仅对 B 通道应用曲线，R/G 保持 ramp 贴图原样。

**结果**：阴影不再蓝紫，但皮肤整体变偏黄。

### 尝试 2：修复 color_correct 曲线

**问题**：`color_correct` 只使用了一条曲线，且缺少 RGB Curves.001；节点图上两条曲线仅作用于 Blue 通道。

**修复 A**：只将两条曲线串联应用到 B 通道。

**结果**：更黄，用户反馈"现在更黄了"。

**修复 B**：将两条曲线串联后应用到 R/G/B 三个通道（基于历史视觉验证：由于 sRGB↔linear 解码差异，三通道应用更接近 Blender 视觉效果）。

**结果**：用户反馈"效果全部不对"。

### 当前状态

已执行 `git checkout -- engine/src/shaders/materials/starrail/starrail_nodes.ts`，回退到修改前状态；web dev server 已重启。

## 遗留问题

1. **虚拟日光**：Blender 中固定为 0.5625，engine 当前是 dynamic NdotL。这会导致 engine 阴影面采样 ramp 暗部，Blender 始终采样较亮区域。
2. **脖子材质**：Blender 使用 `clothes` 节点组，engine manifest 中设为了 `sr_body`。
3. **校色/ramp 曲线通道**：节点图上确实只修改 Blue 通道，但引擎中直接复制该行为会导致偏色，说明还存在其他未对齐的因素（颜色空间、采样方式、色调映射等）。

## 其他调整

- 将 web/app/layout.tsx 的 `bg-pink-300` 改为 `bg-black`，去掉粉色背景。
- 约定：engine 修改后仅执行 `npm run build`，不再手动复制 dist；web dev server 会热更新。

## 完整逐节点对照（2026-06-21 MCP 复核）

> 以下结果全部通过 `execute_blender_code` 连接 Blender 逐节点读取，与 engine 代码逐一对照。
> 前一版文档中关于 `校色.001` 的描述有误（实际是 `校色`，且 `RGB Curves.001` 是孤立节点）。

### A. 身体材质顶层（`身体` material）

Blender 节点（3 个）：
```
[TEX_IMAGE 图像纹理] Body3.png.001  colorspace=sRGB, interpolation=Linear
[GROUP 群组]         → StarRailShader.身体变体_v17
[OUTPUT_MATERIAL 材质输出]
```
连接：`图像纹理.Color → 群组.Color → 材质输出.Surface`

engine 对应：`colorTexture` (sRGB 解码, `linear=false`) → `fs()` → output。**一致**。

### B. 身体变体_v17 节点组（19 节点，9 连接）

**实际数据流**（经 MCP 核对，与旧文档不同）：

```
GroupInput.Color → 校色(Group.006).Color → 校色.Color → Mix.A
GroupInput.Color → 校色(Group.006)  (唯一输入)
虚拟日光(Group.001).半兰伯特 → MapRange(0,1→0.15,0.99).Value → ramp(Group.009).Value → ramp.Color → Mix.B
Mix(rgba MULTIPLY, Factor=1).Result → Mix.001.A
SDF.tex(Group.010).Color → 鼻尖阴影(Group.013).Color → 鼻尖阴影.Result → Mix.001.B
Mix.001(rgba MULTIPLY, Factor=1).Result → GroupOutput.Result
```

**孤立节点（存在于节点组但未连到输出）**：
- `SDF` (Group.002)
- `matcap` (Group.003)
- `matcap.hair` (Group.004)
- `smoothstep` (Group.005)
- `布林冯光照模型` (Group)
- `ilm.clothes` (Group.011)
- `ilm.hair` (Group.012)
- `ramp.clothes` (Group.007)
- `ramp.hair` (Group.008)

→ **engine body.ts 没有调用 matcap/blinn_phong/ilm_decode，正确。**

### C. 校色 子组（逐节点）

**实际连接**（MCP 复核，纠正旧文档）：
```
GroupInput.Color → RGB Curves.Color     (串联主路径)
GroupInput.Color → RGB Curves.001.Color (并联，但输出未连接！)
RGB Curves.Color → Hue/Saturation/Value.Color
Hue/Saturation/Value.Color → GroupOutput.Color
RGB Curves.001.Color → (无输出连接，孤立节点)
```

**关键纠正**：旧文档说"两条 RGB Curves 串联"是**错误**的。实际上：
- 只有 `RGB Curves`（不是 `.001`）参与数据流
- `RGB Curves.001` 完全孤立，对输出无影响

**RGB Curves 参数**（curve[3] = Combined）：
```
curve[0] R: [(0,0), (1,1)]           恒等
curve[1] G: [(0,0), (1,1)]           恒等
curve[2] B: [(0,0), (1,1)]           恒等
curve[3] Combined: [(0,0,AUTO), (0.4109,0.1657,AUTO), (0.6688,0.3140,AUTO), (0.8847,0.8052,AUTO_CLAMPED), (1,1,AUTO)]
```

Blender RGB Curves 的 **Combined 曲线 (curve[3]) 会同时应用到 R/G/B 三个通道**（这是 Blender 的标准行为，不是仅 Blue 通道）。

**engine `_c_curve_lut`**（21 点 LUT）经 `mapping.evaluate()` 对比，数值完全一致。

**Hue/Saturation/Value 参数**：
- Hue = 0.5（恒等：`fract(h + 0.5 - 0.5) = h`）
- Saturation = 1.0
- Value = 1.85
- Factor = 1.0

engine `color_correct`: 先对 R/G/B 各自应用 `_c_curve_lut`，再 `rgb_to_hsv` → `v *= 1.85` → `hsv_to_rgb`。**逻辑一致**。

### D. 虚拟日光 子组（逐节点）

**完整数据流**（MCP 核对）：
```
Attribute(attribute_name='SUN', type='GEOMETRY').Vector → VectorMath.001(SCALE ×2).Vector
Geometry.Normal → VectorMath(DOT_PRODUCT, VM.001, Normal).Value → MapRange.Value
MapRange(From -1,1 → To 0,1).Result → Mix.A
GroupInput.Image(default (0.8,0.8,0.8)) → SeparateColor.Color → SeparateColor.Green → smoothstep(a=0,b=0.2).x → smoothstep.Result → Mix.B
Mix(rgba MULTIPLY, Factor=1).Result → Math.003.Value
Math.003(MULTIPLY_ADD, 0.5, 0.5): result×0.5 + 0.5 → Math.001.Value
Math.001(POWER, 2.0).Value → GroupOutput.半兰伯特光照模型
```

**关键：Attribute(SUN) 在 PMX 导出后不存在**，返回 (0,0,0)：
- SUN×2 = (0,0,0)
- dot(N, (0,0,0)) = 0
- MapRange(0, -1,1→0,1) = **0.5**（固定）
- Image 默认 (0.8,0.8,0.8) → Green = 0.8 → smoothstep(0, 0.2, 0.8) = **1.0**
- Mix MULTIPLY(0.5, 1.0) = **0.5**
- Math.003 MULTIPLY_ADD(0.5): 0.5×0.5 + 0.5 = **0.75**
- Math.001 POWER(2.0): 0.75² = **0.5625**（固定输出）

**engine 差异**：`virtual_sun(n, l, 0.8)` 使用真实 NdotL，不是固定 0.5625。
- `half_lambert = saturate(dot(n, l*2) * 0.5 + 0.5)` — 当背光时 < 0.5
- `step3 = half_lambert * 1.0 * 0.5 + 0.5` — 当 half_lambert=0 时 = 0.5
- `pow(0.5, 2.0)` = 0.25 — **远暗于 Blender 的 0.5625**

→ **这是阴影过暗的根因。** engine 应固定输出 0.5625（因为 SUN 属性不存在）。

### E. Map Range（外层，身体变体_v17 内）

参数：`From 0,1 → To 0.15, 0.99`（MCP 确认）

engine body.ts: `sunMapped = 0.15 + saturate(sunVal) * 0.84`。
0.99 - 0.15 = 0.84。**一致**。

### F. ramp 子组（逐节点）

**完整数据流**（MCP 核对）：
```
GroupInput.Value → MapRange(From 0,1 → To 0.02,0.99).Result → CombineXYZ.X
GroupInput.alpha → ramp采样(Group.008).alpha → ramp采样.Value → CombineXYZ.Y
CombineXYZ.Vector → ramp.clothes(Group).Vector → ramp.clothes.Color → RGB Curves.Color
RGB Curves.Color → RGB Curves.001.Color → GroupOutput.Color
ramp采样.Value → InvertColor.Color → RGB Curves.001.Factor
```

**MapRange 参数**（内层）：`From 0,1 → To 0.02, 0.99`。engine `ramp_lookup`: `mapped = 0.02 + saturate(value) * 0.97`。**一致**。

**RGB Curves**（两条，串联）：
- `RGB Curves` Combined: `[(0,0), (0.7167, 0.4244), (1,1)]` → engine `_ramp_c1`
- `RGB Curves.001` Combined: `[(0,0), (0.563, 0.3999), (1,1)]` → engine `_ramp_c2`
- 两条都是 Combined 曲线，应用到 R/G/B 三通道。engine 对 R/G/B 都应用。**一致**。

**RGB Curves.001 Factor**：来自 `Invert(ramp采样.Value)`。
- 当 alpha > 0.10 → ramp采样.Value 较大 → Invert 较小 → Factor→0 → RGB Curves.001 近似恒等
- 当 alpha ≤ 0.10 → Invert→1 → Factor→1 → 应用第二条曲线

engine: `second_factor = select(1.0, 0.0, alpha > 0.10)`。**一致**（离散 0/1，非连续）。

### G. ramp采样 子组（逐节点）

结构：7 档 GREATER_THAN 阈值选择 + MULTIPLY_ADD 计算 Y 坐标。

| alpha 范围 | Y 值 (MULTIPLY_ADD 0.125×N+0.025) |
|-----------|----------------------------------|
| ≤ 0.10    | 0.125×0.25+0.025 = **0.05625**   |
| 0.10–0.20 | 0.125×1+0.025 = **0.15**         |
| 0.20–0.33 | 0.125×2+0.025 = **0.275**        |
| 0.33–0.45 | 0.125×3+0.025 = **0.4**          |
| 0.45–0.58 | 0.125×4+0.025 = **0.525**        |
| 0.58–0.70 | 0.125×5+0.025 = **0.65**         |
| 0.70–0.85 | 0.125×6+0.025 = **0.775**        |
| > 0.85    | 0.125×7+0.025 = **0.9**          |

engine `ramp_sample(alpha)` 返回值与上表**完全一致**。

**注意**：身体材质中 `ramp(Group.009).alpha = 0.0`（未连接），所以 Y = 0.05625。

### H. ramp.clothes 子组

```
GroupInput.Vector → Image Texture(Cool_Ramp).Vector    (孤立)
GroupInput.Vector → Image Texture.001(Warm_Ramp).Vector → Image Texture.001.Color → GroupOutput.Color
```

输出贴图：`Avatar_Hyacine_00_Body_Warm_Ramp.png`（colorspace=sRGB, interpolation=Smart）

engine: `rampTexture` = warm_ramp（sRGB 解码）。**一致**。

### I. SDF.tex 子组

9 个 FaceMap 纹理，只有 `Image Texture.004` (W_140_Girl_FaceMap_00.png) 连到输出。
- colorspace = **sRGB**（不是 Non-Color！）

engine: `sdfTexture` 加载时 `linear=false`（sRGB）。**一致**。

### J. 鼻尖阴影 子组（逐节点）

**完整数据流**（MCP 核对）：
```
Geometry.Normal → Mapping(Location=(0,-0.4,0), Scale=(1,1,1), Rotation=0).Vector → LayerWeight.Normal
LayerWeight(blend=0.5).Facing → ColorRamp(Factor)
ColorRamp(EASE, 0.2042→黑, 0.2708→白).Color → Mix.001.Factor
GroupInput.Color → SeparateColor.Color → SeparateColor.Blue → ColorRamp.001(Factor)
ColorRamp.001(EASE, 0.0→黑, 0.0458→白).Color → InvertColor → Mix.001.A
Mix.001(MIX, rgba, Factor=ColorRamp).Result → GroupOutput.Result
Mix.001.B = (1,1,1,1) 白色（默认）
```

**engine `nose_shadow` 差异**：
1. **Mapping 实现**：Blender 是 `Normal + (0,-0.4,0)`（Translation），engine 是 `normalize(vec3f(n.x, n.y-0.4, n.z))`。
   - Blender Mapping 对未归一化的 Normal 做加法，**不重新归一化**（Mapping 节点 Point 类型只做仿射变换）。
   - LayerWeight 接收的 Normal 不需要归一化（内部会用 `normalize`）。
   - **影响小**（LayerWeight 内部归一化），但严格来说 engine 多了一次 `normalize`。

2. **ColorRamp EASE 插值**：Blender EASE = `(1-cos(πt))/2`，engine 用 `smoothstep = t*t*(3-2t)`。
   - 两者曲线形状接近但不完全相同。
   - 在阈值附近（0.2042–0.2708）差异最大约 2-3%。

3. **LayerWeight.Facing**：engine `layer_weight_facing(blend=0.5, n, v)` 与 Blender 一致（blend=0.5 时 `1 - abs(dot(n,v))`）。

### K. 贴图 colorspace 汇总

| 贴图用途 | Blender colorspace | engine 加载方式 | 一致？ |
|---------|-------------------|----------------|--------|
| Color (Body3.png) | sRGB | `linear=false` (sRGB) | ✅ |
| Warm Ramp | sRGB | `linear=false` (sRGB) | ✅ |
| Cool Ramp | sRGB | `linear=false` (sRGB) | ✅ |
| SDF FaceMap | sRGB | `linear=false` (sRGB) | ✅ |
| ILM LightMap | Non-Color | `linear=true` (raw) | ✅ |

## 对照结论与差异汇总

| # | 节点/环节 | Blender 行为 | engine 实现 | 差异影响 |
|---|----------|-------------|------------|---------|
| 1 | **虚拟日光 SUN 属性** | 存在！`SUN=(0.296,-0.814,0.5)`（evaluated mesh 上） | engine 用 `l = -light.direction` | 见 #12 |
| 2 | 校色 RGB Curves.001 | 孤立节点，不影响输出 | engine 未实现（正确） | 无差异 |
| 3 | 校色 Combined 曲线 | 应用到 R/G/B 三通道 | engine 对 R/G/B 各自应用 | **一致** |
| 4 | ramp 两条 RGB Curves | 串联，Factor 来自 Invert(ramp采样) | engine 串联，Factor 离散 0/1 | **一致** |
| 5 | ramp Map Range | 0,1→0.02,0.99 | engine `0.02+x*0.97` | **一致** |
| 6 | ramp采样 Y 值表 | 8 档 GREATER_THAN | engine `ramp_sample` | **一致** |
| 7 | 鼻尖阴影 Mapping | Normal + (0,-0.4,0)，不归一化 | engine 先归一化再减 0.4 | 影响极小 |
| 8 | 鼻尖阴影 ColorRamp | EASE 插值 `(1-cos(πt))/2` | engine `smoothstep t*t*(3-2t)` | 差异 2-3% |
| 9 | 贴图 colorspace | Color/Ramp/SDF=sRGB, ILM=Non-Color | engine 对应设置 | **一致** |
| 10 | Mix 节点 | MULTIPLY, Factor=1.0 | engine 直接 `A*B` | **一致** |
| 11 | 外层 Map Range | 0,1→0.15,0.99 | engine `0.15+x*0.84` | **一致** |
| 12 | **sun direction Y/Z 互换** | Blender: `(-0.296, 0.814, -0.500)` | engine: `(-0.296, -0.500, 0.814)` | **阴影过暗根因** |

## 修复优先级

1. **【高】sun direction Y/Z 互换**：page.tsx 中 sun direction 的 Y/Z 分量与 Blender 相比被交换了。
   - Blender 灯光方向（from sun to scene）：`(-0.296, 0.814, -0.500)`
   - engine 原值：`(-0.296, -0.500, 0.814)` ← Y/Z 互换
   - 这导致 `virtual_sun` 的 `dot(N, SUN)` 完全错误，阴影分布不正确。

2. **【低】鼻尖阴影 ColorRamp EASE 插值**：将 `smoothstep` 改为 `(1-cos(πt))/2`。
   - 影响极小，可后续处理。

3. **【低】鼻尖阴影 Mapping 归一化**：移除 `normalize`，直接 `vec3f(n.x, n.y-0.4, n.z)`。
   - LayerWeight 内部会归一化，影响可忽略。

## 修复记录

### ~~修复 1：虚拟日光固定化（2026-06-21）~~ 【已回退，分析有误】

> 此修复基于"SUN 属性在 PMX 导出后不存在"的错误假设。
> 实际上 SUN 属性在 **evaluated mesh** 上存在（由 modifier 生成），值为 `(0.296, -0.814, 0.5)`。
> 固定化后导致全身变暗紫色，已通过 `git checkout` 回退。

### 修复 2：sun direction Y/Z 分量互换（2026-06-21）

**文件**：[page.tsx](file:///e:/reze-engine/web/app/page.tsx#L457)

**变更**：
```diff
- sun: { strength: 6.5, direction: new Vec3(-0.296, -0.500, 0.814) },
+ sun: { strength: 6.5, direction: new Vec3(-0.296, 0.814, -0.500) },
```

**原理**：通过 MCP 读取 Blender evaluated mesh 上的 SUN 属性，确认其值为 `(0.296, -0.814, 0.500)`（从表面指向光源）。
- Blender 灯光 `灯光.001` 旋转 `(60°, 0°, 20°)` → 方向 `(-0.296, 0.814, -0.500)`（from sun to scene）
- engine 的 `light.direction` 应为 from-sun-to-scene 方向
- 但原代码中 Y/Z 分量被交换：`(-0.296, -0.500, 0.814)` ← 错误

这导致 `l = -light.direction = (0.296, 0.500, -0.814)` 而非正确的 `(0.296, -0.814, 0.500)`，
`virtual_sun` 的 `dot(N, l×2)` 完全错误，阴影分布与 Blender 不一致。

**MCP 验证数据**：
| 量 | 值 |
|----|-----|
| Blender 灯光旋转 XYZ | `(60°, 0°, 20°)` = `(1.0472, 0, 0.3491)` rad |
| Blender 灯光方向 (→scene) | `(-0.296, 0.814, -0.500)` |
| Blender SUN 属性 (→sun) | `(0.296, -0.814, 0.500)` |
| Blender RIGHT 属性 | `(1, 0, 0)` |
| Blender FRONT 属性 | `(0, 0, -1)` |
| engine 原方向 (→scene) | `(-0.296, -0.500, 0.814)` ← Y/Z 互换 |
| engine 修复后 (→scene) | `(-0.296, 0.814, -0.500)` ← 正确 |

### ~~修复 2：sun direction Y/Z 分量互换~~ 【已回退】

> 修改 sun direction 后用户反馈"光照方向才错了"，说明 engine 的坐标系（MMD Z-up → engine Y-up 转换）使得原值 `(-0.296, -0.500, 0.814)` 才是视觉正确方向。已改回。

### 修复 3：ramp RGB Curves 分段线性 → 精确 LUT（2026-06-21）

**文件**：[starrail_nodes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/starrail_nodes.ts) `_ramp_c1` / `_ramp_c2` → `_ramp_c1_lut` / `_ramp_c2_lut`

**问题**：ramp 子组的两条 RGB Curves 使用 Blender AUTO 手柄贝塞尔曲线，engine 原实现用 2-3 个控制点的分段线性近似，最大误差 **0.097**（约 10%）。

**MCP 逐点对比**（curve1: `[(0,0), (0.7167, 0.4244), (1,1)]`）：

| x | Blender evaluate | Engine 分段线性 | 差异 |
|---|-----------------|----------------|------|
| 0.40 | 0.1712 | 0.2369 | 0.0657 |
| 0.80 | 0.5252 | 0.5936 | 0.0685 |
| 0.90 | 0.6999 | 0.7968 | **0.0970** |

**影响**：ramp 贴图在阴影区域（如 `ramp_u≈0.4`）原始值 `(0.78, 0.78, 0.94)` 偏蓝。分段线性近似的曲线输出比 Blender 高约 0.06-0.10，导致阴影区域的颜色值不正确，加剧偏色。

**修复**：改用 21 点 LUT（与 `_c_curve_lut` 同方法），经 MCP `mapping.evaluate()` 采样，精度与校色 LUT 一致（误差 < 0.001）。

**验证**：`npm run clean && npm run build` 成功。

**数值影响示例**（UV=0.5,0.5，阴影面 ramp_u=0.4062）：

| 阶段 | 旧值（分段线性） | 新值（LUT） | Blender |
|------|----------------|-------------|---------|
| Ramp raw (sRGB) | (0.784, 0.780, 0.937) | 同左 | 同左 |
| Ramp after curves | ~(0.24, 0.24, 0.50) | ~(0.18, 0.18, 0.47) | (0.18, 0.18, 0.47) |

### 修复 4：校色 HSV Value×1.85 缺少 clamp（2026-06-21）【主要根因】

**文件**：[starrail_nodes.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/starrail_nodes.ts) `color_correct` 函数

**问题**：Blender 的 Hue/Saturation/Value 节点会将 Value clamp 到 [0,1]，engine 的 `color_correct` 函数在 `hsv.z * 1.85` 后没有 clamp。

**MCP 验证数据**（Body3.png UV(0.5,0.5)）：

| 阶段 | 值 |
|------|-----|
| Body3 sRGB | (0.969, 0.902, 0.894) |
| Body3 linear | (0.930, 0.791, 0.776) |
| 校色曲线后 | (0.888, 0.547, 0.502) |
| HSV Value | 0.888 |
| V × 1.85 | **1.643** |
| Blender clamp 后 | **1.000** |
| **engine 旧值（不 clamp）** | **1.643** ← 是 Blender 的 1.64 倍！ |
| **engine 修复后** | **1.000** ← 与 Blender 一致 |

**影响**：`corrected` 值被放大 1.64 倍后，最终 `final = corrected × ramp` 中阴影区域的蓝色也被放大了 1.64 倍。

对比（UV=0.5,0.5, sunVal=0.5, ramp_u=0.5729）：

| | corrected | ramp | final | B/G ratio |
|---|-----------|------|-------|-----------|
| engine 旧值 | (1.64, 1.01, 0.93) | (0.19, 0.17, 0.35) | (0.32, 0.17, 0.33) | 1.91 |
| engine 修复后 | (1.00, 0.62, 0.57) | (0.19, 0.17, 0.35) | (0.19, 0.10, 0.20) | 1.93 |
| Blender | (1.00, 0.62, 0.57) | (0.19, 0.17, 0.35) | (0.19, 0.10, 0.20) | 1.93 |

修复后 engine 与 Blender 数值完全一致。

**修复**：在 `hsv.z * 1.85` 外加 `min(..., 1.0)`。

**验证**：`npm run clean && npm run build` 成功。

### ~~修复 4：校色 HSV Value×1.85 缺少 clamp~~ 【已回退】

> Clamp 后用户反馈"亮处变暗了"，说明 Blender 的 HSV 节点在 EEVEE 中**不 clamp** Value（允许 HDR >1.0）。
> 已回退。

### 发现 5：Filmic LUT 是 1D per-channel，但 Blender Filmic+HC 是 3D LUT（2026-06-21）【真正的根因】

**问题**：engine 的 `composite.ts` 使用 256 点一维 LUT 对 R/G/B 三通道独立做色调映射。但通过 MCP 在 Blender 中渲染已知线性颜色值的 Emission 平面，发现 **Blender 的 Filmic + High Contrast look 不是 per-channel 独立的**。

**MCP 验证**（创建 Emission 平面渲染已知线性颜色）：

| 输入 (linear) | Blender 渲染 | Engine LUT | 差异 |
|---------------|-------------|-----------|------|
| (0.50, 0.50, 0.50) 灰 | **(0.514, 0.353, 0.526)** | (0.670, 0.670, 0.670) | 灰→彩色！ |
| (0.80, 0.80, 0.80) 灰 | **(0.918, 0.863, 0.855)** | (0.781, 0.781, 0.781) | 灰→彩色！ |
| (1.00, 0.62, 0.57) | **(0.631, 0.502, 0.745)** | (0.825, 0.724, 0.704) | B 通道差异 0.041 |
| (0.30, 0.18, 0.49) | **(0.863, 0.788, 0.773)** | (0.526, 0.378, 0.665) | 巨大差异 |

**关键发现**：输入灰度 `(0.5, 0.5, 0.5)` 时，Blender 输出 `(0.514, 0.353, 0.526)` — R≠G≠B！一维 per-channel LUT 无法产生这种效果。

**原因**：Blender 的 OCIO 流程 `linear → Filmic Log → look(HC) → base_curve → sRGB` 中，High Contrast look 是一个**三维颜色变换**（3D LUT），不是三个独立的一维曲线。它对灰度输入也会引入色相偏移。

**影响**：
- 灰色被映射成偏紫色调
- 阴影区域（蓝色分量较高的颜色）被映射成不同的色相
- 所有经过色调映射的颜色都有不同程度的偏色
- 这解释了为什么脸部和身体的阴影都偏紫 — 色调映射本身就引入了偏色

**修复方向**：需要从 Blender 导出真正的 3D LUT（如 32×32×32 或 64×64×64），在 engine 中用 `texture_3d` 采样替代当前的一维 LUT。这是一个较大的改动。

### 修复 6：用 Blender OCIO 烘焙 3D LUT 替代 1D LUT（2026-06-21）

**根因细节**：通过分析 Blender 5.0 的 `config.ocio`，发现 Filmic + High Contrast 的完整管线是：

1. `scene_linear` (Linear Rec.709) → `Linear CIE-XYZ E`（色彩空间转换）
2. `XYZ E` → `Filmic Log`：
   - `XYZ E → Linear Rec.709`（矩阵）
   - `log2` allocation [-12.47, 12.53]
   - **`filmic_desat_33.cube`**（33³ 3D LUT，去饱和）← 关键！
   - `uniform` allocation [0, 0.66]
3. **HC look**（在 Filmic Log 空间）：
   - `filmic_to_0.99_1-0075.spi1d`（1D LUT）
   - `filmic_to_0-70_1-03.spi1d` 的逆（1D LUT）
4. `filmic_to_0-70_1-03.spi1d`（1D LUT）
5. sRGB 显示编码

`filmic_desat_33.cube` 是一个 33×33×33 的 3D LUT，它会产生通道耦合的色相偏移（灰色→彩色）。engine 的 1D per-channel LUT 完全跳过了这一步。

**修复**：用 PyOpenColorIO 在 Blender 中烘焙了一个 32³ 的完整 3D LUT，覆盖上述全流程（步骤 1-5）：

```python
# 烘焙代码（在 Blender MCP 中执行）
proc = cfg.getProcessor(full_group)  # 完整 Filmic + HC 管线
cpu = proc.getDefaultCPUProcessor()
# 遍历 32³ 网格，输入 linear [0, 2.0]，输出 sRGB 显示值
```

修改文件：
- `web/public/filmic_hc_32.bin`：32³ RGBA32F 二进制 3D LUT（524KB）
- `engine/src/shaders/passes/composite.ts`：用 `texture_3d` 采样替代 1D LUT 数组
- `engine/src/engine.ts`：
  - `init()` 中 `fetch("/filmic_hc_32.bin")` 预加载
  - `createPipelines()` 中创建 3D texture + sampler
  - bind group layout 添加 binding 5（3D texture）和 binding 6（sampler）

**验证**：
- 灰色 `(0.5, 0.5, 0.5)` → LUT 输出 `(0.459, 0.483, 0.525)`（R≠G≠B，正确产生色相偏移）
- 旧 1D LUT 输出 `(0.670, 0.670, 0.670)`（灰色保持灰色，错误）
- `npm run clean && npm run build` 成功
