# 丝袜 Shader 详解 (WGSL版)

> **注意：** 这是 WGSL 版本的丝袜材质文档，不是 Blender 中 v40 裤袜（68节点）的文档。v40 裤袜已有 [STOCKING.md](../STOCKING.md)。

## 一、使用部位

WGSL 丝袜着色器，包含 ThighhighsInfoGen.023 区域计算和 SockV3.027 纤维覆盖率系统。

## 二、贴图清单

| 贴图 | 用途 |
|------|------|
| base_color (uniform) | 基础颜色（vec4f，非贴图） |
| thickness_selector_tex | 厚度选择贴图（控制不同区域厚度） |

## 三、信号流图

### 3.1 完整流程

```
UV 坐标
  │
  ├── uv.y ──→ ThighhighsInfoGen ──→ mask / cuff_mask / body_mask / cuff_uv_y / body_uv_y
  │                                        │
  │                                        ├── cuff_color (紫 0.31/0.27/0.60)
  │                                        ├── body_thickness = ColorRamp(body_uv_y)
  │                                        │
  │                                        └── region_color = mix(cuff_color, body_thickness, body_mask)
  │
  ├── base_color (uniform) ──→ mix(base, region_color, 1.0) = mix_color
  │
  ├── thickness_selector_tex ──→ FloatCurve_thickness ──→ selector_thickness
  │                                                      │
  │                 custom_thickness (uniform) ──────────→ mix(selector, custom, step(0.5, custom))
  │                                                            │
  │                                         thickness_adjust ──→ + adjust
  │                                                                │
  ├── thickness_adjusted ──→ FloatCurve_fiber_width ──→ fiber_width
  │                     └──→ FloatCurve_fiber_thickness ──→ fiber_thick
  │                                                            │
  ├── uv, uv_scale, fiber_width, fiber_thick ──→ fiber_coverage ──→ coverage
  │                                                                  │
  │                                        coverage > 0.1 ──→ coverage_masked
  │                                                                  │
  │                                        coverage_masked × mask ──→ alpha_raw
  │                                                                  │
  │                                        min(alpha_raw + thickness×0.3, 1.0) ──→ alpha
  │
  ├── mix_color ──→ RGB_to_BW ──→ ColorRamp_stocking ──→ ramp_val
  │                                                        │
  │                mix(mix_color, ramp_val, 0.3) ──→ final_color
  │
  └── transmission_weight ──→ mix(final_color, 黑色, transmission×0.5) ──→ result_color
                                                                          │
                                                              vec4f(result_color, alpha) ──→ 输出
```

### 3.2 信号流简化

```
1. 区域计算 → mask / cuff_mask / body_mask
2. Cuff颜色(紫) + Body颜色(灰度厚度映射) → Mix → region_color
3. 基础颜色混合: mix(base, region_color, 1.0) = mix_color
4. 厚度计算: thickness_selector贴图 → FloatCurve → + adjust
5. 纤维覆盖率: fiber_width / fiber_thickness 从厚度曲线查表 → SDF 条纹
6. Alpha: coverage × mask + thickness×0.3
7. 亮度映射: BW → ColorRamp → Mix(0.3)
8. BSDF 输出: transmission 控制透明度
```

## 四、节点详解

### 4.1 区域计算 — ThighhighsInfoGen

```
输入:
  leg_height = uv.y         // 腿部高度（UV纵坐标）
  sock_length               // 袜子总长度
  cuff_length               // 袜口长度

输出:
  mask        // 是否在袜内 (0 或 1)
  cuff_mask   // 是否在袜口 (0 或 1)
  body_mask   // 是否在袜身 (0 或 1)
  cuff_uv_y   // 袜口区域归一化 UV (0~1)
  body_uv_y   // 袜身区域归一化 UV (0~1)
```

**计算逻辑：**
```
mask = leg_height < sock_length ? 1 : 0

cuff_start = sock_length - cuff_length
is_in_cuff = leg_height >= cuff_start ? 1 : 0

cuff_mask = is_in_cuff × mask
body_mask = cuff_mask × mask

cuff_uv_y = clamp((leg_height - cuff_start) / cuff_length, 0, 1)
body_uv_y = clamp(leg_height / sock_length, 0, 1)
```

### 4.2 纤维覆盖率 — fiber_coverage

```
输入:
  uv              // UV 坐标
  uv_scale        // 纤维 UV 缩放
  fiber_width     // 纤维宽度（从厚度曲线查表）
  fiber_thickness // 纤维厚度（从厚度曲线查表）

输出:
  coverage        // 0~1 覆盖率
```

**计算逻辑：**
```
scaled_uv = uv × (uv_scale, uv_scale × 0.5)
cell_x = fract(scaled_uv.x)
dist = abs(cell_x - 0.5)
inner = fiber_width × 0.5 - fiber_thickness × 0.01
outer = fiber_width × 0.5
coverage = 1 - smoothstep(inner, outer, dist)
```

### 4.3 Float Curves 参数

| 曲线名 | 控制点 | 用途 |
|--------|--------|------|
| thickness | (0, 0.0625), (0.5007, 1.0186), (0.5315, 1.8509), (1, 1.8125) | 厚度选择器贴图 → 实际厚度 |
| fiber_width | (0, 0.03), (0.5745, 0.19), (0.8582, 0.333), (1, 1) | 厚度 → 纤维宽度 |
| fiber_thickness | (0, 0.025), (0.6364, 0.28), (1, 1) | 厚度 → 纤维厚度 |
| fur_amount | (0, 0.01), (0.4973, 0.226), (1, 1) | 厚度 → 绒毛量 |
| is_fiber | (0.0045, 0.994), (0.35, 0.369), (1, 0) | 反向：控制是否显示纤维纹理 |

### 4.4 Uniform 参数

| 参数 | 类型 | 说明 |
|------|------|------|
| base_color | vec4f | 基础颜色 |
| roughness | f32 | 粗糙度 |
| transmission_weight | f32 | 透明度权重 |
| uv_ratio | f32 | UV 比例 |
| uv_scale | f32 | 纤维 UV 缩放 |
| subsurface_weight | f32 | 次表面散射 |
| thickness_adjust | f32 | 厚度调整（叠加到厚度曲线上） |
| tension_intensity | f32 | 张力强度 |
| anisotropic_rotation | f32 | 各向异性旋转 |
| custom_thickness | f32 | 自定义厚度（>0.5 时覆盖贴图厚度） |
| sock_length | f32 | 袜子长度 |
| cuff_length | f32 | 袜口长度 |

## 五、颜色公式

### 5.1 区域颜色

```
cuff_color = vec3f(0.3095, 0.2747, 0.6038)    // 紫色袜口
body_thickness = ColorRamp_stocking(body_uv_y)  // 灰度→厚度映射
region_color = mix(cuff_color, vec3f(body_thickness), body_mask)
```

### 5.2 基础混合

```
mix_color = mix(base_color.rgb, region_color, 1.0) = region_color
```
（注意：mix factor = 1.0，即完全用 region_color 覆盖 base_color）

### 5.3 厚度

```
selector_thickness = FloatCurve_thickness(thickness_selector_tex.r)
thickness = mix(selector_thickness, custom_thickness, step(0.5, custom_thickness))
thickness_adjusted = thickness + thickness_adjust
```
当 custom_thickness > 0.5 时，使用自定义厚度代替贴图厚度。

### 5.4 纤维覆盖率

```
fiber_width = FloatCurve_fiber_width(thickness_adjusted)
fiber_thick = FloatCurve_fiber_thickness(thickness_adjusted)
coverage = fiber_coverage(uv, uv_scale, fiber_width, fiber_thick)
coverage_masked = coverage > 0.1 ? coverage : 0.0
```

### 5.5 Alpha

```
alpha_raw = coverage_masked × mask
alpha = min(alpha_raw + thickness_adjusted × 0.3, 1.0)
```
厚度越大，alpha 越高（越不透明）；纤维覆盖率越高，alpha 越高。

### 5.6 最终颜色

```
bw = rgb_to_bw(mix_color)
ramp_val = ColorRamp_stocking(bw)
final_color = mix(mix_color, vec3f(ramp_val), 0.3)     // 30% 灰度混合
result_color = mix(final_color, vec3f(0.0), transmission_weight × 0.5)  // 透明度偏暗
```

## 六、因素分析

| 因素 | 影响 | 范围 |
|------|------|------|
| sock_length | 袜子长度（控制覆盖区域） | 0~1 (UV.y) |
| cuff_length | 袜口长度（紫色装饰区） | 0~sock_length |
| thickness_selector_tex | 不同区域的基础厚度 | 贴图 R 通道 |
| thickness_adjust | 整体厚度偏移 | -∞~+∞ |
| custom_thickness | 覆盖贴图的统一厚度 | >0.5 时生效 |
| uv_scale | 纤维纹理密度 | 越大越密 |
| transmission_weight | 透明程度 | 0~1 |
| cuff_color | 袜口颜色 | 当前紫色 (0.31/0.27/0.60) |
| ColorRamp_stocking | 厚度→颜色映射 | 曲线控制 |
| 纤维曲线 | 厚度→纤维宽度/粗细 | 4条 FloatCurve |
| roughness | 表面粗糙度 | 0~1 |
| subsurface_weight | 次表面散射（皮肤透光感） | 0~1 |

## 七、调节切入点

| 目标 | 调节方式 | 参数/节点 |
|------|----------|-----------|
| 袜子长度 | 改 sock_length | uniform (UV.y 阈值) |
| 袜口宽度 | 改 cuff_length | uniform |
| 袜口颜色 | 改 cuff_color | 代码内硬编码 (当前 0.31/0.27/0.60) |
| 整体厚度 | 改 thickness_adjust | uniform (正值增厚，负值减薄) |
| 统一厚度（忽略贴图） | 改 custom_thickness > 0.5 | uniform |
| 纤维纹理密度 | 改 uv_scale | uniform (越大越密) |
| 纤维可见度 | 改 is_fiber 曲线 | FloatCurve |
| 透明程度 | 改 transmission_weight | uniform (越大越透) |
| 厚度分布 | 改 thickness 曲线或贴图 | FloatCurve_thickness / thickness_selector_tex |
| 纤维粗细 | 改 fiber_thickness 曲线 | FloatCurve_fiber_thickness |
| 纤维间距 | 改 fiber_width 曲线 | FloatCurve_fiber_width |
| 灰度混合比例 | 改 mix factor (当前 0.3) | 代码内常量 |
| 表面质感 | 改 roughness | uniform |
| 皮肤透光 | 改 subsurface_weight | uniform |

## 八、WGSL 代码（完整）

```wgsl
fn thighhighs_info(leg_height: f32, sock_length: f32, cuff_length: f32) -> ThighhighsInfo {
    var info: ThighhighsInfo;
    info.mask = select(0.0, 1.0, leg_height < sock_length);

    let cuff_start = sock_length - cuff_length;
    let is_in_cuff = select(0.0, 1.0, leg_height >= cuff_start);

    info.cuff_mask = is_in_cuff * info.mask;
    info.body_mask = info.cuff_mask * info.mask;

    info.cuff_uv_y = clamp((leg_height - cuff_start) / cuff_length, 0.0, 1.0);
    info.body_uv_y = clamp(leg_height / sock_length, 0.0, 1.0);

    return info;
}

fn fiber_coverage(uv: vec2f, uv_scale: f32, fiber_width: f32, fiber_thickness: f32) -> f32 {
    let scaled_uv = uv * vec2f(uv_scale, uv_scale * 0.5);
    let cell_x = fract(scaled_uv.x);
    let dist = abs(cell_x - 0.5);
    let inner = fiber_width * 0.5 - fiber_thickness * 0.01;
    let outer = fiber_width * 0.5;
    return 1.0 - smoothstep(inner, outer, dist);
}

fn stocking_fragment(in: FragmentInput) -> @location(0) vec4f {
    // 1. 区域计算
    let info = thighhighs_info(in.uv.y, stocking_uniforms.sock_length, stocking_uniforms.cuff_length);

    // 2. 区域颜色
    let cuff_color = vec3f(0.3095, 0.2747, 0.6038);
    let body_thickness = color_ramp_stocking(info.body_uv_y);
    let region_color = mix(cuff_color, vec3f(body_thickness), info.body_mask);

    // 3. 基础颜色混合
    let mix_color = mix(base.rgb, region_color, 1.0);

    // 4. 厚度计算
    let thickness_map = textureSample(thickness_selector_tex, sock_sampler, in.uv);
    let selector_thickness = float_curve_thickness(thickness_map.r);
    let thickness = mix(selector_thickness, stocking_uniforms.custom_thickness,
                        step(0.5, stocking_uniforms.custom_thickness));
    let thickness_adjusted = thickness + stocking_uniforms.thickness_adjust;

    // 5. 纤维覆盖率
    let fiber_width = float_curve_fiber_width(thickness_adjusted);
    let fiber_thick = float_curve_fiber_thickness(thickness_adjusted);
    let coverage = fiber_coverage(in.uv, stocking_uniforms.uv_scale, fiber_width, fiber_thick);
    let coverage_masked = select(0.0, coverage, coverage > 0.1);

    // 6. Alpha
    let alpha_raw = coverage_masked * info.mask;
    let alpha = min(alpha_raw + thickness_adjusted * 0.3, 1.0);

    // 7. 亮度映射
    let bw = rgb_to_bw(vec4f(mix_color, 1.0));
    let ramp_val = color_ramp_stocking(bw);
    let final_color = mix(mix_color, vec3f(ramp_val), 0.3);

    // 8. BSDF 输出
    let transmission = stocking_uniforms.transmission_weight;
    let result_color = mix(final_color, vec3f(0.0), transmission * 0.5);

    return vec4f(result_color, alpha);
}
```
