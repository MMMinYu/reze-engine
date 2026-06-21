# 脸 Shader 详解

> Shader 名称：`星铁@Minyu-Shader.face` / `星铁@Minyu-Shader.face.001`
> 记录日期：2026-06-12

---

## 一、材质层级

| Slot / 材质名 | Shader | 备注 |
|---------------|--------|------|
| `actual_颜.001` | `星铁@Minyu-Shader.face` | 主脸 shader |
| `颜` | `星铁@Minyu-Shader.face.001` | 与 face 连线相同，子组后缀 .001 |

---

## 二、贴图清单

| 贴图 | 尺寸 | 色彩空间 | 平均 RGB | 用途 |
|------|------|---------|---------|------|
| `Avatar_Hyacine_00_Face_Color.png` | 1024×1024 | sRGB | (0.971, 0.867, 0.849) | 脸部基础色（Color 输入） |
| `W_140_Girl_FaceMap_00.png` | 1024×1024 | — | (0, 0, 0) | SDF FaceMap（实际使用 Color + Alpha） |
| `Avatar_Hyacine_00_Body_Warm_Ramp.png` | 256×16 | sRGB | (0.929, 0.827, 0.857) | 暖色 Ramp |
| `Avatar_Hyacine_00_Body_LightMap_L.png` | 4096×2048 | Non-Color | (1.0, 0.391, 0.078) | ILM |

> 注意：SDF.tex.002 内共加载 9 张 FaceMap，但仅 `W_140_Girl_FaceMap_00.png` 的 Color 和 Alpha 通道实际接入连线，其余 8 张已加载未连接。

---

## 三、完整信号流图

```
┌─────────────────────────────────────────────────────────────────────┐
│                     星铁@Minyu-Shader.face（19 节点，9 连线）          │
│                                                                     │
│  输入: Color（基础贴图色）                                              │
│       │                                                             │
│       ▼                                                             │
│  ┌──────────┐                                                      │
│  │ 校色.002 │───[Color]──▶ Mix[A]                                   │
│  └──────────┘                │                                     │
│                              │                                     │
│  ┌──────────┐               │                                     │
│  │ SDF.002  │──[Value]─▶ Map Range[Value]──▶ ramp.002[Value]       │
│  │          │               │                    │                  │
│  │          │──[Color]─▶鼻尖阴影.002[Color]       │                  │
│  └──────────┘               │                    │                  │
│                              │                    │                  │
│                              │           ramp.002[Color]──▶ Mix[B]  │
│                              │                           │          │
│                              │                Mix[Result]──▶ Mix.001[A]│
│                              │                           │          │
│                    鼻尖阴影.002[Result]──▶ Mix.001[B]      │          │
│                                        │                │          │
│                                        ▼                ▼          │
│                                   Mix.001[Result] ──────────────▶ Output[Result]│
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 展开子组后的完整数据流

```
Color(基础贴图)
  │
  ▼
校色.002
  │  ├─ RGB Curves Combined: S型曲线压暗中间调
  │  ├─ RGB Curves Alpha: 类似S型
  │  └─ HSV: Value×1.85 提亮
  │
  ├──────────────────────────────────────────┐
  ▼                                          ▼
Mix[A] ◀─── 校色后颜色                    (等待 Ramp 结果)
  │
  │  SDF.002
  │    ├─ FRONT · SUN → dot product → 朝向判断
  │    ├─ RIGHT · FRONT → dot product → UV 翻转
  │    ├─ 映射到 UV → SDF.tex.002 采样 FaceMap
  │    ├─ 输出 Value(alpha) → Map Range
  │    └─ 输出 Color → 鼻尖阴影.002
  │
  ▼
Map Range(0→0.15, 1→0.99)
  │
  ▼
ramp.002 (Warm Ramp 采样)
  │
  ▼
Mix[B] → Mix[Result]
  │
  ▼
Mix.001[A]

SDF.tex Color → 鼻尖阴影.002
  │  ├─ Geometry Normal → Mapping(Y=-0.4) → Layer Weight(Facing)
  │  ├─ Facing → ColorRamp(0.204~0.271)
  │  └─ 蓝通道 → ColorRamp(0~0.046) → Invert
  │
  ▼
Mix.001[B]

Mix.001[Result] → Output
```

---

## 四、逐节点 / 子组详解

### 4.1 顶层节点

| # | 名称 | 类型 | 输入 | 输出 | 说明 |
|---|------|------|------|------|------|
| 1 | Color | 输入节点 | — | Color | 基础贴图色，连接 `Avatar_Hyacine_00_Face_Color.png` |
| 2 | 校色.002 | 子组 | Color | Color | 校色处理（详见 4.2） |
| 3 | SDF.002 | 子组 | — | Value, Color | SDF 朝向判断 + FaceMap 采样（详见 4.3） |
| 4 | Map Range | 节点 | Value (from SDF.002) | Result | 线性映射 |
| 5 | ramp.002 | 子组 | Value | Color | Ramp 明暗着色（详见 4.6） |
| 6 | Mix | Mix | A=校色结果, B=ramp结果 | Result | 校色 × Ramp |
| 7 | 鼻尖阴影.002 | 子组 | Color (from SDF.tex) | Result | 鼻尖阴影遮罩（详见 4.5） |
| 8 | Mix.001 | Mix | A=Mix结果, B=鼻尖阴影 | Result | 叠加鼻尖阴影 |
| 9 | Output | 输出 | Result | — | 最终输出 |

**Map Range 参数：**
- 输入范围：0 → 1
- 输出范围：`map_min(0.15)` → `map_max(0.99)`

---

### 4.2 校色.002（5 节点）

**功能：** 对基础贴图色做曲线校正 + HSV 提亮

| # | 节点 | 类型 | 参数 |
|---|------|------|------|
| 1 | RGB Curves (Combined) | Curves | `(0,0), (0.41,0.17), (0.67,0.31), (0.88,0.81), (1,1)` |
| 2 | RGB Curves.001 (Alpha) | Curves | `(0,0), (0.48,0.23), (0.84,0.74), (1,1)` |
| 3 | HSV | Color | Hue=0.5, Sat=1.0, **Value=1.85** |

**RGB Curves Combined 曲线分析：**
- 典型 S 型曲线，压暗中间调
- 输入 0.41 → 输出 0.17（大幅压暗）
- 输入 0.67 → 输出 0.31（继续压暗）
- 输入 0.88 → 输出 0.81（接近线性）
- 整体效果：暗部保持，中间调大幅压暗，高光微压

**HSV 分析：**
- Value = 1.85 表示亮度乘以 1.85 倍
- 与 RGB Curves 的压暗形成对比，补偿中间调亮度
- 最终效果：暗部变暗，高光提亮，增强对比度

---

### 4.3 SDF.002（18 节点）

**功能：** 使用自定义属性驱动 SDF 贴图采样，判断脸部朝向与光照方向

#### 自定义属性

| 属性节点 | 属性名 | 类型 | 作用 |
|----------|--------|------|------|
| Attribute | `SUN` | Vector | 太阳方向向量（光源方向） |
| Attribute.002 | `FRONT` | Vector | 正面朝向向量（脸正前方） |
| Attribute.003 | `RIGHT` | Vector | 右侧朝向向量（脸右侧） |

#### 内部流程

```
1. FRONT · SUN → Dot Product → 判断脸是否朝向光源
2. RIGHT · FRONT → Dot Product → 判断需要 UV 翻转
3. 根据 Dot 结果映射到 UV 坐标
4. UV 坐标 → SDF.tex.002 采样 FaceMap
5. 输出 Value (alpha 通道) → 给 Map Range
6. 输出 Color → 给鼻尖阴影.002
```

**算法逻辑：**
- `dot(normalize(FRONT), normalize(SUN))` → 正面光照因子
- `dot(normalize(RIGHT), normalize(light_dir))` → 判断左右翻转
- 翻转时 UV.x 取反（`scale_x = mix(1.0, -1.0, is_flipped)`）
- SDF alpha 通道作为阈值，与光照因子比较生成明暗遮罩

---

### 4.4 SDF.tex.002（11 节点，9 张贴图）

**功能：** 加载 FaceMap 贴图并采样

| 贴图 | 实际使用 |
|------|---------|
| `W_140_Girl_FaceMap_00.png` | ✅ Color + Alpha 通道已连接 |
| 其余 8 张 FaceMap | ❌ 已加载未连接 |

---

### 4.5 鼻尖阴影.002（10 节点）

**功能：** 基于法线偏移和 Layer Weight 生成鼻尖区域阴影遮罩

#### 内部流程

```
Geometry[Normal]
  → Mapping(Location Y = -0.4)
  → Layer Weight[Facing] (blend=0.5)
  → ColorRamp(pos 0.204 ~ 0.271)
  → Mix Factor

SDF.tex 蓝色通道
  → ColorRamp(pos 0 ~ 0.046)
  → Invert
  → Mix[A]

Mix → Output[Result]
```

**参数详解：**
- **Mapping Y = -0.4：** 将法线 Y 分量下移 0.4，使鼻尖区域的法线更"朝上"
- **Layer Weight Facing：** 基于 camera ray 和法线的夹角，边缘为 0，正面为 1
- **ColorRamp (0.204 ~ 0.271)：** 窄范围阈值，仅鼻尖极小区域为 1
- **蓝通道 ColorRamp (0 ~ 0.046)：** 从 SDF.tex 取蓝色通道做第二层遮罩
- **Invert：** 蓝色区域 → 暗区（阴影）

---

### 4.6 ramp.002

**功能：** 将 SDF 映射后的值通过 Warm Ramp 查表着色

**结构：** 与衣服 shader 的 ramp.001 类似

| 参数 | 值 |
|------|---|
| 贴图 | `Avatar_Hyacine_00_Body_Warm_Ramp.png` (256×16) |
| Map Range | 0 → `map_min(0.15)`, 1 → `map_max(0.99)` |
| 色彩空间 | sRGB |
| 平均 RGB | (0.929, 0.827, 0.857) |

---

### 4.7 虚拟日光.002（12 节点）

**功能：** SUN 属性向量 + 法线做半兰伯特光照

**结构：** 与衣服 shader 的虚拟日光.001 相同

> 注：此子组在脸 shader 中存在，但未在顶层 9 条连线中直接出现，可能作为 SDF.002 或其他子组的内部依赖。

---

## 五、颜色公式

```
最终颜色 = 校色输出 × Ramp输出 × 鼻尖阴影

校色输出 = base_color × RGB_Curves(S型曲线) × HSV(×1.85)
Ramp输出 = Warm_Ramp(SDF值采样) × Ramp_Curves(蓝压缩)
鼻尖阴影 = LayerWeight(法线偏移) → ColorRamp → 蓝通道反转
```

**展开计算：**

```
校色后 = base_color × Curve(base_color) × 1.85
Ramp后 = Warm_Ramp(MapRange(SDF_alpha))
阴影后 = nose_shadow_mask(SDF_blue, Normal_offset)

final = 校色后 × Ramp后 × 阴影后
```

---

## 六、变暗 / 变亮因素分析

### 变暗因素

| 因素 | 机制 | 影响程度 |
|------|------|---------|
| RGB Curves Combined | S 型曲线压暗中间调（0.41→0.17） | ⭐⭐⭐⭐ 强 |
| Ramp 着色 | SDF 遮罩使暗面采样 Ramp 暗区 | ⭐⭐⭐ 中 |
| 鼻尖阴影 | Layer Weight + 蓝通道遮罩 | ⭐⭐ 局部 |
| RGB Curves Alpha | Alpha 曲线同样压暗 | ⭐⭐ 中 |

### 变亮因素

| 因素 | 机制 | 影响程度 |
|------|------|---------|
| HSV Value=1.85 | 整体亮度 ×1.85 | ⭐⭐⭐⭐⭐ 很强 |
| Map Range (0.15~0.99) | 避免最暗值，底部截止在 0.15 | ⭐⭐ 中 |
| 基础贴图偏亮 | 平均 RGB (0.971, 0.867, 0.849) | ⭐⭐⭐ 中 |

### 综合判断

- RGB Curves 大幅压暗中间调，但 HSV ×1.85 强力补偿
- 净效果：暗部更暗（曲线压暗 + HSV 放大压暗效果），高光更亮（曲线高光区接近线性 × 1.85）
- **整体偏亮**，但对比度显著增强

---

## 七、调节切入点

### 7.1 整体亮度

| 调节点 | 方法 | 效果 |
|--------|------|------|
| 校色.002 → HSV → Value | 调整 1.85 值 | 直接控制整体亮度 |
| 校色.002 → RGB Curves | 修改曲线形状 | 控制中间调/高光分布 |
| Map Range → map_min | 调整 0.15 | 控制阴影区最低亮度 |

### 7.2 阴影分布

| 调节点 | 方法 | 效果 |
|--------|------|------|
| SDF.002 → SDF.tex → Alpha 阈值 | 修改 FaceMap 或阈值逻辑 | 改变脸阴影形状 |
| ramp.002 → Map Range → map_max | 调整 0.99 | 改变亮面范围 |
| ramp.002 → Warm Ramp 贴图 | 替换 Ramp 贴图 | 改变阴影颜色过渡 |

### 7.3 鼻尖阴影

| 调节点 | 方法 | 效果 |
|--------|------|------|
| 鼻尖阴影.002 → Mapping Y | 调整 -0.4 | 控制阴影位置偏移 |
| 鼻尖阴影.002 → ColorRamp (0.204~0.271) | 调整阈值范围 | 控制阴影面积 |
| 鼻尖阴影.002 → 蓝通道 ColorRamp | 调整 0~0.046 | 控制第二层阴影强度 |

### 7.4 颜色风格

| 调节点 | 方法 | 效果 |
|--------|------|------|
| 校色.002 → RGB Curves | 修改控制点 | 改变色调曲线风格 |
| 校色.002 → HSV → Hue | 调整 0.5 | 色相偏移 |
| 校色.002 → HSV → Sat | 调整 1.0 | 饱和度调整 |
| ramp.002 → Warm Ramp | 替换贴图 | 改变暖色风格 |

---

## 附录：WGSL 参考代码

```wgsl
fn face_fragment(in: VertexOutput) -> @location(0) vec4f {
    let corrected = color_correction(face_uniforms.base_color);
    let sdf_value = sdf_check(in.uv, face_uniforms.face_front, face_uniforms.face_right, in.light_dir, sdf_tex, face_tex_sampler);
    let mapped = map_range(sdf_value, 0.0, 1.0, face_uniforms.map_min, face_uniforms.map_max);
    let ramp_result = ramp_shade(mapped, 0.0, face_ramp_tex, face_tex_sampler);
    let sdf_color = textureSample(sdf_tex, face_tex_sampler, in.uv);
    let nose_shadow = nose_tip_shadow(sdf_color, in.normal, in.view_dir);
    let base = corrected * ramp_result;
    let with_shadow = base * nose_shadow;
    return with_shadow;
}

fn sdf_check(uv, face_front, face_right, light_dir, sdf_tex, sampler) -> f32 {
    let dot_right = dot(normalize(face_right), normalize(light_dir));
    let is_flipped = select(0.0, 1.0, dot_right > 0.0);
    let scale_x = mix(1.0, -1.0, is_flipped);
    let scaled_uv = vec2f(uv.x * scale_x, uv.y);
    let sdf_color = textureSample(sdf_tex, sampler, scaled_uv);
    let sdf_alpha = sdf_color.a;
    let dot_front = dot(normalize(face_front), normalize(light_dir));
    let threshold = dot_front * 0.5 + 0.5;
    return select(0.0, 1.0, threshold > sdf_alpha);
}

fn nose_tip_shadow(color, normal, view_dir) -> vec4f {
    let mapped_normal = normalize(vec3f(normal.x, normal.y - 0.4, normal.z));
    let facing = layer_weight_facing(0.5, mapped_normal, view_dir);
    let shadow_factor = smoothstep_custom(0.2042, 0.2708, facing);
    let blue = color.b;
    let shadow2_factor = 1.0 - smoothstep_custom(0.0, 0.0458, blue);
    return mix(vec4f(shadow2_factor), vec4f(1.0), shadow_factor);
}
```
