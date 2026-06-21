# 衣服 Shader 详解

> 顶层节点组：`星铁@Minyu-Shader.clothes.001`（37 节点，38 连线）

---

## 1. 材质层级

被最多部位共用的 shader，覆盖以下 slot / 材质名：

| Slot | 部位 |
|------|------|
| slot11 | 脖子 |
| slot31 | 帽子 |
| slot39 | 领结 |
| slot52 | 披风+ |
| slot2 | 乳首结 |
| slot3 | mat1 |
| slot4 | 口球 |
| slot5 | 口枷 |
| slot6-10 | 眼罩系列 |

---

## 2. 贴图清单

| 贴图文件名 | 尺寸 | 色彩空间 | 平均 RGB | 用途 |
|---|---|---|---|---|
| `Avatar_Hyacine_00_Body_Color_Stockings.png` | 1024×512 | sRGB | (0.077, 0.043, 0.730) | 主纹理（UV×50 平铺 + 原始 UV） |
| `Avatar_Hyacine_00_Body_Color_mask.png` | 1024×512 | sRGB | (0.007, 0.007, 0.007) | 遮罩（几乎全黑，**未连线到输出**） |
| `Avatar_Hyacine_00_Body_LightMap_L.png` | 4096×2048 | Non-Color | — | ILM 光照图（ilm.clothes.001 加载） |
| `Avatar_Hyacine_00_Body_Warm_Ramp.png` | 256×16 | sRGB | (0.921, 0.865, 0.901) | 暖色 Ramp（**实际使用**） |
| `Avatar_Hyacine_00_Body_Cool_Ramp.png` | 256×16 | sRGB | (0.913, 0.885, 0.933) | 冷色 Ramp（**未使用**） |
| `Avatar_Tex_MetalMap.tga` | 256×256 | Non-Color | (0.395, 0.395, 0.395) | 金属 Matcap（**未连线到输出**） |
| `hair_s.bmp` | 256×256 | sRGB | (0.142, 0.142, 0.142) | 头发 Matcap（**未连线到输出**） |

### 贴图来源

> 按铁律 1：全部使用私模默认贴图（`D:\MMD\模型\mobius星穹风堇密码123改后缀 (2)\星穹 风堇1.0 by_mobius\tex\`）

---

## 3. 完整信号流图

```
                              ┌──────────────────────────────────────────────────┐
                              │              Group Input                         │
                              │              输出: Color                         │
                              └────────┬─────────────────────┬───────────────────┘
                                       │                     │
                                       ▼                     ▼
                              ┌────────────────┐    ┌──────────────────┐
                              │  校色.001 #20  │    │  ilm.clothes.001 │
                              │ RGB Curves×2   │    │      #5          │
                              │ HSV(V=1.85)    │    │  输出:Color,Alpha│
                              └───────┬────────┘    └──┬────────────┬──┘
                                      │                │            │
                                      ▼                ▼            ▼
┌─────────────────────────┐   ┌──────────────┐  ┌──────────┐  ┌──────────────┐
│ ilm.clothes.001.Color ──┼──►│ 虚拟日光.001 │  │ Separate │  │Math COMPARE │
│                         │   │    #19       │  │ Color #18│  │ 0.55 vs 0.05│
│                         │   └──────┬───────┘  └──┬───┬───┘  └──────┬───────┘
│                         │          │              │   │             │
│                         │          ▼              ▼   ▼             ▼
│                         │  ┌──────────────┐  ┌─────────┐     ┌──────────┐
│                         │  │smoothstep.001│  │Math #17 │     │ Factor   │
│                         │  │  a=0,b=1 #0  │  │ G * B   │     │          │
│                         │  └──────┬───────┘  └────┬────┘     └────┬─────┘
│                         │         │               │               │
│                         │         ▼               ▼               ▼
│                         │  ┌──────────────────────────┐   ┌──────────────┐
│                         │  │     ramp.001 #36         │   │  Mix.003 #10 │
│                         │  │  ramp采样 -> ramp.clothes│   │  乘暖色      │
│                         │  │  -> RGB Curves×2         │   │ (1,.86,.61)  │
│                         │  └──────────┬───────────────┘   └──────┬───────┘
│                         │             │                           │
│                         │             ▼                           │
│                         │      ┌──────────────┐                  │
│                         │      │   Mix #11    │◄─────────────────┘
│                         │      │ 乘 ramp 结果 │
│                         │      └──────┬───────┘
│                         │             │
│                         │             ▼
│                         │      ┌──────────────┐
│                         │      │  Mix.002 #32 │◄── mask 贴图 #31
│                         │      │ 乘高光强度   │
│                         │      └──────┬───────┘
│                         │             │
└─────────────────────────┼─────────────┼───────────────────────────────────
                          │             │
                          │             ▼
                          │  ┌───────────────────────┐
                          │  │    Mix.007 #33        │
                          │  │ ADD 菲涅尔 Factor=0.25│
                          │  └───────────┬───────────┘
                          │              │
                          │              ▼
                          │     ┌─────────────────┐
                          │     │ Group Output #34│
                          │     │    Result       │
                          │     └─────────────────┘
                          │
                          │  ┌─── 菲涅尔支线 ──────────────────────────────┐
                          │  │                                             │
                          │  │  Layer Weight #30 ──► Color Ramp #29       │
                          │  │  (Facing,0.96)       (白→黑)               │
                          │  │                      │                      │
                          │  │  Stockings 贴图 #22 (UV×50)                │
                          │  │     └──► Separate #21 (Blue)               │
                          │  │              │                               │
                          │  │  Stockings 贴图 #25 (原始UV)               │
                          │  │     └──► Separate #27 (R,G)                │
                          │  │              │                               │
                          │  │  Blue×Red ──► Mix.004 #26                  │
                          │  │                │                             │
                          │  │  ×Green ──► Mix.005 #28                     │
                          │  │                │                             │
                          │  │  ColorRamp×Stockings ──► Mix.006 #35       │
                          │  │                          │                   │
                          │  └──────────────────────────┼──────────────────┘
                          │                             │
                          └─────────────────────────────┘

─── 高光细节支线 ──────────────────────────────────────────────────

  布林冯光照模型.001 #7
        │
        ▼
  Math POWER #15 (x^30)
        │
        ▼
  smoothstep.001 #13 (a=0.06, b=0.10)
        │
        ▼
  smoothstep(0,1) #16 ←── ilm G×B (#17)
        │
        ▼
  Mix.001 #14 (相乘)
        │
        ▼
  Map Range #12 (1~20) ──► Mix.002.B
```

---

## 4. 逐节点 / 子组详解

### 4.1 顶层节点清单

| # | 节点名 | 类型 | 子组 / 备注 | 关键参数 |
|---|--------|------|-------------|----------|
| 0 | Group.005 | GROUP | smoothstep.001 | a=0, b=1 |
| 1 | Group.003 | GROUP | matcap.001 | 无连线，未使用 |
| 2 | Group.004 | GROUP | matcap.hair.001 | 无连线，未使用 |
| 3 | Reroute.001 | REROUTE | ilm Color → Separate Color + 虚拟日光 | — |
| 4 | Group Input | GROUP_INPUT | 输出: Color | — |
| 5 | Group.008 | GROUP | ilm.clothes.001 | 输出: Color, Alpha |
| 6 | Reroute.002 | REROUTE | 布林冯 Value | — |
| 7 | Group | GROUP | 布林冯光照模型.001 | 输出: Value |
| 8 | Reroute | REROUTE | ilm Alpha | — |
| 9 | Math.001 | MATH | COMPARE | 0.55 vs 0.05 |
| 10 | Mix.003 | MIX | MULTIPLY / RGBA | 校色结果 × 暖色(1.0, 0.8608, 0.6069) |
| 11 | Mix | MIX | MULTIPLY / RGBA | Mix.003 结果 × ramp 结果 |
| 12 | Map Range.001 | MAP_RANGE | LINEAR, clamp=True | 0~1 → 1~20 |
| 13 | Group.007 | GROUP | smoothstep.001 | a=0.06, b=0.10 |
| 14 | Mix.001 | MIX | MULTIPLY / RGBA | smoothstep × smoothstep |
| 15 | Math | MATH | POWER | x^30 |
| 16 | Group.006 | GROUP | smoothstep.001 | a=0, b=1 |
| 17 | Math.002 | MATH | MULTIPLY | Green × Blue |
| 18 | Separate Color | SEPARATE_COLOR | RGB | 分离 ilm Color 的 RGB |
| 19 | Group.001 | GROUP | 虚拟日光.001 | 半兰伯特光照模型 |
| 20 | Group.002 | GROUP | 校色.001 | RGB Curves + HSV |
| 21 | Separate Color.001 | SEPARATE_COLOR | RGB | Stockings Blue 通道 |
| 22 | Image Texture.001 | TEX_IMAGE | Stockings 贴图 | 1024×512, UV×50 |
| 23 | Mapping | MAPPING | POINT | Scale=(50,50,50) |
| 24 | Texture Coordinate | TEX_COORD | UV 输出 | — |
| 25 | Image Texture.002 | TEX_IMAGE | Stockings 贴图 | 1024×512, 原始 UV |
| 26 | Mix.004 | MIX | MULTIPLY / RGBA | Stockings.Blue × Stockings2.Red |
| 27 | Separate Color.002 | SEPARATE_COLOR | RGB | Stockings2 的 R 和 G |
| 28 | Mix.005 | MIX | MULTIPLY / RGBA | Mix.004 × Stockings2.Green |
| 29 | Color Ramp | VALTORGB | 白(0.0) → 黑(1.0) | — |
| 30 | Layer Weight | LAYER_WEIGHT | Blend=0.96, Facing | — |
| 31 | Image Texture | TEX_IMAGE | mask 贴图 | 1024×512 |
| 32 | Mix.002 | MIX | MULTIPLY / RGBA | 主色 × 高光强度 |
| 33 | Mix.007 | MIX | ADD / RGBA, Factor=0.25 | 最终色 + 菲涅尔 |
| 34 | Group Output | GROUP_OUTPUT | Result | — |
| 35 | Mix.006 | MIX | MULTIPLY / RGBA | 菲涅尔 × Stockings |
| 36 | Group.009 | GROUP | ramp.001 | Value + alpha |

### 4.2 子组详解

---

#### 4.2.1 ilm.clothes.001（3 节点）

- **功能**：加载 ILM 光照贴图
- **加载贴图**：`Avatar_Hyacine_00_Body_LightMap_L.png`（4096×2048, Non-Color）
- **输出**：Color（ILM RGB 三通道）、Alpha（ILM Alpha 通道）

---

#### 4.2.2 虚拟日光.001（12 节点）

- **功能**：半兰伯特光照模型
- **流程**：SUN 属性向量 × Scale(2) → Dot(Normal) → Map Range(-1~1 → 0~1) → Multiply(smoothstep)
- **smoothstep 参数**：a=0, b=0.20
- **输出**：半兰伯特光照值（0~1）

---

#### 4.2.3 布林冯光照模型.001（7 节点）

- **功能**：Blinn-Phong 高光
- **流程**：SUN + Incoming → ADD → NORMALIZE → Dot(Normal) → 高光值
- **输出**：Value（高光强度，原始值经 x^30 后极锐利）

---

#### 4.2.4 校色.001（5 节点）

- **功能**：对输入 Color 做 RGB 曲线校正 + HSV 调整
- **RGB Curves Blue**：控制点 `(0,0) (0.411,0.166) (0.669,0.314) (0.885,0.805) (1,1)`
- **RGB Curves.001 Blue**：控制点 `(0,0) (0.477,0.233) (0.844,0.735) (1,1)`
- **HSV**：Hue=0.5, Sat=1.0, **Value=1.85**（大幅增亮）

---

#### 4.2.5 ramp.001（9 节点）

- **功能**：Ramp 着色，将光照值映射为颜色
- **流程**：Map Range(Value → 0.02~0.99) + ramp 采样(alpha) → Combine XYZ → ramp.clothes
- **RGB Curves Blue**：控制点 `(0,0) (0.717,0.424) (1,1)`
- **RGB Curves.001 Blue**：控制点 `(0,0) (0.563,0.400) (1,1)`

---

#### 4.2.6 ramp.clothes.001（4 节点）

- **功能**：加载 Ramp 贴图并采样
- **Cool Ramp**：`Avatar_Hyacine_00_Body_Cool_Ramp.png`（256×16, **未使用**）
- **Warm Ramp**：`Avatar_Hyacine_00_Body_Warm_Ramp.png`（256×16, **实际使用**）

---

#### 4.2.7 ramp 采样.001（32 节点）

- **功能**：8 区间阶梯采样器
- **阈值**：0.10, 0.20, 0.33, 0.45, 0.58, 0.70, 0.85
- **原理**：将连续光照值离散化为 8 个阶梯，每阶对应 Ramp 贴图上的一个采样点

---

#### 4.2.8 smoothstep.001（19 节点）

- **功能**：标准 smoothstep 插值
- **公式**：`smoothstep(x, a, b) = t² × (3 - 2t)`，其中 `t = clamp((x - a) / (b - a), 0, 1)`

---

#### 4.2.9 matcap.001（7 节点）— 未连线到输出

- **功能**：金属 Matcap 环境映射
- **流程**：Normal → Vector Transform → Mapping → MetalMap 贴图
- **贴图**：`Avatar_Tex_MetalMap.tga`（256×256, 平均灰度 0.395）

---

#### 4.2.10 matcap.hair.001（6 节点）— 未连线到输出

- **功能**：头发 Matcap 环境映射
- **贴图**：`hair_s.bmp`（256×256, 平均灰度 0.142）

---

## 5. 颜色公式

### 主色通路

```
corrected_color = HSV(Curves(base_color), V=1.85)

compare_factor = |ilm_alpha - 0.55| < 0.05  ?  1.0 : 0.0

warm_tinted = corrected_color × mix(1.0, warm_tint, compare_factor)
             where warm_tint = (1.0, 0.8608, 0.6069)

half_lambert = virtual_sunlight(ilm_color, normal)

ramp_color = ramp_shade(smoothstep(half_lambert, 0, 1), ilm_alpha)

main_color = warm_tinted × ramp_color
```

### 高光通路

```
spec_raw = blinn_phong(light_dir, normal, view_dir)

spec_sharp = pow(spec_raw, 30)

spec_masked = smoothstep(spec_sharp, 0.06, 0.10) × smoothstep(ilm.g × ilm.b, 0, 1)

spec_intensity = map_range(spec_masked, 0, 1, 1, 20)

spec_result = main_color × spec_intensity
```

### 菲涅尔通路

```
fresnel = layer_weight_facing(normal, view_dir, blend=0.96)

fresnel_ramp = color_ramp(fresnel)     // 白(0) → 黑(1)

stockings_1 = stockings_tex(uv × 50).blue

stockings_2 = stockings_tex(uv).red × stockings_tex(uv).green

stockings_combined = stockings_1 × stockings_2

fresnel_final = fresnel_ramp × stockings_combined
```

### 最终合成

```
final = spec_result + fresnel_final × 0.25
```

### 完整公式

$$\text{final} = \underbrace{\text{warm}(\text{curves}(C) \times 1.85)}_{\text{校色+暖色调}} \times \underbrace{\text{ramp}(S(\text{HL}))}_{\text{Ramp着色}} \times \underbrace{S(\text{BP}^{30}, 0.06, 0.10) \cdot S(G \cdot B)}_{\text{高光掩码}} \times \underbrace{M(1,20)}_{\text{高光强度}} + 0.25 \times \underbrace{R(F_{0.96})}_{\text{菲涅尔Ramp}} \times \underbrace{S_1^{B} \cdot S_2^{R} \cdot S_2^{G}}_{\text{Stockings细节}}$$

其中 $S$ = smoothstep，$M$ = Map Range，$R$ = Color Ramp，$F$ = Layer Weight Facing，HL = 半兰伯特，BP = Blinn-Phong

---

## 6. 变暗 / 变亮因素分析

### 变亮因素

| 因素 | 节点 | 效果 | 量级 |
|------|------|------|------|
| HSV Value=1.85 | 校色.001 #20 | 全局增亮 85% | ★★★★★ |
| 暖色乘法 | Mix.003 #10 | R 不变，G×0.86，B×0.61 | ★★★ |
| Ramp 着色 | ramp.001 #36 | 光照越强越亮（Warm Ramp 平均 RGB≈0.9） | ★★★ |
| 高光强度 1~20 | Map Range #12 | 高光区域极端增亮 | ★★★★★ |
| ADD 菲涅尔 25% | Mix.007 #33 | 边缘额外叠亮 | ★★ |

### 变暗因素

| 因素 | 节点 | 效果 | 量级 |
|------|------|------|------|
| COMPARE 掩码 | Math.001 #9 | ilm_alpha 不在 0.55 附近时不乘暖色（略暗） | ★ |
| 高光阈值 0.06~0.10 | smoothstep #13 | 高光只出现在极窄范围，其余区域无高光 | ★★ |
| Color Ramp 白→黑 | Color Ramp #29 | 菲涅尔越强越暗（但被 Stockings 掩码控制） | ★★ |
| mask 贴图几乎全黑 | Image Texture #31 | 遮罩使部分区域乘以接近 0 的值 | ★★★ |

### 综合判断

- **整体偏亮**：HSV Value=1.85 + 暖色乘法 + Ramp 着色共同作用
- **高光极锐利**：x^30 次幂 + 1~20 映射，高光区域非常小但极端亮
- **mask 贴图（几乎全黑）作为乘数可能导致整体偏暗**，需确认 mask 是否实际连线到输出

---

## 7. 调节切入点

### 整体亮度

| 位置 | 操作 | 效果 |
|------|------|------|
| 校色.001 → HSV Value | 降低 1.85 → 1.0~1.4 | 降低全局亮度 |
| Mix.003 暖色值 | 调整 (1.0, 0.86, 0.61) | 改变整体色调偏暖程度 |

### 高光

| 位置 | 操作 | 效果 |
|------|------|------|
| Math POWER #15 指数 | 30 → 更小（如 10~15） | 高光区域扩大、变柔和 |
| smoothstep #13 阈值 | (0.06, 0.10) → 更宽（如 0.04, 0.20） | 高光过渡更宽 |
| Map Range #12 范围 | (1, 20) → (1, 5~10) | 降低高光峰值亮度 |

### Ramp 着色

| 位置 | 操作 | 效果 |
|------|------|------|
| ramp.clothes.001 贴图 | 替换 Warm Ramp 贴图 | 改变明暗过渡色调 |
| ramp.001 → RGB Curves | 调整 Blue 曲线 | 改变蓝色通道的 Ramp 映射 |

### 菲涅尔边缘

| 位置 | 操作 | 效果 |
|------|------|------|
| Layer Weight Blend #30 | 0.96 → 更小（如 0.5~0.8） | 菲涅尔边缘更宽 |
| Mix.007 Factor #33 | 0.25 → 更小或更大 | 菲涅尔叠加强度 |

### Stockings 细节

| 位置 | 操作 | 效果 |
|------|------|------|
| Mapping Scale #23 | (50,50,50) → 更小 | Stockings 纹理放大（细节减少） |
| Stockings 贴图 | 替换贴图 | 改变丝袜纹理图案 |

---

## 附：WGSL 对应代码

```wgsl
fn clothes_fragment(in: VertexOutput) -> @location(0) vec4f {
    let ilm = textureSample(ilm_tex, clothes_tex_sampler, in.uv);
    let half_lambert = virtual_sunlight(ilm, in.light_dir, in.normal);
    let corrected = color_correction(clothes_uniforms.base_color);
    let s_half_lambert = smoothstep_custom(0.0, 1.0, half_lambert);
    let bp = blinn_phong(in.light_dir, in.normal, in.view_dir);
    let s_detail = smoothstep_custom(0.06, 0.1, pow(bp, 30.0));
    let s_spec = smoothstep_custom(0.0, 1.0, ilm.g * ilm.b);
    let compare_factor = select(0.0, 1.0, abs(ilm_alpha - 0.55) < 0.05);
    let mix_003 = corrected * mix(vec4f(1.0), clothes_uniforms.warm_tint, compare_factor);
    let ramp_color = ramp_shade(s_half_lambert, ilm_alpha, ramp_clothes_tex, clothes_tex_sampler);
    let mix_main = mix_003 * ramp_color;
    let detail_mix = s_detail * s_spec;
    let detail_mapped = map_range(detail_mix, 0.0, 1.0, 1.0, 20.0);
    let lm1 = textureSample(lightmap_tex, clothes_tex_sampler, in.uv * 50.0);
    let lm2 = textureSample(lightmap_tex, clothes_tex_sampler, in.uv);
    let lm_detail = lm1.b * lm2.r;
    let lm_combined = lm_detail * lm2.g;
    let fresnel = layer_weight_facing(0.96, in.normal, in.view_dir);
    let fresnel_color = color_ramp_clothes_fresnel(fresnel);
    let fresnel_mix = vec4f(fresnel_color) * vec4f(lm_combined);
    let detail_result = mix_main * vec4f(detail_mapped);
    let final_result = detail_result + fresnel_mix * 0.25;
    return final_result;
}
```
