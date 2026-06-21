# MMD 标准材质详解

## 使用部位
- slot30(髪+)
- actual_目影
- actual_颜+(MMD版)
- 各种未修复的配件

使用 shader：`MMDShaderDev`

---

## 材质层级

```
MMDShaderDev
├── Diffuse BSDF (漫反射)
├── Glossy BSDF (高光, Factor=0.02)
├── Transparent BSDF (透明混合)
├── Mix Shader (高光混合)
├── Mix Shader (正背面混合)
├── MMDTexUV (Sphere Mapping, 5节点)
├── Ambient Color (环境光)
├── Diffuse Color (漫反射颜色)
└── 各种纹理采样节点
```

---

## 贴图清单

| 贴图类型 | 示例文件 | 尺寸 | 色彩空间 | 用途 |
|---------|---------|------|---------|------|
| Base 纹理 | 各材质不同 | 不定 | sRGB | 基础颜色 + Alpha |
| Toon 贴图 | toon3.png / toon4.png | 800×800 | sRGB | 卡通渐变着色 |
| Sphere 贴图 | 9.JPG / 1.png / mc1.png | 512×512 | Linear | 环境反射高光 |

---

## 信号流图

### 颜色管线

```
[Ambient Color] ─────────────────────┐
                                      │ +
[Diffuse Color] ──> ×0.6 ────────────┤
                                      ▼
                              c0 = ambient + diffuse×0.6
                                      │
                                      ▼ ×
[Base Texture] ─────────────────────> c1 = c0 × base
                                      │
                                      ▼ ×
[Toon Texture] ─────────────────────> c2 = c1 × toon
                                      │
                           ┌──────────┤
                           │          ▼ × (Mul模式)
[Sphere Texture] ─────────┤     c3 = c2 × sphere
                           │          ▼ + (Add模式)
                           └─────> c4 = c2 + sphere
                                      │
                                      ▼ mix
                          final = mix(c3, c4, sphere_mul_add)
                                      │
                                      ▼
[Diffuse BSDF] ◄──────────────────────┤
[Glossy BSDF] ◄── Factor=0.02 ───────┤
                                      │ Mix Shader
                                      ▼
[Mix Shader (Alpha)] ◄── alpha ───────┤
   ├─ 正面: shader result             │
   └─ 背面: Transparent BSDF          │
                                      ▼
                              Material Output
```

### Alpha 管线

```
[Global Alpha] ──────────┐
                          │ ×
[Base Alpha] ────────────┤
                          │ ×
[Toon Alpha] ────────────┤
                          │ ×
[Sphere Alpha] ──────────┤
                          │ ×
[Backfacing Check] ──────┤
  is_front = (backfacing < 0.5) ? 1.0 : 0.0
  show_face = max(is_front, double_sided)
                          │
                          ▼
          alpha = min(show_face, global × base × toon × sphere)
```

### Sphere Mapping（MMDTexUV, 5 节点）

```
[纹理坐标] .Normal
     │
     ▼
[矢量变换] Object → World
     │
     ▼
[映射] Location=(0.5, 0.5, 0), Scale=(0.5, 0.5, 1.0)
     │
     ▼
  Sphere UV ──> [Sphere Texture 采样]
```

---

## 节点详解

### 1. 颜色计算节点

#### Ambient + Diffuse 混合
```
c0 = ambient_color.rgb + diffuse_color.rgb × 0.6
```
- 环境光全量加入，漫反射光衰减到 60%
- 这是 MMD 标准的光照基础

#### Base 纹理混合（预乘 Alpha）
```
c1 = c0 × (1.0 - base_color.a × (1.0 - base_color.rgb))
```
- 使用预乘 Alpha 方式混合，Alpha 越大，贴图颜色占比越高

#### Toon 纹理混合
```
c2 = c1 × (1.0 - toon_color.a × (1.0 - toon_color.rgb))
```
- Toon 贴图提供卡通渐变着色效果

#### Sphere 纹理混合（Mul/Add 双模式）
```
Mul: c3 = c2 × (1.0 - sphere_color.a × (1.0 - sphere_color.rgb))
Add: c4 = c2 + sphere_color.rgb × sphere_color.a
final = mix(c3, c4, sphere_mul_add)   // 0=乘法, 1=加法
```

### 2. BSDF 节点

#### Diffuse BSDF
- 接收最终颜色作为漫反射输入

#### Glossy BSDF
- Factor = 0.02（极低的高光混合比例）
- 提供微弱的镜面反射效果

#### Transparent BSDF
- 用于背面透明混合
- Alpha = 0 时完全透明

### 3. Alpha 节点

#### 背面剔除逻辑
```
is_front = select(0.0, 1.0, backfacing < 0.5)
show_face = max(is_front, double_sided)
alpha = min(show_face, accumulated_alpha)
```
- 正面始终显示
- 背面仅当 `double_sided = 1` 时显示

---

## 颜色公式

### 完整颜色计算

```
// 步骤1: 光照基础
c0 = ambient + diffuse × 0.6

// 步骤2: 贴图混合（预乘Alpha）
c1 = c0 × (1 - base.a × (1 - base.rgb))
c2 = c1 × (1 - toon.a × (1 - toon.rgb))

// 步骤3: Sphere混合（Mul/Add选择）
c3_mul = c2 × (1 - sphere.a × (1 - sphere.rgb))
c4_add = c2 + sphere.rgb × sphere.a
final_color = mix(c3_mul, c4_add, sphere_mul_add)

// 步骤4: 高光
shader_result = mix(final_color, specular_color, 0.02)

// 步骤5: Alpha
alpha = global_alpha × base.a × toon.a × sphere.a
is_front = backfacing < 0.5 ? 1.0 : 0.0
show_face = max(is_front, double_sided)
alpha = min(show_face, alpha)
```

### WGSL 代码

```wgsl
fn mmd_shader_dev(base_color, toon_color, sphere_color, params, backfacing) -> vec4f {
    let c0 = params.ambient_color.rgb + params.diffuse_color.rgb * 0.6;
    let c1 = c0 * (1.0 - base_color.a * (1.0 - base_color.rgb));
    let c2 = c1 * (1.0 - toon_color.a * (1.0 - toon_color.rgb));
    let c3 = c2 * (1.0 - sphere_color.a * (1.0 - sphere_color.rgb));
    let c4 = c2 + sphere_color.rgb * sphere_color.a;
    let final_color = mix(c3, c4, params.sphere_mul_add);
    let spec_factor = 0.02;
    let shader_result = mix(final_color, params.specular_color.rgb, spec_factor);
    var alpha = params.global_alpha * base_color.a * toon_color.a * sphere_color.a;
    let is_front = select(0.0, 1.0, backfacing < 0.5);
    let show_face = max(is_front, params.double_sided);
    alpha = min(show_face, alpha);
    return vec4f(shader_result, alpha);
}
```

---

## 因素分析

| 因素 | 影响方向 | 说明 |
|------|---------|------|
| Ambient Color | 整体提亮 | 环境光全量加入，越大整体越亮 |
| Diffuse Color × 0.6 | 光照明暗 | 漫反射衰减到 60%，控制光照强度 |
| Base Texture | 基础颜色+透明 | 贴图 RGB 提供颜色，A 提供透明度 |
| Toon Texture | 卡通色阶 | 提供渐变着色，Alpha 控制影响强度 |
| Sphere Texture | 环境反射 | Mul 模式暗化，Add 模式提亮高光 |
| sphere_mul_add | 混合模式 | 0=乘法（阴影感），1=加法（高光感） |
| Glossy Factor (0.02) | 镜面高光 | 固定极低值，几乎不影响最终结果 |
| Global Alpha | 全局透明 | 所有 Alpha 的乘法基数 |
| Double Sided | 双面渲染 | 1=双面可见，0=仅正面 |

---

## 调节切入点

### 1. 整体亮度
- **Ambient Color**：增大 → 整体提亮
- **Diffuse Color**：增大 → 光照区域更亮（已衰减到 60%）

### 2. 卡通着色效果
- **Toon 贴图**：更换不同渐变图改变色阶风格
- Toon 贴图的 Alpha 通道控制着色影响强度

### 3. 高光/反射效果
- **Sphere 贴图**：Mul 模式产生柔和阴影感，Add 模式产生高光
- **sphere_mul_add**：在 Mul 和 Add 之间混合
- **Glossy Factor**：0.02 固定极低，几乎无需调整

### 4. 透明度
- **Global Alpha**：控制整体透明度
- **Base Texture Alpha**：贴图自带透明区域
- **Double Sided**：是否显示背面

### 5. 背面显示
- **Backfacing Check**：自动判断正反面
- **Double Sided 参数**：开启后背面也渲染（适用于头发等双面材质）
