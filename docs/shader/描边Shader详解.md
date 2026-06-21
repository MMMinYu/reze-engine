# 描边 Shader 详解

## 使用部位

| 材质名 | 描边对象 |
|--------|---------|
| edge_clothes.001 | 衣服描边 |
| edge_clothes2.001 | 衣服2描边 |
| edge_skin.001 | 皮肤描边 |
| edge_hair.001 | 头发描边 |

---

## 材质层级

```
描边 Shader 家族
├── edge_clothes.001  (8节点, 7连线) — ramp + ilm + RGB Curves
├── edge_clothes2.001 (8节点, 7连线) — ramp2 + Sparkle ilm + RGB Curves
├── edge_skin.001     (7节点, 6连线) — ramp(无ilm) + RGB Curves
└── edge_hair.001     (6节点, 5连线) — 纯色 RGB (最简结构)
```

---

## 贴图清单

| 材质 | 使用的贴图 | 用途 |
|------|-----------|------|
| edge_clothes.001 | LightMap 贴图 | ILM 信息驱动 ramp |
| edge_clothes2.001 | Sparkle LightMap | ILM 信息驱动 ramp |
| edge_skin.001 | 无（alpha=0.0） | 纯 ramp 着色 |
| edge_hair.001 | 无 | 纯色 RGB |

---

## 信号流图

### edge_clothes.001 (8 节点, 7 连线)

```
[Group: ilm.clothes.003] (LightMap贴图)
     │ ilm_value (alpha通道)
     ▼
[Group.009: ramp.003] (Value=0.5, alpha输入)
     │ ramp_color
     ▼
[RGB Curves] (Alpha曲线: (0.7625, 0.218))
     │ curved_color
     ├──> [Material Output] (正面)
     └──> [Mix Shader] (背面透明混合)
              ├──> 正面: curved_color
              └──> 背面: Transparent BSDF
```

### edge_clothes2.001 (8 节点, 7 连线)

```
[Group: ilm.clothes.003] (Sparkle LightMap贴图)
     │ ilm_value (alpha通道)
     ▼
[Group.009: ramp.003] (Value=0.5, alpha输入)
     │ ramp_color
     ▼
[RGB Curves] (Alpha曲线: (0.7625, 0.218))
     │ curved_color
     ├──> [Material Output] (正面)
     └──> [Mix Shader] (背面透明混合)
```

结构与 edge_clothes.001 相同，但使用 Sparkle LightMap。

### edge_skin.001 (7 节点, 6 连线)

```
[Group.009: ramp.003] (Value=0.5, alpha=0.0 无ilm贴图输入)
     │ ramp_color
     ▼
[RGB Curves] (Alpha曲线: (0.7458, 0.2267))
     │ curved_color
     ├──> [Material Output] (正面)
     └──> [Mix Shader] (正面+背面)
```

### edge_hair.001 (6 节点, 5 连线) — 最简结构

```
[RGB] (纯黑 0,0,0)
     │ edge_color
     ├──> [Material Output] (正面)
     └──> [Mix Shader] (背面透明混合)
              ├──> 正面: 纯黑
              └──> 背面: Transparent BSDF
```

---

## 节点详解

### 1. ilm.clothes.003（仅 clothes/clothes2）

- **输入**：LightMap 贴图（UV 采样）
- **输出**：ILM 值（alpha 通道用于 ramp 驱动）
- **edge_clothes.001**：使用标准 LightMap
- **edge_clothes2.001**：使用 Sparkle LightMap
- **edge_skin / edge_hair**：不使用此节点

### 2. ramp.003

- **Value 输入**：0.5（固定中间值）
- **alpha 输入**：
  - edge_clothes: 来自 ilm.clothes.003 的 alpha
  - edge_skin: 0.0（无 ILM）
- **作用**：将固定亮度值 0.5 通过 ramp 纹理映射为描边颜色
- **输出**：ramp_color

### 3. RGB Curves

仅 Alpha 通道有自定义曲线，RGB 通道线性。

| 材质 | 曲线控制点 | 效果 |
|------|-----------|------|
| edge_clothes | (0,0)(0.7625, 0.218)(1,1) | 中间段大幅压暗透明度 |
| edge_clothes2 | (0.7625, 0.218) | 同上 |
| edge_skin | (0,0)(0.7458, 0.2267)(1,1) | 中间段大幅压暗透明度 |
| edge_hair | 无 RGB Curves | 不使用 |

Alpha 曲线效果：将描边的透明度在中间亮度区域大幅降低，使描边在柔和区域更透明。

### 4. Mix Shader（正背面混合）

所有描边材质都有正背面混合：
- **正面**：显示计算后的描边颜色
- **背面**：Transparent BSDF（完全透明）
- **判断**：基于几何法线和视线方向的点积判断正反面

### 5. 纯色 RGB（仅 edge_hair）

- **颜色**：(0, 0, 0) 纯黑
- **无任何计算**：最简单的描边，直接输出黑色

---

## 颜色公式

### edge_clothes / edge_clothes2

```
// ILM 采样
ilm = textureSample(edge_ilm_tex, edge_sampler, uv)

// Ramp 着色
ramp_color = ramp_shade(0.5, ilm.a, edge_ramp_tex, edge_sampler)

// RGB Curves B通道: (0,0)(0.7625,0.218)(1,1)
curved = apply_blue_curve(ramp_color, 0.7625, 0.218)

// 正背面混合
backfacing = is_backfacing(normal, view_dir)
final = mix(curved, vec4f(1,1,1,0), backfacing)
```

### edge_skin

```
// Ramp 着色（无 ILM）
ramp_color = ramp_shade(0.5, 0.0, edge_ramp_tex, edge_sampler)

// RGB Curves B通道: (0,0)(0.7458,0.2267)(1,1)
curved = apply_blue_curve(ramp_color, 0.7458, 0.2267)

// 正背面混合
backfacing = is_backfacing(normal, view_dir)
final = mix(curved, vec4f(1,1,1,0), backfacing)
```

### edge_hair

```
// 纯色输出
backfacing = is_backfacing(normal, view_dir)
final = mix(vec4f(0,0,0,1), vec4f(1,1,1,0), backfacing)
```

### WGSL 代码

```wgsl
fn edge_clothes_fragment(in) -> vec4f {
    let ilm = textureSample(edge_ilm_tex, edge_sampler, in.uv);
    let ramp_color = ramp_shade(0.5, ilm.a, edge_ramp_tex, edge_sampler);
    // RGB Curves B: (0,0)(0.7625,0.218)(1,1)
    let curved = apply_blue_curve(ramp_color, 0.7625, 0.218);
    let backfacing = is_backfacing(in.normal, in.view_dir);
    return mix(curved, vec4f(1,1,1,0), backfacing);
}

fn edge_skin_fragment(in) -> vec4f {
    let ramp_color = ramp_shade(0.5, 0.0, edge_ramp_tex, edge_sampler);
    // RGB Curves B: (0,0)(0.7458,0.2267)(1,1)
    let curved = apply_blue_curve(ramp_color, 0.7458, 0.2267);
    let backfacing = is_backfacing(in.normal, in.view_dir);
    return mix(curved, vec4f(1,1,1,0), backfacing);
}

fn edge_hair_fragment(in) -> vec4f {
    let backfacing = is_backfacing(in.normal, in.view_dir);
    return mix(edge_color, vec4f(1,1,1,0), backfacing);
}
```

---

## 三者差异对比

| 特征 | edge_clothes | edge_clothes2 | edge_skin | edge_hair |
|------|-------------|---------------|-----------|-----------|
| 颜色来源 | ramp + ilm | ramp2 + Sparkle ilm | ramp(无ilm) | 纯色 RGB |
| ILM 贴图 | LightMap | Sparkle LightMap | 无 | 无 |
| ramp Value | 0.5 | 0.5 | 0.5 | 无 |
| ramp alpha | ilm.a | ilm.a | 0.0 | 无 |
| RGB Curves | (0.7625, 0.218) | (0.7625, 0.218) | (0.7458, 0.2267) | 无 |
| 输出数量 | 2(正+背) | 2(正+背) | 2(正+背) | 2(正+背) |
| 节点数 | 8 | 8 | 7 | 6 |
| 连线数 | 7 | 7 | 6 | 5 |

---

## 因素分析

| 因素 | 影响方向 | 适用材质 | 说明 |
|------|---------|---------|------|
| LightMap alpha | 描边明暗变化 | clothes/clothes2 | ILM 信息驱动描边的 ramp 着色 |
| ramp Value (0.5) | 基础亮度 | clothes/clothes2/skin | 固定中间值，通过 ramp 纹理映射 |
| RGB Curves Alpha | 描边透明度 | clothes/clothes2/skin | 中间段大幅压暗，使描边更通透 |
| RGB Curves 控制点 | 透明度曲线形状 | clothes/clothes2/skin | 控制点位置决定压暗区域和程度 |
| 纯色 RGB (0,0,0) | 描边颜色 | hair | 头发描边固定为纯黑 |
| 正背面判断 | 描边可见性 | 全部 | 背面描边透明，仅正面可见 |
| ramp 纹理 | 描边色调 | clothes/clothes2/skin | 不同 ramp 纹理产生不同色调 |

---

## 调节切入点

### 1. 描边颜色深浅
- **ramp Value (0.5)**：增大 → 描边颜色更亮；减小 → 描边更暗
- **ramp 纹理**：更换不同 ramp 纹理改变描边色调

### 2. 描边透明度
- **RGB Curves Alpha 控制点**：
  - edge_clothes: (0.7625, 0.218) — 控制点越低，中间亮度区域越透明
  - edge_skin: (0.7458, 0.2267) — 类似但略有不同
- 调整控制点的 Y 值（0.218 / 0.2267）可改变压暗程度

### 3. 衣服描边的 ILM 驱动
- **ilm.clothes.003**：更换 LightMap 贴图改变描边的明暗变化模式
- **Sparkle LightMap**：edge_clothes2 使用不同的 LightMap 产生不同效果

### 4. 头发描边
- **RGB 颜色节点**：当前纯黑 (0,0,0)，可改为其他颜色实现彩色描边
- 头发描边无调节参数，最简单的结构

### 5. 皮肤描边
- **alpha=0.0**：无 ILM 输入，描边颜色完全由 ramp 决定
- **RGB Curves**：与衣服描边略有不同的控制点，使皮肤描边稍浅
