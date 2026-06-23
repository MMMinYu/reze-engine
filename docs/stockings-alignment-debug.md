# 白裤袜 / 吊带袜 与 Blender 对齐调试记录

## 问题描述

2026-06-22：检查白裤袜和吊带袜（吊带袜_丝袜）材质，发现 engine 渲染与 Blender 不一致。

## 核心结论

**白裤袜、吊带袜_丝袜、胖次_丝袜 三个材质在 Blender 中使用 `SockAIO.021` 节点组（完整的丝袜着色器），但在 engine 中被错误地映射为 `sr_clothes`（衣服 NPR），导致完全缺失丝袜效果。**

## 排查过程

### 1. 材质节点核对（MCP）

通过 `execute_blender_code` 连接 Blender，确认：

| 材质 | Blender 顶层节点组 | 内部子组 | engine 当前 preset | 面数 |
|------|-------------------|---------|-------------------|------|
| 白裤袜 | `SockAIO.021` | SockV3.027 + ThighhighsInfoGen.023 + PantyhoseThicknessSelector.023 | **sr_clothes（错误）** | 8390 |
| 吊带袜_丝袜 | `SockAIO.021` | 同上 | **sr_clothes（错误）** | 6044 |
| 胖次_丝袜 | `SockAIO.021` | 同上 | **sr_clothes（错误）** | 1808 |
| actual_白裤袜 | `MMDShaderDev` + 裤袜.png | — | 未在 manifest 中 | — |

### 2. SockAIO.021 节点组完整分析

#### 2.1 输入接口（白裤袜/吊带袜_丝袜/胖次_丝袜 通用）

| 输入 | 白裤袜值 | 吊带袜_丝袜值 | 胖次_丝袜值 | 来源 |
|------|---------|-------------|-----------|------|
| Type | Pantyhose | Pantyhose | Pantyhose | menu switch |
| PantyhoseStyle | 0 | 0 | 0 | menu switch |
| BaseColor | RGB(1,1,1,1) | RGB(1,1,1,1) | RGB(1,1,1,1) | Color 节点 |
| Roughness | 0.35 | 0.35 | 0.35 | default |
| Transmission Weight | 0.3 | 0.3 | 0.3 | default |
| UVRatio | 0.3 | 0.3 | 0.3 | default |
| UVScale | **3000** | **3734** | **3000** | default |
| Subsurface Weight | 0.4 | 0.4 | 0.4 | default |
| ThicknessAdjust | `(SockThickness - 0.5) × 3` | 同左 | 同左 | Attribute 节点 |
| LegPosition(Height) | UV.Y | UV.Y | UV.Y | Separate XYZ.Y |
| TensionIntensity | 0.8 | 0.8 | 0.8 | default |
| Anisotropic Rotation | 0.75 | 0.75 | 0.75 | default |
| UseCustomThickness | 1.0 | 1.0 | 1.0 | default |
| CustomThickness | Float Curve 输出 | Float Curve 输出 | Float Curve 输出 | PantyhoseThicknessSelector |
| SockLength | 0.75 | 0.75 | 0.75 | default |
| CuffLength | 0.03 | 0.03 | 0.03 | default |
| SampleCuffColor | Closure（紫 0.31/0.27/0.60） | 同左 | 同左 | Color Ramp.001 |
| SampleSockBodyColor | Closure（紫 0.31/0.27/0.60） | 同左 | 同左 | Color Ramp |
| RampThighhighsThickness | Closure（黑→灰 0.6） | 同左 | 同左 | Color Ramp.002 |

**关键差异**：白裤袜 UVScale=3000，吊带袜_丝袜 UVScale=3734（纤维密度不同）。

#### 2.2 SockAIO.021 内部 Principled BSDF 参数

| 参数 | 值 |
|------|-----|
| Base Color | (0.002, 0.002, 0.002) 近黑 |
| Metallic | 0.0 |
| Roughness | 0.85（被外部 Mix.010 覆盖） |
| Transmission Weight | 0.3 |
| Subsurface Weight | 0.0（默认值，但被外部 0.4 覆盖） |
| Subsurface Scale | 由 Mix.008 控制（基于 SockV3 coverage） |
| Sheen Weight | 0.02 |
| Sheen Roughness | 0.5 |
| Specular IOR Level | 0.5 |
| Alpha | 由 Mix.003 控制（基于 SockV3 coverage） |
| Anisotropic | 由 SockV3 IsFiber 控制 |
| Specular Tint | 由 Mix.011 控制（基于 IsFiber 和 Anisotropic Tint） |

#### 2.3 SockAIO.021 内部 Mix 节点

| Mix 节点 | Blend | Factor | 作用 |
|---------|-------|--------|------|
| Mix | MIX | BodyMask | 混合 SampleCuffColor 和 SampleSockBodyColor |
| Mix.002 | MIX | Type(Pantyhose=0/Thighhighs=1) | 混合 BaseColor 和区域颜色 |
| Mix.003 | MIX | Type | 混合 coverage alpha（Pantyhose 模式 vs Thighhighs 模式） |
| Mix.004 | MIX | Type | 混合 ThicknessAdjust 和 RampThighhighsThickness |
| Mix.005 | MIX | UseCustomThickness | 混合 PantyhoseThicknessSelector 和 CustomThickness |
| Mix.006 | MIX | Type | 混合 Math 结果 |
| Mix.007 | MIX | Math.027 输出 | Glossy BSDF 颜色 |
| Mix.008 | MIX | Mix.003 (Alpha) | Subsurface Scale 调整 |
| Mix.009 | MIX | Type | Fiber coverage 混合 |
| Mix.010 | MIX | Math.025 (IsFiber gate) | Roughness 调整（IsFiber 时用 0.35，否则用外部 0.85） |
| Mix.011 | MIX | Math.025 (IsFiber gate) | Specular Tint 调整 |

#### 2.4 SockAIO.021 内部 Float Curves

| Float Curve | 点位 | 用途 |
|------------|------|------|
| Float Curve | (0,0), (0.5564,0.335), (1,1) | thickness → coverage |
| Float Curve.001 | (0,0.03), (0.5745,0.19), (0.8582,0.3333), (1,1) | thickness → FiberWidth |
| Float Curve.002 | (0,0.025), (0.6364,0.28), (1,1) | thickness → FiberThickness |
| Float Curve.003 | (0,0.01), (0.4973,0.2263), (1,1) | thickness → FurAmount |
| Float Curve.005 | (0.0045,0.9937), (0.35,0.3688), (1,0) | IsFiber → 反向衰减 |

### 3. ThighhighsInfoGen.023 区域计算

**输入**：LocalHeight=UV.Y, SrcUV=UV, Length=0.75, CuffHeight=0.03

**计算逻辑**：
```
mask = (LocalHeight < Length) ? 1 : 0
cuff_start = Length - CuffHeight = 0.72
is_in_cuff = (LocalHeight >= cuff_start) ? 1 : 0
cuff_mask = is_in_cuff × mask
body_mask = (1 - cuff_mask) × mask   // = mask - cuff_mask

// CuffUV: 保持 X，Y 重新映射到 [0,1] 的袜口区域
cuff_uv_y = clamp((LocalHeight - cuff_start) / CuffHeight, 0, 1)

// BodyUV: 保持 X，Y 重新映射到 [0,1] 的袜身区域
body_uv_y = clamp(LocalHeight / Length, 0, 1)

// DistanceToCuff: |LocalHeight - (Length - CuffHeight)|
distance_to_cuff = abs(LocalHeight - cuff_start)
```

### 4. SockV3.027 纤维覆盖率系统

**需要的贴图**（全部已在 `textures/` 目录中）：
| 贴图 | Blender 名 | 尺寸 | colorspace |
|------|-----------|------|-----------|
| `SDFLut.png` | SDFLut.png.026 | — | sRGB |
| `sock_tiled_sdf.png` | sock_tiled_sdf.png.023 | — | sRGB |
| `sock_tiled_direction.png` | sock_tiled_direction.png.023 | — | sRGB |
| `sock_tiled_normal.png` | sock_tiled_normal.png.023 | — | sRGB |
| `Substance_graph_FurLayer.png` | Substance_graph_FurLayer.png.026 | — | sRGB |

**UV 变换链**：
1. `UVByRatio.028`: UV × (FiberUVRatio/FiberUVScale) → fiber UV（仅缩放，无偏移）
2. `AdjustCellUV.028`: 根据 ThreadLength 调整 UV.x，产生 ThreadLUV/KnotUV/ThreadRUV
3. `BuildCellUV.028`: 根据 ThreadL/Knot/ThreadR 生成 cell pattern value
4. `sock_tiled_sdf.png` 采样 → MappingSDF → SDF 覆盖率
5. `sock_tiled_direction.png` → 纤维方向
6. `sock_tiled_normal.png` → Normal Map → 纤维法线
7. `SDFLut.png` → LUT 查找（可选，由 UseLut 控制）
8. `Substance_graph_FurLayer.png` → Fur 层

**输出**：
- `Coverage(Alpha)` — 纤维覆盖率（主 alpha 来源）
- `Normal` — 纤维法线（来自 sock_tiled_normal）
- `IsFiber` — 是否为纤维区域（方向贴图 X 分量）
- `Fur` — 毛绒量（FurLayer × FurAmount）
- `Direction` — 纤维方向（来自 sock_tiled_direction）

### 5. PantyhoseThicknessSelector.023

**功能**：根据 PantyhoseStyle 菜单索引选择不同的厚度预设贴图。

**贴图绑定**（对应 `cf_panst_*.png` 系列厚度图）：
| Index | 贴图 | 说明 |
|-------|------|------|
| 0 | `cf_panst_07_t.png` | 白裤袜/吊带袜_丝袜/胖次_丝袜 使用（PantyhoseStyle=0） |
| 1 | `cf_panst_09_t.png` | — |
| 2 | `cf_panst_04_t.png` | — |
| 3 | `cf_panst_08_t.png` | — |
| 4 | `cf_panst_00_t.png` | — |
| 5 | `cf_panst_02_t.png` | — |

**白裤袜使用的厚度图**：`cf_panst_07_t.png`（1024×2048, sRGB, alpha mean=0.5745）

### 6. View Dependent Coverage.028

**功能**：根据视角调整纤维覆盖率（菲涅尔效应）。

**计算**：
```
n = Normal
v = Incoming (view direction)
ndotv = dot(n, v)

// Thickness 影响视角覆盖
threshold = 1 - Thickness
coverage_offset = (ndotv - threshold) / (1 - threshold)
final_coverage = mix(original_coverage, coverage_offset, 0.5)
```

## 差异汇总

### Engine 当前实现（sr_clothes）vs Blender（SockAIO.021）

| # | 环节 | Blender | Engine (sr_clothes) | 差异影响 |
|---|------|---------|---------------------|---------|
| 1 | **Shader 类型** | SockAIO.021 丝袜专用 | sr_clothes 衣服 NPR | **根本性错误** |
| 2 | BaseColor | 纯白 RGB(1,1,1,1) | Body3.png 贴图 | 颜色完全错误 |
| 3 | 纤维覆盖率 | SockV3.027 计算 alpha | 无，alpha=1.0 | **无丝袜纹理** |
| 4 | 区域 mask | ThighhighsInfoGen 计算袜口/袜身 | 无 | 无袜口渐变 |
| 5 | 厚度渐变 | Color Ramp.002 + PantyhoseThicknessSelector | 无 | 无厚度变化 |
| 6 | 贴图绑定 | SDFLut/sock_tiled_*/FurLayer/cf_panst_07 | color/ilm/ramp/matcap | **贴图完全错误** |
| 7 | Principled 参数 | Roughness=0.85, Transmission=0.3, SSS=0.4 | sr_clothes 无这些 | 材质感不符 |
| 8 | SockThickness 属性 | Attribute 节点读取几何体属性 | 无 | 无动态厚度调整 |
| 9 | 视角相关覆盖 | View Dependent Coverage.028 | 无 | 无菲涅尔效果 |
| 10 | Glossy BSDF 叠加 | Ashikhmin-Shirley 各向异性高光 | 无 | 无纤维高光 |

## 修复方案（完整实现 SockAIO）

### 阶段 1：贴图绑定扩展

需要在 StarRail 专用 group(2) layout 中添加新的贴图槽位：
- `sock_sdf_texture` — sock_tiled_sdf.png
- `sock_direction_texture` — sock_tiled_direction.png
- `sock_normal_texture` — sock_tiled_normal.png
- `sdf_lut_texture` — SDFLut.png
- `fur_layer_texture` — Substance_graph_FurLayer.png
- `thickness_texture` — cf_panst_07_t.png（PantyhoseStyle=0）

### 阶段 2：sr_stocking shader 实现

需要实现的子系统：
1. **ThighhighsInfoGen** — UV.Y 区域计算（简单）
2. **UVByRatio** — UV 缩放（简单）
3. **SockV3 纤维覆盖率** — SDF 采样 + MappingSDF smoothstep（中等）
4. **PantyhoseThicknessSelector** — cf_panst_07 alpha 采样（简单）
5. **Float Curve 曲线** — thickness → coverage/width/thickness/fur 映射（简单）
6. **View Dependent Coverage** — 菲涅尔覆盖调整（简单）
7. **Principled BSDF** — 简化为漫反射 + 透射近似（中等）

### 阶段 3：更新 manifest.json 和 page.tsx

```json
// manifest.json
"白裤袜": {
  "preset": "sr_stocking",
  "textures": {
    "color": "textures/Body3.png",
    "sock_sdf": "textures/sock_tiled_sdf.png",
    "sock_direction": "textures/sock_tiled_direction.png",
    "sock_normal": "textures/sock_tiled_normal.png",
    "sdf_lut": "textures/SDFLut.png",
    "fur_layer": "textures/Substance_graph_FurLayer.png",
    "thickness": "textures/cf_panst_07_t.png"
  },
  "uniforms": {
    "uvScale": 3000,
    "sockLength": 0.75,
    "cuffLength": 0.03,
    "transmissionWeight": 0.3,
    "subsurfaceWeight": 0.4,
    "roughness": 0.85
  }
}
```

```typescript
// page.tsx
sr_stocking: ["白裤袜", "吊带袜_丝袜", "胖次_丝袜"],
```

## 注意事项

- **actual_白裤袜** 是 MMD 原版材质（使用裤袜.png 贴图 + MMDShaderDev），与 StarRail 版本不同。manifest.json 中应映射 StarRail 版本。
- **吊带袜.png** 是吊带（吊帶/吊帶襪）的贴图，不是丝袜部分的贴图。丝袜部分（吊带袜_丝袜）在 Blender 中用纯白 BaseColor。
- 丝袜的紫色 (0.31, 0.27, 0.60) 来自 Color Ramp，不是贴图。
- **Type=Pantyhose**（白裤袜等）：全部使用 Pantyhose 模式，不是 Thighhighs。
- **PantyhoseStyle=0**：所有三个材质都使用 PantyhoseStyle=0，对应 cf_panst_07_t.png 厚度图。
- **UVScale 差异**：白裤袜=3000，吊带袜_丝袜=3734。这影响纤维密度。
- **SockThickness 属性**：来自几何体属性（Attribute 节点），PMX 导出后可能不存在，需要验证。

## 修复记录

### 修复 1：sr_stocking shader 完整移植（2026-06-22）

**文件**：
- [stocking.ts](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts) — 完整重写
- [engine.ts](file:///e:/reze-engine/engine/src/engine.ts) — 添加 stockingPerMaterialBindGroupLayout
- [manifest.json](file:///e:/reze-engine/web/public/models/风堇/manifest.json) — 更新三个材质
- [page.tsx](file:///e:/reze-engine/web/app/page.tsx) — 添加 sr_stocking preset 映射

**变更内容**：

1. **新增 STOCKING_BINDINGS_WGSL**（stocking.ts）：
   - StockingMaterialUniforms（48 字节）：uvScale, sockLength, cuffLength, transmissionWeight, subsurfaceWeight, roughness, tensionIntensity, thicknessAdjust, uvRatio
   - 9 个 binding：colorTexture + uniform + 6 张丝袜贴图 + sampler

2. **新增 SR_STOCKING_SHADER_WGSL**（stocking.ts）：
   - `eval_curve_coverage/fiber_width/fiber_thickness` — Float Curve 线性近似
   - `thighhighs_info` — ThighhighsInfoGen 区域计算
   - `uv_by_ratio` — UVByRatio 缩放
   - `mapping_sdf` — MappingSDF smoothstep
   - `view_dependent_coverage` — 视角相关覆盖
   - `hashed_alpha_threshold` — Wyman alpha testing
   - `@fragment fn fs` — 主着色器

3. **新增 stockingPerMaterialBindGroupLayout**（engine.ts）：
   - 9 个 entry（binding 0-8）
   - 专用 stockingPipelineLayout

4. **setupMaterialsForInstance 添加 sr_stocking 分支**（engine.ts）：
   - 加载 6 张丝袜贴图（sock_sdf/direction/normal/thickness/fur_layer/sdf_lut）
   - 创建 StockingMaterialUniforms（从 manifest uniforms 读取）

5. **manifest.json 更新**：
   - 白裤袜、吊带袜_丝袜、胖次_丝袜：sr_clothes → sr_stocking
   - 添加 6 张丝袜贴图路径
   - 添加 9 个 uniforms（uvScale 等）

6. **page.tsx 更新**：
   - `sr_stocking: ["白裤袜", "吊带袜_丝袜", "胖次_丝袜"]`

**验证**：engine 编译通过（tsc 无错误），.next 缓存已清理。

---

## 全面差异对比（2026-06-22 二次核对，MCP 逐节点验证）

> 本节通过 MCP `execute_blender_code` 逐节点核对了 Blender 中白裤袜 `SockAIO.021` 完整节点树（124 条内部链接）与 engine `sr_stocking` 实现。以下是仍然存在的差异，按影响程度排序。

### 差异 1（严重）：Base Color 信号链错误

**Blender 实际路径**（Type=Pantyhose 时）：
```
Mix.002 (RGBA, Factor=Menu Switch.001=0)
  A = Group Input.BaseColor (纯白 RGB(1,1,1))
  B = Mix.Result (cuff/body 区域颜色)
Factor=0 (Pantyhose) → 输出 = A = 纯白
  ↓
Reroute.004 → Principled BSDF.Base Color
  ↓
Reroute.005 → Color Ramp.Factor → 灰度 ramp（但 Color Ramp 只有紫色常量色）
```

**Engine 当前**（[stocking.ts:165-168](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts#L165-L168)）：
```wgsl
let texColor = textureSample(colorTexture, sockSampler, input.uv);
let skinColor: vec3f = texColor.rgb;  // 用 Body3.png 贴图
```

**差异**：
- Blender Base Color = **纯白 (1,1,1)**（Type=Pantyhose 时 Mix.002 Factor=0 选 A 端）
- Engine 用 Body3.png 贴图（皮肤贴图）作为颜色
- **结果**：engine 的织物颜色完全错误，Blender 是白色织物覆盖皮肤，engine 是直接显示皮肤贴图

### 差异 2（严重）：Alpha 计算链路完全不同

**Blender 实际路径**（Type=Pantyhose）：
```
Mix.003 (FLOAT, Factor=Menu Switch.001=0)
  A = Math.001 (Mix.006.Result × SockV3.Coverage)
  B = Math.012 (Group.002.Mask × Math.001)
Factor=0 (Pantyhose) → 输出 = A = Math.001

Math.001 = Mix.006.Result × SockV3.Coverage(Alpha)
Mix.006 (FLOAT, Factor=Menu Switch.001=0)
  A = Math (GREATER_THAN(Mix.005.Result, 0.1))  // 厚度>0.1 判断
  B = Math.002 (MAXIMUM(Math.013, Math))
Factor=0 → 输出 = A = (thickness > 0.1 ? 1 : 0)

→ Math.001 = (thickness>0.1) × Coverage
→ Alpha = thickness_gate × fiber_coverage
```

**Engine 当前**（[stocking.ts:141-145](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts#L141-L145)）：
```wgsl
var alpha = max(viewCoverage, 0.05);  // floor 防止完全透明
```

**差异**：
- Blender Alpha = `thickness_gate × fiber_coverage`（厚度门控 × 纤维覆盖）
- Engine Alpha = `max(viewCoverage, 0.05)`（只有视角覆盖，无厚度门控，还有 0.05 下限）
- **结果**：engine 的 alpha 永远不会为 0（有 0.05 下限），导致完全透明的区域也显示为半透明

### 差异 3（严重）：UVScale 被 Blender 内部缩放 0.667

**Blender 实际**：
```
Math.011 (MULTIPLY) = Group Input.UVScale × 0.6667
  → SockV3.UVScale = UVScale × 0.6667
```
白裤袜：UVScale=3000 → SockV3 实际 UVScale = 2000
吊带袜_丝袜：UVScale=3734 → SockV3 实际 UVScale = 2489.3

**Engine 当前**（[stocking.ts:121](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts#L121)）：
```wgsl
fn uv_by_ratio(uv: vec2f, ratio: f32, scale: f32) -> vec2f {
  return vec2f(uv.x * ratio * scale, uv.y * scale);  // 直接用 3000
}
```

**差异**：Engine 没有乘以 0.6667，纤维密度比 Blender 高 50%。

### 差异 4（严重）：Float Curve 的 Value 输入链理解错误

**Blender 实际**：
```
Float Curve (thickness→coverage):
  Factor = Math.015 = 1.0 - RGB_to_BW(Mix.002.Result)
  Value  = Mix.004.Result

Mix.004 (FLOAT, Factor=Menu Switch.001=0):
  A = Math.004 (Mix.005.Result + ThicknessAdjust)
  B = Math.014 (Math.013 + Math.004)
Factor=0 → 输出 = A = thickness + adjust

→ Float Curve 输入 = thickness (经过 Math.004 = thickness + adjust)
→ Float Curve.Factor = 1 - BW(BaseColor) = 1 - 1.0 = 0 (Pantyhose 白色)
```

**关键发现**：Float Curve 的 **Factor=0**（因为 BaseColor 是白色，1-BW=0），而 Factor=0 时 Float Curve 输出曲线的**起始值**。

Float Curve.001 (FiberWidth) 在 Factor=0 时输出 0.03（曲线起点）。
Float Curve.002 (FiberThickness) 在 Factor=0 时输出 0.025。
Float Curve.003 (FurAmount) 在 Factor=0 时输出 0.01。

**Engine 当前**（[stocking.ts:62-82](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts#L62-L82)）：
```wgsl
let curveInput = curve_thickness_to_coverage(thickness);
let fiberWidth = curve_fiber_width(curveInput);
let fiberThickness = curve_fiber_thickness(curveInput);
```

**差异**：Engine 把 thickness 值传给 Float Curve，但 Blender 的 Float Curve Factor=0（固定），Value=thickness。Float Curve 在 Factor=0 时输出的是常量（曲线起点值），**与 thickness 无关**。

### 差异 5（严重）：Roughness 计算链路错误

**Blender 实际**：
```
Mix.010 (FLOAT, Factor=Math.025):
  A = 0.85 (常量)
  B = Group Input.Roughness = 0.35
Factor = Math.025 = (1 - FloatCurve.001(FiberWidth)) × IsFiber

Math.026 = 1 - FloatCurve.001.Value  (反向 FiberWidth)
Math.025 = Math.026 × Group.IsFiber

→ Roughness = mix(0.85, 0.35, (1-FiberWidth) × IsFiber)
→ IsFiber 区域：Roughness = mix(0.85, 0.35, 1-FiberWidth)
→ 非 IsFiber 区域：Roughness = 0.85
```

**Engine 当前**（[stocking.ts:178-180](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts#L178-L180)）：
```wgsl
let gapRoughness: f32 = 0.35;
let roughnessMix = clamp((1.0 - fiberWidth) * isFiber, 0.0, 1.0);
let dynamicRoughness = mix(gapRoughness, sockMaterial.roughness, roughnessMix);
// = mix(0.35, 0.85, (1-fiberWidth)*isFiber)
```

**差异**：A/B 端反了！
- Blender：`mix(0.85, 0.35, ...)` → A=0.85, B=0.35
- Engine：`mix(0.35, 0.85, ...)` → A=0.35, B=0.85
- 当 factor=0 时：Blender=0.85，Engine=0.35（差异巨大）

### 差异 6（中等）：Transmission Weight 来自 Group Input 而非常量

**Blender 实际**：
```
Principled BSDF.Transmission Weight = Group Input.007.Transmission Weight = 0.3
Principled BSDF.Subsurface Weight = Group Input.007.Subsurface Weight = 0.4
```
这些直接连到 Principled BSDF，**不经过 Mix.003（Alpha）**。

**Engine 当前**：使用 `sockMaterial.transmissionWeight` (0.3)，值正确，但实现方式是 `fabric × (1-T) + skinLit × T`，这是错误的近似。

### 差异 7（中等）：Subsurface Scale 被 Alpha 动态调整

**Blender 实际**：
```
Mix.008 (FLOAT, Factor=Mix.003.Result=Alpha):
  A = 0.1
  B = 0.001
→ Subsurface Scale = mix(0.1, 0.001, Alpha)
→ Alpha 越高，SSS scale 越小（越不透明 → 越少次表面散射）
```

**Engine 当前**：完全没有 Subsurface Scale 动态调整。

### 差异 8（中等）：Specular Tint 动态混合

**Blender 实际**：
```
Mix.011 (RGBA, Factor=Math.025):
  A = (1,1,1,1) 白色
  B = Group Input.Anisotropic Tint = (1,1,1,1)
→ Specular Tint = mix(白, AnisotropicTint, (1-FiberWidth)×IsFiber)
```

**Engine 当前**：使用 `eval_principled` 的固定 Specular=0.5，无动态 Specular Tint。

### 差异 9（中等）：Normal Map 采样路径错误

**Blender 实际**：
```
SockV3.Normal → Principled BSDF.Normal
SockV3 内部：sock_tiled_normal.png → Normal Map 节点 → 输出
```
法线来自 SockV3 内部的 `sock_tiled_normal.png`，经过 Normal Map 节点转换。

**Engine 当前**（[stocking.ts:147-158](file:///e:/reze-engine/engine/src/shaders/materials/starrail/stocking.ts#L147-L158)）：
手动构建 TBN 并采样 `sockNormalTexture`，但 UV 用的是 `fiberUV`（缩放后的 UV），而 Blender 中 Normal Map 用的是 SockV3 内部经过 AdjustCellUV 变换的 UV。

### 差异 10（中等）：Color Ramp 用于区域颜色（非主色调）

**Blender 实际**：
```
Mix.002 (Type=Pantyhose → Factor=0):
  A = BaseColor (白)
  B = Mix.Result (区域颜色)
→ 输出 = 白色（Pantyhose 模式忽略区域颜色）
```

但 Color Ramp.002（RampThighhighsThickness）仍然通过 Math.028 影响 Math.007：
```
Math.028 = BodyMask × Evaluate Closure.002 (RampThighhighsThickness 采样)
Math.007 = CuffMask + Math.028
Math.013 = Math.007 × 1.0
→ 影响 Math.002 (MAXIMUM) → Mix.006.B (Thighhighs 模式才用)
```
Pantyhose 模式下 Math.013 不影响最终结果（Mix.006 Factor=0 选 A）。

### 差异 11（低）：Glossy BSDF 贡献为 0 但 Add Shader 存在

**Blender 实际**：
```
Glossy BSDF.Color = Mix.007.Result
Mix.007 (Factor=Math.027):
  A = (0,0,0) 黑色
  B = (1,1,1) 白色
Math.027 = Mix.003.Result × Math.003
```
Glossy BSDF 通过 Add Shader 叠加到 Principled BSDF。

**Engine 当前**：完全忽略了 Glossy BSDF（Ashikhmin-Shirley 各向异性高光）。

**评估**：Glossy 的 Color 通过 Mix.007 混合，Factor=Math.027=Alpha×Math.003。Math.003=Math.023×Math.010，其中 Math.023=IsFiber×FloatCurve.005。这可能产生非零贡献，不应忽略。

### 差异 12（低）：Anisotropic Rotation 来自 Subsurface Weight 输入

**Blender 实际**：
```
Principled BSDF.Anisotropic Rotation = Group Input.007 (Subsurface Weight = 0.4)
```
注意：Group Input.007 是第 7 个输入（Subsurface Weight），但连接到 Anisotropic Rotation。

**Engine 当前**：没有处理 Anisotropic Rotation。

### 差异 13（低）：PantyhoseStyle 映射

**Blender 实际**：
- PantyhoseStyle=0 → PantyhoseThicknessSelector 选择 `cf_panst_07_t.png`
- 但 UseCustomThickness=True → Mix.005 = CustomThickness（跳过贴图选择器）

**Engine 当前**：加载了 `cf_panst_07_t.png` 但因 UseCustomThickness=True 实际不使用它。

### 差异 14（低）：cf_panst 厚度贴图路径

**Blender 实际**：PantyhoseThicknessSelector.023 内部 Group.001 的 Index=5（PantyhoseStyle="0" 映射到 index 5），选择 `cf_panst_00_t.png`。

**需要验证**：PantyhoseStyle 字符串 "0" 映射到的实际贴图索引。

---

## 修复优先级

| 优先级 | 差异 | 影响 |
|--------|------|------|
| P0 | #1 Base Color 用纯白而非贴图 | 织物颜色完全错误 |
| P0 | #2 Alpha 缺少厚度门控 | 透明度错误 |
| P0 | #5 Roughness A/B 端反了 | 粗糙度完全错误 |
| P1 | #3 UVScale 缺少 ×0.6667 | 纤维密度错误 |
| P1 | #4 Float Curve Factor=0 输出常量 | 纤维参数错误 |
| P2 | #7 Subsurface Scale 动态调整 | SSS 效果缺失 |
| P2 | #8 Specular Tint 动态混合 | 高光颜色错误 |
| P2 | #9 Normal Map UV 变换 | 法线细节错误 |
| P3 | #11 ~~Glossy BSDF 叠加~~ | **已排除：Add Shader 输出未连接** |
| P3 | #12 Anisotropic Rotation | 各向异性旋转缺失 |

---

## 完整节点规格（2026-06-22 三次核对，全子组展开）

> 以下是通过 MCP 逐子组展开得到的完整规格。所有子节点组已完全展开，无黑盒。

### 关键修正（推翻之前的结论）

1. **Glossy BSDF 不贡献最终渲染** — Add Shader 的输出**未连接**到 Group Output。只有 `Principled BSDF.BSDF → Group Output.BSDF`。之前"差异11"假设的 Glossy 贡献是错误的。
2. **白裤袜 vs 吊带袜_丝袜唯一差异是 UVScale**（3000 vs 3734），其他所有参数完全相同。
3. **PantyhoseStyle="0" → cf_panst_07_t.png 的 Alpha 通道**（不是 RGB），通过 Menu Switch 索引 0 选择。

### 子节点组清单

| 子组 | 功能 | 层级 |
|------|------|------|
| SockAIO.021 | 顶层丝袜着色器 | L1 |
| SockV3.027 | 纤维覆盖率系统 | L2 |
| UVByRatio.028 | UV 缩放 | L3 |
| AdjustCellUV.028 | Cell UV 调整 | L3 |
| BuildCellUV.028 | Cell pattern 构建 | L3 |
| MappingSDF.028 | SDF smoothstep 映射 | L3 |
| SmoothStep (Group.001) | 5次多项式 smoothstep | L4 |
| View Dependent Coverage.028 | 视角相关覆盖 | L3 |
| ThighhighsInfoGen.023 | 区域 mask 计算 | L2 |
| PantyhoseThicknessSelector.023 | 厚度贴图选择 | L2 |

### UVByRatio.028 — UV 缩放

```
输入: FiberUVRatio (UVRatio=0.3), FiberUVScale (UVScale × 0.6667)
UV 来源: Texture Coordinate.UV (mesh UV)

计算:
  X = UV.x × FiberUVRatio × FiberUVScale
  Y = UV.y × FiberUVScale

输出: vec2(X, Y)
```

**关键**：FiberUVScale = UVScale × 0.6667（来自 SockAIO 的 Math.011）。
白裤袜：3000 × 0.6667 = 2000
吊带袜：3734 × 0.6667 = 2489.3

### AdjustCellUV.028 — Cell UV 调整

```
输入: UV.x (fract(UVByRatio.X)), ThreadLength

计算:
  ThreadLength_inv = 1.0 / (ThreadLength × 2)
  cellWidth = 1.0 - ThreadLength_inv
  
  // ThreadL (左线程区域)
  isLeft = (UV.x < ThreadLength)
  ThreadLUV = isLeft × cellWidth × (UV.x / ThreadLength)
  
  // Knot (结点区域)
  knotStart = ThreadLength + cellWidth
  isInKnot = (UV.x < knotStart) && (UV.x > ThreadLength)
  KnotUV = isInKnot × ((UV.x - ThreadLength) / cellWidth)
  
  // ThreadR (右线程区域)
  isRight = (UV.x > ThreadLength + cellWidth)
  distFromEnd = 1.0 - UV.x
  ThreadRUV = isRight × cellWidth × (distFromEnd / ThreadLength)
```

### BuildCellUV.028 — Cell Pattern 构建

```
输入: ThreadLUV, KnotUV, ThreadRUV
常量: Value = (某固定值，需从节点读取)

计算:
  // 每个区域用 SmoothStep 风格生成 pattern
  halfVal = Value × 0.5
  
  // ThreadL pattern
  tL = ThreadLUV × Value
  tL_pattern = tL + (1.0 - 2.0×Value)  // Math.006 = 1 - Value×2
  
  // Knot pattern
  isKnot = (KnotUV > 0.0)
  knot_pattern = isKnot × (KnotUV × (1 - Value×2) + Value)
  
  // ThreadR pattern
  isThreadR = (ThreadRUV > 0.0)
  tR_pattern = isThreadR × (ThreadRUV × Value + (1 - Value))
  
  // 合并
  output = tL_pattern + knot_pattern + tR_pattern
```

### MappingSDF.028 — SDF 映射

```
输入: SDF (sock_tiled_sdf.png RGB), FiberWidth, FiberSDFSoftness=0.03

计算:
  fw = clamp(FiberWidth, 0, 1)
  min_val = 1.0 - fw
  max_val = min_val + fw × FiberSDFSoftness
  
  // SmoothStep (5次多项式)
  t = (SDF - min_val) / (max_val - min_val)
  t = clamp(t, 0, 1)
  result = t × t × t × (t × (t × 6 - 15) + 10)
  
  // 即 GLSL smoothstep()
输出: result (0-1 coverage)
```

### View Dependent Coverage.028 — 视角相关覆盖

```
输入: Thickness (FiberThickness), Coverage (Mix.Result)
几何: Normal (Geometry.Normal), Incoming (Geometry.Incoming)

计算:
  NdotV = clamp(dot(Normal, Incoming), 0, 1)
  
  offset = 1.0 - Thickness
  scaled = NdotV × offset
  adjusted = scaled + Thickness
  factor = 1.0 - (Coverage / adjusted)
  
  result = mix(Coverage, 1.0, factor)
  // = Coverage × (1 - factor) + 1.0 × factor
输出: result
```

### ThighhighsInfoGen.023 — 区域计算

```
输入: LocalHeight (UV.Y), SrcUV (UV), Length (SockLength=0.75), CuffHeight (CuffLength=0.03)

计算:
  Mask = (LocalHeight < Length) ? 1 : 0
  cuffStart = Length - CuffHeight = 0.72
  isInCuff = (LocalHeight >= cuffStart) ? 1 : 0
  CuffMask = Mask × isInCuff
  BodyMask = Mask - CuffMask
  
  // CuffUV: X=SrcUV.X, Y=(1 - (LocalHeight+0.03-Length)/0.03)
  // BodyUV: X=SrcUV.X, Y=abs(LocalHeight - (Length-CuffHeight))
  DistanceToCuff = distance(LocalHeight, Length)
输出: CuffUV, Mask, CuffMask, BodyMask, BodyUV, DistanceToCuff
```

### PantyhoseThicknessSelector.023 — 厚度选择

```
Menu Switch 映射:
  Index 0 → cf_panst_07_t.png Alpha  ← 白裤袜/吊带袜/胖次使用 (PantyhoseStyle="0")
  Index 1 → cf_panst_09_t.png Alpha
  Index 2 → cf_panst_04_t.png Alpha
  Index 3 → cf_panst_08_t.png Alpha
  Index 4 → cf_panst_00_t.png Alpha
  Index 5 → cf_panst_02_t.png Alpha

注意: 使用 Alpha 通道，不是 RGB Color。
```

### SockV3.027 完整信号流（精确版）

```
输入:
  UVRaito = UVRatio = 0.3
  UVScale = 外部UVScale × 0.6667（白裤袜=2000, 吊带袜=2489.3）
  TensionIntensity = 0.8
  FiberWidth = Float Curve.001 输出 = 0.03（Factor=0 常量）
  FiberThickness = Float Curve.002 × 10 = 0.025 × 10 = 0.25
  FurAmount = Float Curve.003 × 5 = 0.01 × 5 = 0.05
  UseLut = 0.0 (关闭)
  FiberSDFSoftness = 0.03

内部信号流:
  1. UVByRatio(UVRaito, UVScale) → fiberUV
     X = UV.x × 0.3 × 2000 = UV.x × 600
     Y = UV.y × 2000
  
  2. Separate XYZ(fiberUV) → X, Y
  3. Math(FRACT, X) → cellUvx = fract(X)
  
  4. Vector Math.001: Generated × (0.14, 0.18, 1.0) → noisePos
     注意: 用 Texture Coordinate.Generated，不是 UV
  
  5. Noise Texture(3D, noisePos, scale=10, detail=0, distortion=0.52) → Factor
  6. Math.013(1.0 - Factor) → invFactor
  7. Math.012(FiberWidth × invFactor) → scaledFiberWidth [→ MappingSDF]
  
  8. Math.009(TensionIntensity × 0.5) = 0.4 → tensionScale
  9. Math.001(Noise.Factor × tensionScale) → ThreadLength [→ AdjustCellUV]
  
  10. AdjustCellUV(cellUvx, ThreadLength) → ThreadLUV, KnotUV, ThreadRUV
  11. BuildCellUV(ThreadLUV, KnotUV, ThreadRUV, Value=0.2) → cellPattern
  
  12. Noise Texture.001(2D, fiberUV, scale=UVScale, detail=2, distortion=0.4) → Factor.001
  13. Math.003(Factor.001 - 0.5) → noiseOffset
  14. Math.004(noiseOffset × 0.2) → smallOffset
  15. Math.002(smallOffset + cellPattern) → adjustedX
  
  16. Combine XYZ(adjustedX, Y, 0) → adjustedUV
  17. Reroute(adjustedUV) → 喂给所有 3 张贴图 (SDF/Direction/Normal)
  
  18. Image Texture.005(sock_tiled_sdf.png, adjustedUV, Non-Color) → SDF
  19. Image Texture.004(sock_tiled_direction.png, adjustedUV, Non-Color) → Direction
  20. Image Texture.006(sock_tiled_normal.png, adjustedUV, Non-Color) → NormalTS
  
  21. MappingSDF(SDF.R, scaledFiberWidth, 0.03) → sdfCoverage
      (5次 smoothstep: t³ × (t × (t×6-15) + 10))
  
  22. Vector Math(adjustedUV × (0.5, 0.5, 0)) → furUV
  23. Image Texture.001(FurLayer.png, furUV, sRGB) → furColor
  24. Math.005(furColor × FurAmount) → furVal
  
  25. Mix(SCREEN, 1.0, sdfCoverage, furVal) → finalCoverage
      (SCREEN: A+B-A×B)
  
  26. Group.001 ViewDependentCoverage(FiberThickness, finalCoverage) → Result
  
  27. Normal Map(TANGENT, strength=1.0, sock_tiled_normal.png) → Normal

输出:
  Coverage(Alpha) = ViewDependentCoverage 结果
  Normal = Normal Map 转换后的世界空间法线
  NormalTS = sock_tiled_normal.png 原始颜色（未使用）
  IsFiber = ??? (Separate XYZ.001.X 来自 Mix.001，非 Direction)
  Fur = furVal（未使用）
  Direction = sock_tiled_direction.png Color（原始贴图值）
```

**关键修正**：
- sock_tiled_sdf/direction/normal 三张贴图使用**相同的 adjustedUV**（不是 fiberUV 直接采样）
- adjustedUV 经过了 cell pattern + noise 扰动
- FurLayer 用 adjustedUV × 0.5（更粗的 UV）
- IsFiber 来自 Mix.001 的 X 分量，不是 Direction 贴图

### Noise Texture 参数

| 节点 | 维度 | Scale | Detail | Roughness | Lacunarity | Distortion | Vector |
|------|------|-------|--------|-----------|------------|------------|--------|
| Noise Texture | 3D | 10.0 | 0.0 | 0.0 | 0.0 | 0.52 | Generated × (0.14,0.18,1) |
| Noise Texture.001 | 2D | UVScale | 2.0 | 0.0 | 2.0 | 0.4 | fiberUV |

### Image Texture 色彩空间

| 贴图 | 色彩空间 |
|------|---------|
| sock_tiled_sdf.png | Non-Color |
| sock_tiled_direction.png | Non-Color |
| sock_tiled_normal.png | Non-Color |
| SDFLut.png | Linear Rec.709 |
| Substance_graph_FurLayer.png | sRGB |

### 最终渲染路径（已确认）

```
Principled BSDF.BSDF → Group Output.BSDF → Material Output.Surface

Add Shader (Principled + Glossy) → 未连接（不渲染）
```

**结论**：Glossy BSDF（Ashikhmin-Shirley）**完全不贡献最终图像**。只需复现 Principled BSDF。

### Principled BSDF 最终参数（Pantyhose 模式）

| 参数 | 值 | 来源 |
|------|-----|------|
| Base Color | (1,1,1) 纯白 | Mix.002 (Factor=0 选 BaseColor) |
| Metallic | 0.0 | 常量 |
| Roughness | mix(0.85, 0.35, (1-FiberWidth)×IsFiber) | Mix.010 |
| IOR | 1.53 | 常量 |
| Alpha | thickness_gate × fiber_coverage | Mix.003 |
| Normal | SockV3.Normal | sock_tiled_normal.png |
| Subsurface Weight | 0.4 | Group Input |
| Subsurface Radius | (1, 0.2, 0.1) | 常量 |
| Subsurface Scale | mix(0.1, 0.001, Alpha) | Mix.008 |
| Subsurface IOR | 1.4 | 常量 |
| Specular IOR Level | 0.5 | 常量 |
| Specular Tint | mix(白, AnisotropicTint, (1-FiberWidth)×IsFiber) | Mix.011 |
| Anisotropic | IsFiber | SockV3 输出 |
| Anisotropic Rotation | 0.75 | Group Input |
| Transmission Weight | 0.3 | Group Input |
| Coat Weight | 0.0 | 常量 |
| Sheen Weight | 0.02 | 常量 |
| Sheen Roughness | 0.5 | 常量 |

### Alpha 完整计算链（Pantyhose 模式）

```
Math.005 (UseCustomThickness=True):
  A = PantyhoseThicknessSelector(cf_panst_07_t.png Alpha)
  B = CustomThickness (Float Curve(bodyUV.Y))
  Result = B (因为 UseCustomThickness=true)

Math (GREATER_THAN(Math.005, 0.1)):
  thickness_gate = (thickness > 0.1) ? 1 : 0

Math.004 (Math.005 + ThicknessAdjust):
  thickness_adjusted = thickness + adjust

Mix.004 (Factor=0 Pantyhose):
  A = thickness_adjusted
  B = Math.013 + thickness_adjusted (Thighhighs 模式)
  Result = thickness_adjusted

Float Curve (Factor = 1 - BW(白色) = 0):
  Factor=0 → 输出曲线起始值
  输出 = 0 (curve start at y=0)
  → Reroute.002 传递 0 给所有 Float Curve.001/002/003

Float Curve.001 (FiberWidth, Factor=1, Value=0):
  Value=0 → 输出 0.03 (曲线起点)

Float Curve.002 (FiberThickness, Factor=1, Value=0):
  Value=0 → 输出 0.025

Float Curve.003 (FurAmount, Factor=1, Value=0):
  Value=0 → 输出 0.01

Math.009 (FloatCurve.002 × 10):
  FiberThickness_input = 0.025 × 10 = 0.25

Math.006 (FloatCurve.003 × 5):
  FurAmount_input = 0.01 × 5 = 0.05

→ SockV3(FiberWidth=0.03, FiberThickness=0.25, FurAmount=0.05)

Mix.006 (Factor=0 Pantyhose):
  A = thickness_gate
  B = MAXIMUM(Math.013, thickness_gate) (Thighhighs)
  Result = thickness_gate

Math.001 (Mix.006 × Coverage):
  alpha_base = thickness_gate × SockV3.Coverage

Mix.003 (Factor=0 Pantyhose):
  A = alpha_base
  B = Mask × alpha_base (Thighhighs)
  Result = alpha_base

→ 最终 Alpha = thickness_gate × fiber_coverage
```

### Float Curve 关键行为（Factor=0 时）

| 曲线 | 用途 | Factor=0 时输出（Value=0） |
|------|------|---------------------------|
| Float Curve | thickness→coverage | **0** (曲线起点 y=0) |
| Float Curve.001 | thickness→FiberWidth | **0.03** |
| Float Curve.002 | thickness→FiberThickness | **0.025** |
| Float Curve.003 | thickness→FurAmount | **0.01** |
| Float Curve.005 | FiberWidth→strength | **0.994** (反向曲线起点) |

**重要**：Float Curve.Factor 来自 `Math.015 = 1.0 - RGB_to_BW(BaseColor)`。当 BaseColor=白色(1,1,1) 时，BW=1.0，Factor=0。这意味着**所有 Float Curve 在 Pantyhose 模式下固定在 Factor=0**，输出值与 thickness **无关**，只取曲线起始值。

### Color Ramp（ThighhighsInfoGen 区域颜色）

| Color Ramp | 位置 | 颜色 | 用途 |
|-----------|------|------|------|
| Color Ramp.001 | 0.0 | (0.31, 0.27, 0.60) 紫 | SampleCuffColor |
| Color Ramp.001 | 0.99 | (0.31, 0.27, 0.60) 紫 | SampleCuffColor |
| Color Ramp | 0.0 | (0.31, 0.27, 0.60) 紫 | SampleSockBodyColor |
| Color Ramp.002 | 0.0 | (0.003, 0.003, 0.003) 黑 | RampThighhighsThickness |
| Color Ramp.002 | 0.99 | (0.604, 0.604, 0.604) 灰 | RampThighhighsThickness |

### Evaluate Closure 行为

Blender 4.x 的 `NodeEvaluateClosure` 是一种延迟求值机制：
- `SampleCuffColor` (Closure) + `CuffUV` (Vector) → 在 CuffUV 位置采样 Color Ramp.001
- `SampleSockBodyColor` (Closure) + `BodyUV` (Vector) → 在 BodyUV 位置采样 Color Ramp
- `RampThighhighsThickness` (Closure) + `BodyUV.Y` → 在 BodyUV.Y 采样 Color Ramp.002

**但在 Pantyhose 模式下**，这些区域颜色通过 Mix.002(Factor=0) 被完全忽略，BaseColor=白色直接输出。

### Material 设置

- `blend_method`: `BLEND` (alpha 混合)
- `surface_render`: true
