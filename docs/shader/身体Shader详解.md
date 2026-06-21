# 身体 Shader 详解

## 使用部位
- slot12(Arm)
- slot13(Body)
- slot16(指甲)

使用 shader：`StarRailShader.身体变体_v17`

---

## 与脸 shader 的唯一差异

```
脸 shader:   SDF.002[Value]        --> Map Range[Value]  （用 SDF 驱动明暗）
身体变体v17: 虚拟日光[半兰伯特光照模型] --> Map Range[Value]  （用虚拟日光驱动明暗）
```

这是**唯一的连线差异**。其他所有连线完全相同。

---

## 材质层级

```
StarRailShader.身体变体_v17
├── 虚拟日光 (半兰伯特光照模型) ── 已连接，替代 SDF
├── SDF ── 未连接（被虚拟日光替代）
├── SDF.tex ── 结构同脸 shader
├── 校色 ── 结构同脸 shader
├── ramp ── 结构同脸 shader
├── ramp.clothes ── 结构同脸 shader
├── ramp.hair ── 结构同脸 shader
├── matcap ── 未连接
├── matcap.hair ── 未连接
├── ilm.clothes ── 结构同脸 shader
├── ilm.hair ── 结构同脸 shader
├── smoothstep ── 结构同脸 shader
├── 布林冯光照模型 ── 未连接
└── 鼻尖阴影 ── 结构同脸 shader
```

### 子组对比
所有子组（SDF/SDF.tex/虚拟日光/校色/ramp/ramp.clothes/ramp.hair/matcap/matcap.hair/ilm.clothes/ilm.hair/smoothstep/布林冯光照模型/鼻尖阴影）结构与脸 shader **完全相同**，只是后缀不同。

---

## 贴图清单

| 贴图 | 尺寸 | 色彩空间 | 用途 |
|------|------|---------|------|
| Body3.png | 8192×8192 | sRGB | 身体基础颜色贴图 |

---

## 信号流图

```
[Body3.png] ─────────────────────────────────────────────┐
                                                          │ base_color
[虚拟日光] ── 半兰伯特光照 ──> [Map Range] ──> Value ──> [ramp] ──> ramp_result
  │                            │                           │
  │ default_image              │ map_min=0.15             │
  │ [0.8,0.8,0.8,1.0]         │ map_max=0.99             │
  └────────────────────────────┘                           │
                                                          │
[SDF贴图] ──> [鼻尖阴影] ──> nose_shadow                   │
                                                          │
[校色] ──> corrected                                      │
                                                          │
                                    ┌─────────────────────┘
                                    ▼
                          base = corrected × ramp_result
                                    │
                                    ▼
                          with_shadow = base × nose_shadow
                                    │
                                    ▼
                              Material Output
```

---

## 节点详解

### 1. 虚拟日光（半兰伯特光照模型）

- **输入**：SUN 属性（光源方向） + 法线（几何法线）
- **算法**：半兰伯特 = dot(normal, light_dir) × 0.5 + 0.5
- **默认 Image 输入**：`[0.8, 0.8, 0.8, 1.0]`（无 ILM 贴图）
- **输出**：标量亮度值 [0, 1]

半兰伯特公式：
```
half_lambert = dot(N, L) × 0.5 + 0.5
```
将传统的 [-1, 1] 兰伯特范围映射到 [0, 1]，背面也有柔和过渡而非纯黑。

### 2. Map Range

- **输入范围**：0 → 1
- **输出范围**：map_min(0.15) → map_max(0.99)
- **作用**：将半兰伯特结果限制在 [0.15, 0.99]，避免纯黑和过曝
- **公式**：`mapped = (half_lambert - 0) / (1 - 0) × (0.99 - 0.15) + 0.15`

### 3. ramp（渐变着色）

- **输入**：mapped value + ramp 纹理
- **作用**：将连续亮度值离散化为卡通色阶
- **输出**：ramp_result（RGB 颜色）

### 4. 校色

- **输入**：base_color（来自 Body3.png）
- **作用**：蓝色压缩 + HSV 调整
- **输出**：corrected（校正后的颜色）

### 5. 鼻尖阴影

- **输入**：SDF 贴图颜色 + 法线 + 视线方向
- **作用**：基于 SDF 的鼻尖区域额外阴影
- **输出**：nose_shadow（乘法因子）

---

## 颜色公式

### 最终颜色合成

```
corrected   = color_correction(base_color)
half_lambert = dot(N, L) × 0.5 + 0.5
mapped      = map_range(half_lambert, 0.0, 1.0, 0.15, 0.99)
ramp_result = ramp_shade(mapped, ramp_tex, sampler)
nose_shadow = nose_tip_shadow(sdf_color, normal, view_dir)

final = corrected × ramp_result × nose_shadow
```

### WGSL 代码

```wgsl
fn body_fragment(in: VertexOutput) -> @location(0) vec4f {
    let corrected = color_correction(body_uniforms.base_color);
    let default_image = vec4f(0.8, 0.8, 0.8, 1.0);
    let half_lambert = virtual_sunlight(default_image, in.light_dir, in.normal);
    let mapped = map_range(half_lambert, 0.0, 1.0, body_uniforms.map_min, body_uniforms.map_max);
    let ramp_result = ramp_shade(mapped, 0.0, face_ramp_tex, face_tex_sampler);
    let sdf_color = textureSample(sdf_tex, face_tex_sampler, in.uv);
    let nose_shadow = nose_tip_shadow(sdf_color, in.normal, in.view_dir);
    let base = corrected * ramp_result;
    let with_shadow = base * nose_shadow;
    return with_shadow;
}
```

---

## 因素分析

| 因素 | 影响方向 | 说明 |
|------|---------|------|
| 虚拟日光方向 | 整体明暗分布 | 改变光源角度会改变身体明暗分布 |
| map_min (0.15) | 最暗区域亮度 | 值越大，阴影区域越亮（整体提亮） |
| map_max (0.99) | 最亮区域亮度 | 值越小，高光区域越暗（压暗高光） |
| ramp 纹理 | 色阶过渡 | 控制卡通渲染的色阶数和过渡方式 |
| 校色参数 | 色调偏移 | 蓝色压缩 + HSV 调整影响整体色调 |
| Body3.png | 基础颜色 | 贴图本身的颜色是最终颜色的基底 |
| 鼻尖阴影 | 局部暗化 | 仅影响鼻尖附近区域 |

---

## 调节切入点

### 1. 整体亮度
- **map_min**：增大 → 整体提亮；减小 → 阴影更深
- **map_max**：减小 → 压暗高光；增大 → 高光更亮

### 2. 明暗过渡柔和度
- **虚拟日光**的半兰伯特本身已有柔和过渡
- 可通过调整 ramp 纹理控制色阶的硬/软过渡

### 3. 颜色色调
- **校色子组**：调整蓝色压缩和 HSV 参数改变整体色调
- **Body3.png**：更换贴图会改变基础颜色

### 4. 光照方向
- **SUN 属性**：旋转光源方向改变身体明暗面的分布

### 5. 对比度
- **map_min 和 map_max 的间距**：间距越大，对比度越高；间距越小，画面越平

### 6. 卡通感强度
- **ramp 纹理**：使用更多硬边色阶 → 更强的卡通感；使用柔和渐变 → 更写实
