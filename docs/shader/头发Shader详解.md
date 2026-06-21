# 头发 Shader 详解

> 材质：`髪`(slot28) / `髪1`(slot29) 共用 `星铁@Minyu-Shader.hair.001`（25节点29连线）
> `髪+`(slot30) 使用 MMDShaderDev，不在本文范围

---

## 一、材质层级

```
材质: 髪 (slot28/29)
└── Shader Nodetree
    ├── Image Texture (髪.png.001) ──Color──> Group[Color]
    ├── Group -> 星铁@Minyu-Shader.hair.001
    │   └── Group[Shader] ──> Material Output[Surface]
    └── Material Output
```

---

## 二、贴图清单

| 贴图 | 尺寸 | 平均 R | 平均 G | 平均 B | 用途 |
|------|------|--------|--------|--------|------|
| 髪.png.001 | 2048×2048 | 0.8775 | 0.8335 | 0.8440 | 头发基色贴图（浅灰白色） |
| Avatar_Hyacine_00_Hair_LightMap.png.001 | 2048×2048 | 0.9460 | 0.2335 | **0.0135** | ILM 光照图（R高G低B近0） |
| hairmask.001 | 1024×1024 | 0.0000 | 0.0000 | 0.0000 | 头发遮罩（**全黑**） |
| Avatar_Hyacine_00_Hair_Warm_Ramp.png.001 | 256×2 | 0.9645 | 0.8306 | 0.8827 | 暖色渐变 |
| Avatar_Hyacine_00_Hair_Cool_Ramp.png.001 | 256×2 | 0.9575 | 0.8574 | 0.9539 | 冷色渐变（**未连线，悬空**） |
| hair_s.bmp.001 | 256×256 | 0.1390 | 0.1390 | 0.1390 | matcap 球面贴图（深灰色） |

---

## 三、完整信号流图

```
                          ┌──────────────────────────────────────────────────────────┐
                          │             星铁@Minyu-Shader.hair.001                    │
                          │                                                          │
髪.png.001 ──Color──> [校色.001] ───────────────────────────────────> Mix[A]         │
                          │ RGB Curves(S曲线)                                  │      │
                          │ HSV Value × 1.85                                   │      │
                          │                                              MULTIPLY │      │
                          │                                                  ↓      │
                          │  [ilm.hair.001]                                    │      │
                          │  ILM LightMap ──> Separate Color                   │      │
                          │     ├─ Green ──> Color Ramp(0→黑, 0.1→白)          │      │
                          │     │         ──> Combine Color ──> [虚拟日光.001]   │      │
                          │     │                              半兰伯特光照      │      │
                          │     │                                   │            │      │
                          │     │                          Map Range            │      │
                          │     │                          (0→0.02, 1→0.99)     │      │
                          │     │                                   │            │      │
                          │     │                          Combine XYZ          │      │
                          │     │                          (X=光照值)            │      │
                          │     │                                   │            │      │
                          │     │                            [ramp.hair.001] ──> Mix[B] │
                          │     │                          Warm Ramp 纹理采样     ↓      │
                          │     │                          + RGB Curves(蓝压缩)  Mix输出 │
                          │     │                                              │      │
                          │     └─ Blue ──────────┐                          │      │
                          │                       ↓                          │      │
                          │  [matcap.hair.001] → Math(/0.05) → Math(×B通道)  │      │
                          │  hair_s.bmp(均值0.139)        ↑                   │      │
                          │                                │                   │      │
                          │           虚拟日光输出 ──> Math(>0.85?) ──> Math(×) │      │
                          │                                            ↓      │      │
                          │                                    Map Range.001     │      │
                          │                                    (0→1.0, 1→2.2)    │      │
                          │                                         │           │      │
                          │                                         ↓           │
                          │  ┌──────────────────────────> Mix.001[B]           │      │
                          │  │                              MULTIPLY           │      │
                          │  Mix输出 ──────────────────> Mix.001[A]           │      │
                          │                                    │                │      │
                          │                                    ↓                │      │
                          │                                  Emission           │      │
                          │                                    │                │      │
                          │  hairmask(全黑) → Math(×0.005) ≈ 0                  │      │
                          │                          ↓         │                │      │
                          │                    Mix Shader Factor               │      │
                          │                   (0 = 100% Emission)              │      │
                          │                          │         │                │      │
                          │              Transparent BSDF       │                │      │
                          │                          └────┬────┘                │
                          │                               ↓                     │
                          │                         Group Output[Shader]        │
                          └──────────────────────────────────────────────────────────┘
```

---

## 四、逐节点详解

### 4.1 校色.001（颜色校正子组）

**内部节点（5个）：**

| 节点 | 类型 | 参数 |
|------|------|------|
| Group Input | GROUP_INPUT | — |
| RGB Curves | CURVE_RGB | Combined曲线见下 |
| RGB Curves.001 | CURVE_RGB | **输出未连线，悬空** |
| Hue/Saturation/Value | HUE_SAT | Value=1.85 |
| Group Output | GROUP_OUTPUT | — |

**连线：**
```
Group Input[Color] → RGB Curves[Color]
Group Input[Color] → RGB Curves.001[Color]     # 悬空分支
RGB Curves[Color] → Hue/Saturation/Value[Color]
Hue/Saturation/Value[Color] → Group Output[Color]
```

**RGB Curves 参数：**
- R/G/B 通道：直线 `[(0,0), (1,1)]`，无调整
- **Combined 通道**：`[(0,0), (0.411, 0.166), (0.669, 0.314), (0.885, 0.805), (1,1)]`
  - S型曲线：暗部大幅压暗（0.41→0.17，-59%），亮部基本不变
  - 中间调（0.67→0.31）也被压缩约 53%

**HSV 参数：**
- Hue=0.5, Saturation=1.0, **Value=1.85**, Factor=1.0
- 整体亮度乘以 1.85 倍

**RGB Curves.001（悬空，未使用）：**
- Combined: `[(0,0), (0.477, 0.233), (0.844, 0.735), (1,1)]`

**效果分析：**
- RGB Curves S曲线在暗部压暗、中间调压缩，然后 HSV 1.85 整体提亮
- 两者的综合效果：暗部仍偏暗，亮部被 1.85x 提亮超过原始值
- 对髪.png（均值 0.85）：曲线后约 0.55（中间调被压），HSV 后约 0.55×1.85 ≈ 1.02

---

### 4.2 ilm.hair.001（ILM 光照图子组）

**内部节点（3个）：**

| 节点 | 类型 |
|------|------|
| Group Input | GROUP_INPUT |
| Image Texture | TEX_IMAGE |
| Group Output | GROUP_OUTPUT |

**连线：**
```
Image Texture[Color] → Group Output[Color]
Image Texture[Alpha] → Group Output[Alpha]
```

**贴图：** `Avatar_Hyacine_00_Hair_LightMap.png.001`
- 平均 RGB: **R=0.946, G=0.234, B=0.014**
- R 通道高（0.946）→ 大部分区域被标记为"受光"
- G 通道低（0.234）→ 光照过渡区较窄
- **B 通道极低（0.014）→ 直接导致高光/亮度增亮完全失效**（见 4.5 节）

---

### 4.3 虚拟日光.001（半兰伯特光照子组）

**内部节点（11个）：**

| 节点 | 类型 | 参数 |
|------|------|------|
| Group Input | GROUP_INPUT | — |
| Geometry | NEW_GEOMETRY | 输出 Normal |
| Attribute | ATTRIBUTE | name=`SUN`, type=GEOMETRY |
| Separate Color | SEPARATE_COLOR | — |
| Vector Math.001 | VECT_MATH | SCALE, Scale=2.0 |
| Vector Math | VECT_MATH | DOT_PRODUCT |
| Map Range | MAP_RANGE | -1→0, 1→1 |
| Group.005 (smoothstep.001) | GROUP | smoothstep(x, 0, 0.2) |
| Mix | MIX | MULTIPLY, Factor=1.0 |
| Math.003 | MATH | MULTIPLY_ADD, 0.5×Value+0.5 |
| Math.001 | MATH | POWER, Value^0.5 |
| Group Output | GROUP_OUTPUT | — |

**连线：**
```
Attribute[SUN向量] → Vector Math.001[Vector]        # SUN方向
Vector Math.001[SCALE×2] → Vector Math[Vector]       # 2*SUN
Geometry[Normal] → Vector Math[Vector]               # 表面法线
Vector Math[DOT_PRODUCT] → Map Range[Value]          # dot(N, 2*SUN)
Map Range[Result] → Mix[A]                           # 映射到[0,1]

Group Input[Image] → Separate Color[Color]           # ILM合成色输入
Separate Color[Green] → smoothstep.001[x]            # G通道
smoothstep.001[Result] → Mix[B]                      # smoothstep(G, 0, 0.2)

Mix[MULTIPLY] → Math.003[Value]                      # 光照 × ILM权重
Math.003[×0.5+0.5] → Math.001[Value]                 # 映射到[0.5,1.0]区间
Math.001[sqrt] → Group Output[半兰伯特光照模型]       # 最终光照值
```

**计算公式：**
```
half_lambert = sqrt(0.5 * dot(N, 2*SUN)映射[0,1] × smoothstep(ILM_G, 0, 0.2) + 0.5)
```

**关键：**
- `SUN` 属性来自 Geometry Nodes 修改器（从场景"灯光"对象计算）
- v41 修复前私模缺此修改器 → SUN=(0,0,0) → 全暗
- ILM G 通道（均值 0.234）经 smoothstep(0, 0.2) 后大部分接近 1.0
- 最终输出范围约 **[0.25, 1.0]**

---

### 4.4 ramp.hair.001（颜色渐变子组）

**内部节点（5个）：**

| 节点 | 类型 |
|------|------|
| Group Input | GROUP_INPUT |
| Image Texture | TEX_IMAGE (Cool Ramp) |
| Image Texture.001 | TEX_IMAGE (Warm Ramp) |
| RGB Curves | CURVE_RGB |
| Group Output | GROUP_OUTPUT |

**连线：**
```
Group Input[Vector] → Image Texture[Vector]          # Cool Ramp（未连线输出，悬空）
Group Input[Vector] → Image Texture.001[Vector]      # Warm Ramp
Image Texture.001[Color] → RGB Curves[Color]         # Warm → 曲线调整
RGB Curves[Color] → Group Output[Color]              # → 输出
```

**Warm Ramp 贴图：** `Avatar_Hyacine_00_Hair_Warm_Ramp.png.001`
- 256×2 像素，平均 RGB: (0.9645, 0.8306, 0.8827)
- **G 通道最低（0.83），比 R 低 13.9%**
- 用半兰伯特光照值作为 U 坐标采样

**RGB Curves 参数：**
- R/G/B：直线无调整
- Combined: `[(0,0), (0.582, 0.343), (1,1)]`
  - 暗部额外压暗（0.58→0.34，-41%）
  - 对整体颜色再压一层

---

### 4.5 matcap.hair.001（球面环境贴图子组）

**内部节点（5个）：**

| 节点 | 类型 |
|------|------|
| Group Input | GROUP_INPUT |
| Texture Coordinate | TEX_COORD | 输出 Normal
| Vector Transform | VECT_TRANSFORM | NORMAL, OBJECT→CAMERA
| Mapping | MAPPING | loc=(0.5,0.5,0), scale=(0.5,0.5,1)
| Image Texture | TEX_IMAGE | hair_s.bmp.001
| Group Output | GROUP_OUTPUT | — |

**连线：**
```
Texture Coordinate[Normal] → Vector Transform[Vector]     # 法线→相机空间
Vector Transform[Vector] → Mapping[Vector]                 # 映射到[0,1]UV
Mapping[Vector] → Image Texture[Vector]                    # 采样matcap
Image Texture[Color] → Group Output[Color]
```

**贴图：** `hair_s.bmp.001`（256×256，平均 RGB=0.139，深灰色）

---

### 4.6 顶层运算链（高光/亮度因子）

```
matcap_color(均值0.139)
    → Math DIVIDE ÷ 0.05, clamp = 2.78          # 理论最大值，但clamp截断
    → Math MULTIPLY × ILM_Blue(均值0.014) ≈ 0.039
    → Math MULTIPLY × (half_lambert > 0.85 ? 1 : 0)  # 只在强光区激活
    → Map Range.001 (0→1.0, 1→2.2)
```

**关键问题：**
- ILM Blue 均值仅 **0.014**，乘以任何值都接近 0
- Map Range.001 的输入几乎永远 ≈ 0
- 0 映射到 To Min = **1.0**
- **亮度因子永远 = 1.0，设计中的 2.2x 增亮完全无法触发**

---

### 4.7 透明度控制

```
hairmask.001 (全黑 RGB=0,0,0)
    → Math.004 MULTIPLY × 0.01 = 0
    → Mix Shader Factor = 0
    → 100% Emission, 0% Transparent
```

hairmask 全黑意味着头发完全不透明，100% 使用 Emission 着色。

---

## 五、颜色变暗因素分析

### 最终颜色公式

```
Emission Color = 校色输出 × Ramp输出 × 亮度因子

其中：
  校色输出 = 髪.png × RGB_Curves_S曲线 × HSV(×1.85)
  Ramp输出 = Warm_Ramp(光照值采样) × Ramp_Curves(蓝压缩)
  亮度因子 = Map Range(matcap/0.05 × ILM_Blue × 光照阈值) → [1.0, 2.2]
             ≈ 1.0（因 ILM_Blue ≈ 0.014）
```

### 变暗因素排序

| 排序 | 因素 | 影响 | 严重度 |
|------|------|------|--------|
| **1** | **ILM Blue ≈ 0.014 → 亮度因子永远=1.0** | 设计中的 2.2x 增亮完全失效，头发缺少高光层 | ★★★★★ |
| **2** | **Warm Ramp 乘法** | 均值(0.96, 0.83, 0.88)，G通道降 17%，乘法永远≤原值 | ★★★★ |
| **3** | **Ramp RGB Curves 蓝色压缩** | Combined 曲线 0.58→0.34（-41%），暗部再压 | ★★★ |
| **4** | **校色 RGB Curves S曲线** | 暗部 0.41→0.17（-59%），中间调 0.67→0.31（-53%） | ★★★ |
| **5** | **Map Range To Min=0.02** | 阴影区接近纯黑（0.02），光照最低值 0.25→映射到 0.26 | ★★ |
| **6** | **matcap 贴图偏暗** | 均值 0.139，但因 ILM Blue 低已无关紧要 | ★ |

### 数值估算

以髪.png 平均值（0.85）为例，受光面（光照值≈1.0）：

```
1. RGB Curves S曲线：0.85 → ~0.80（亮区压缩较小）
2. HSV ×1.85：0.80 × 1.85 = 1.48（增亮）
3. × Warm Ramp(光照=1.0采样右侧)：≈ ×(0.97, 0.95, 0.97) = (1.44, 1.41, 1.44)
4. × Ramp Curves：≈ ×0.90 = (1.29, 1.27, 1.29)
5. × 亮度因子=1.0 = (1.29, 1.27, 1.29)
→ HDR 值 > 1.0，Emission 会显示为亮色
```

背光面（光照值≈0.25）：

```
1. RGB Curves S曲线：0.85 → ~0.80
2. HSV ×1.85：0.80 × 1.85 = 1.48
3. × Warm Ramp(光照=0.25采样偏左)：≈ ×(0.91, 0.74, 0.78) = (1.35, 1.10, 1.15)
4. × Ramp Curves：≈ ×0.75 = (1.01, 0.82, 0.87)
5. × 亮度因子=1.0 = (1.01, 0.82, 0.87)
→ 背光面 G/B 通道低于 1.0，视觉上偏暗偏暖
```

---

## 六、如果想调亮头发的切入点

| 方法 | 操作位置 | 效果 | 风险 |
|------|----------|------|------|
| 提高 HSV Value | 校色.001 内 HSV 节点 | 整体提亮，简单直接 | 过曝 |
| 调亮 Warm Ramp | 替换 Warm Ramp 贴图或加 Brightness 节点 | 乘法基数变大 | 改变色调 |
| Map Range To Min 调大 | 顶层 Map Range 节点 | 阴影区变亮，减少明暗对比 | 失去立体感 |
| Map Range To Max 调大 | 顶层 Map Range 节点 | 整体偏亮，Ramp 采样偏右 | 高光区过亮 |
| 修复 ILM Blue 通道 | 换一张 ILM 贴图（Blue 值更高） | 激活 2.2x 亮度因子，高光区增亮 | 改变高光分布 |
| 降低 Ramp Curves 压缩 | ramp.hair.001 内 RGB Curves | 减少蓝色/暗部压缩 | 色调偏移 |
| 在 Mix.001 后加 Brightness | 顶层加节点 | 最终输出前整体提亮 | 需新增节点 |

---

## 七、子组嵌套关系

```
星铁@Minyu-Shader.hair.001 (顶层, 25节点)
├── 校色.001
│   └── RGB Curves + HSV
├── ilm.hair.001
│   └── ILM LightMap 贴图
├── 虚拟日光.001
│   └── smoothstep.001 (子子组, 20节点)
├── ramp.hair.001
│   └── Warm Ramp + Cool Ramp(悬空) + RGB Curves
├── matcap.hair.001
│   └── 法线变换 → matcap 贴图
└── 顶层运算节点 (Math×5, Map Range×2, Mix×2, ColorRamp, etc.)
```
