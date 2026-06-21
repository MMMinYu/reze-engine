# 眼部 Shader 详解

## 使用部位

| 部位 | 材质名 | Shader 类型 |
|------|--------|------------|
| 目 | actual_目.001 | RGB Curves + 眼睫.001 |
| 白目 | — | 简单贴图直出 + 眼睫.001 |
| 目光 | — | 简单贴图直出 + 眼睫.001 |
| 眉睫 | — | 简单贴图直出 + 眼睫.001 |

---

## 材质层级

```
目 (actual_目.001)
├── Image Texture [颜_独立]
├── RGB Curves (Factor=0.4335)
└── Group [眼睫.001]
    ├── Mix (夹角判断)
    ├── HSV (Value=0.65)
    └── 校色.001

白目 / 目光 / 眉睫
├── Image Texture
└── Group [眼睫.001]
    ├── Mix (夹角判断)
    ├── HSV (Value=0.65)
    └── 校色.001
```

---

## 贴图清单

| 贴图 | 尺寸 | 色彩空间 | 均值 RGB | 用途 |
|------|------|---------|---------|------|
| Avatar_Hyacine_00_Face_Color.png | 1024×1024 | sRGB | 0.971/0.867/0.849 | 眼部基础颜色（颜_独立） |

---

## 信号流图

### 目 (4 节点, 3 连线)

```
[Image Texture]  Avatar_Hyacine_00_Face_Color.png (1024×1024)
     │ base_color
     ▼
[RGB Curves] (Factor=0.4335)
  │  R: 线性（无变化）
  │  G: (0.5682, 0.4632) 压暗
  │  B: (0.487, 0.5392) 微调
  │  A: (0.525, 0.527) 接近线性
     │ curved (混合度 43.35%)
     ▼
[Group: 眼睫.001]
  │
  │ ┌─ Input ──> Reroute ──────────────────────────────────┐
  │ │                                                       │
  │ │ ┌─ [夹角判断] ── sdf_attr_a · sdf_attr_b ──> angle ─┐│
  │ │ │                                                   ││
  │ │ └─ [HSV] Value=0.65 ──> darkened ──────────────────┐││
  │ │                                                     │││
  │ │ └─ Mix: mix(input, darkened, angle) ────────────────┘││
  │ │                                                       │
  │ └─ [校色.001] ──> 蓝色压缩 + HSV×1.85 ─────────────────┘│
  │                                                         │
  ▼                                                         │
[Material Output] ◄──────────────────────────────────────────┘
```

### 白目 / 目光 / 眉睫（简单贴图直出）

```
[Image Texture] ──> [Group: 眼睫.001] ──> [Material Output]
```
无 RGB Curves 中间处理，直接进入眼睫.001。

### 眼睫.001 内部详解

```
Input (color)
  │
  ├──> Reroute
  │      │
  │      ▼
  │    [夹角判断]
  │      sdf_attr_a · sdf_attr_b → dot product → angle ∈ [0,1]
  │      │
  │      ▼ (作为 Mix Factor)
  │
  ├──> [HSV] Value=0.65
  │      │ input_color → darkened (亮度降到 65%)
  │      │
  │      ▼ (作为 Mix Color2)
  │
  ├──> [Mix]
  │      Color1 = input (原始颜色)
  │      Color2 = darkened (压暗后)
  │      Factor = angle (夹角)
  │      │ → 特定角度时混入压暗颜色（眼睫毛阴影效果）
  │      ▼
  │
  └──> [校色.001]
         蓝色压缩 + HSV×1.85
         │
         ▼
       Output
```

---

## 节点详解

### 1. Image Texture

- **纹理**：`Avatar_Hyacine_00_Face_Color.png`（1024×1024, sRGB）
- **颜色空间**：sRGB
- **均值**：R=0.971, G=0.867, B=0.849（偏暖白色）
- **输出**：RGBA 颜色

### 2. RGB Curves（仅「目」使用）

- **Factor**：0.4335（混合度 43.35%，即曲线效果只应用约 43%）
- **R 通道**：线性（无变化）
- **G 通道**：(0.5682, 0.4632) — 中间段压暗，绿色通道整体降低
- **B 通道**：(0.487, 0.5392) — 微调，蓝色通道略有变化
- **A 通道**：(0.525, 0.527) — 接近线性，透明度几乎不变

RGB Curves 的作用：轻微调整眼部色调，降低绿色使眼睛偏暖。

### 3. 眼睫.001 — 夹角判断

- **输入**：sdf_attr_a, sdf_attr_b（SDF 属性向量）
- **算法**：`angle = dot(sdf_attr_a, sdf_attr_b)`
- **输出**：[0, 1] 标量，用于判断眼睫区域

### 4. 眼睫.001 — HSV 调整

- **输入**：原始颜色
- **调整**：Value = 0.65（亮度降到 65%）
- **输出**：darkened（压暗后的颜色）

### 5. 眼睫.001 — 校色.001

- **与头发/衣服的校色相同的算法**
- **蓝色压缩**：降低蓝色通道强度
- **HSV × 1.85**：饱和度或明度放大 1.85 倍

---

## 颜色公式

### 目（带 RGB Curves）

```
base = textureSample(eye_base_tex, sampler, uv)

// RGB Curves（混合度 43.35%）
curved = apply_rgb_curves(base)
mixed_color = mix(base, curved, 0.4335)

// 眼睫着色
angle = dot(sdf_attr_a, sdf_attr_b)
darkened = hsv_adjust(mixed_color, H, S, 0.65)
eyelash_color = mix(mixed_color, darkened, angle)

// 校色
final = color_correction(eyelash_color)
```

### 白目 / 目光 / 眉睫（无 RGB Curves）

```
base = textureSample(tex, sampler, uv)

// 直接进入眼睫着色
angle = dot(sdf_attr_a, sdf_attr_b)
darkened = hsv_adjust(base, H, S, 0.65)
eyelash_color = mix(base, darkened, angle)

// 校色
final = color_correction(eyelash_color)
```

### WGSL 代码

```wgsl
fn eye_part_fragment(in: VertexOutput) -> @location(0) vec4f {
    let base = textureSample(eye_base_tex, eye_sampler, in.uv);
    return eyelash_shade(base, in.sdf_attr_a, in.sdf_attr_b);
}

fn eyelash_shade(input_color, attr_a, attr_b) -> vec4f {
    let angle = check_angle(attr_a, attr_b);
    let darkened = hsv_adjust(input_color, 0.5, 1.0, 0.65);
    let mixed = mix(input_color, darkened, angle);
    return color_correction(mixed);
}

fn eye_with_curves_fragment(in: VertexOutput) -> @location(0) vec4f {
    let base = textureSample(eye_base_tex, eye_sampler, in.uv);
    // RGB Curves R/G/B三通道
    let curved = apply_rgb_curves_eye(base);
    let mixed = mix(base, curved, 0.4335);
    return eyelash_shade(mixed, in.sdf_attr_a, in.sdf_attr_b);
}
```

---

## 因素分析

| 因素 | 影响方向 | 说明 |
|------|---------|------|
| RGB Curves Factor (0.4335) | 色调调整强度 | 越大曲线效果越明显，越大眼睛色调偏移越大 |
| RGB Curves G 压暗 | 色温偏暖 | 降低绿色通道使颜色偏暖/偏红 |
| RGB Curves B 微调 | 色温微调 | 轻微调整蓝色通道 |
| sdf_attr_a · sdf_attr_b | 眼睫阴影范围 | 点积越大，眼睫阴影区域越广 |
| HSV Value (0.65) | 眼睫阴影深度 | 值越低阴影越深（当前 65% 亮度） |
| 校色.001 蓝色压缩 | 整体色调 | 与头发/衣服一致的校色处理 |
| 校色.001 HSV×1.85 | 饱和度/明度 | 放大效果使颜色更鲜明 |
| Face 贴图均值 (0.971/0.867/0.849) | 基础色温 | 贴图本身偏暖白色 |

---

## 调节切入点

### 1. 眼部色调（仅「目」）
- **RGB Curves Factor**：增大 → 曲线效果更强，色调偏移更明显
- **RGB Curves G 通道**：调整绿色压暗程度，控制色温
- **RGB Curves B 通道**：微调蓝色通道

### 2. 眼睫阴影效果
- **sdf_attr_a / sdf_attr_b**：调整 SDF 属性影响眼睫阴影范围
- **HSV Value (0.65)**：降低 → 眼睫阴影更深；增大 → 阴影更浅
- **angle 的 dot product**：改变点积参数影响阴影分布形状

### 3. 整体颜色风格
- **校色.001**：调整蓝色压缩和 HSV×1.85 参数
- **Face 贴图**：更换贴图改变基础颜色

### 4. 简单眼部部件（白目/目光/眉睫）
- 这些部件无 RGB Curves，颜色调整只能通过：
  - 更换贴图
  - 调整校色.001 参数
  - 调整眼睫.001 中的 HSV 和夹角参数
