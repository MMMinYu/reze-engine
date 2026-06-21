# StarRailShader WGSL 移植参考

> 本文档为 Reze Engine 实现 `sr_*` 材质预设的技术参考，源自对"风堇1.0_私模"预设（StarRailShader by 小二今天吃啥啊）的 Blender 节点逆向分析。
> 不是用户文档，仅供引擎开发者移植 WGSL 时参考。

## 1. 渲染配置

| 项 | Blender 值 | Reze Engine 对应 |
|----|-----------|-----------------|
| 渲染引擎 | BLENDER_EEVEE | WebGPU（同构光栅化） |
| 色彩管理 | **Filmic + High Contrast look**（exposure=0, gamma=1） | [composite.ts](../engine/src/shaders/passes/composite.ts) Filmic（`FILMIC_MODE=1` 即 HC LUT） |
| 世界背景 | 纯色 (0.0509, 0.0509, 0.0509)，strength=1.0 | 引擎环境光 |
| 灯光 | **只有 1 个 SunLight**（energy=0，仅提供方向；颜色暖橙 (1.0, 0.385, 0.163)） | 引擎 `light.lights[0]` 方向光 |

注意：场景里**没有 PointLight**，SunLight 的 energy=0（不发光），只作为方向参考被 Attribute 节点读取。所有明暗都来自虚拟日光 Group 内基于 `Attribute[SUN]` 方向的算法，以及 ramp/matcap 贴图。引擎应复现"方向驱动 + ramp 着色"的 NPR 模型，而非物理光照。

## 2. Attribute 节点映射（关键）

StarRailShader 用 Attribute 节点读取 mesh 几何属性（`attribute_type = GEOMETRY`，即自定义几何属性）：

| 属性名 | 含义 | WGSL 移植方案 |
|--------|------|--------------|
| `SUN` | 灯光方向（向量） | `light.lights[0].direction.xyz`（引擎已有 uniform） |
| `FRONT` | 脸部前向（向量，几何属性） | 作为 uniform `faceFront` 传入 |
| `RIGHT` | 脸部右向（向量，几何属性） | 作为 uniform `faceRight` 传入 |

**移植决策**：`FRONT`/`RIGHT` 在原版是几何属性（每顶点可能不同），但对脸部 SDF 阴影而言，整张脸共享一个朝向已足够准确。引擎用 uniform 传入头部骨骼的朝向（从 Model 的骨骼世界矩阵推导），在 `sr_face` 材质 uniform 中加 `faceFront: vec3f, faceRight: vec3f`。

> ⚠️ 注意 MMD 坐标系约定：MMD 模型默认面向 -Y（前向 = -Y，右向 = +X，上向 = +Z）。Blender 里这些 Attribute 的值由 mesh 自定义属性或驱动器写入；引擎移植时需保证 `faceFront`/`faceRight` 与 `sun` 方向处于**同一坐标系**（世界空间），否则 SDF 左右判断与 backface guard 会出错。

## 3. 子 Group 实现规格

> 经 MCP 逐个核对 Blender 节点（2026-06-14）。下列 10 个是核心子 Group，均经实际验证。
> Blender 里另有 smoothstep.002（手工 smoothstep）等辅助子组，结构标准，此处略。

### 3.1 布林冯光照模型 (Blinn-Phong)
**输入**: 无（用 Geometry.Normal + Geometry.Incoming + Attribute[SUN]）
**输出**: Value (高光强度) — 经 MCP 核对，只有 Value 输出，无 Color

**逻辑**（经 MCP 核对 `布林冯光照模型.002`）：
```
N = Geometry.Normal
V = Geometry.Incoming (视方向)
L = Attribute[SUN] (灯光方向)
H = normalize(L + V)  // Vector Math ADD + NORMALIZE，半角向量
spec = dot(N, H)       // Vector Math.002 DOT_PRODUCT（无 power，调用方按需加）
```
节点链：Attribute(SUN) + Geometry.Incoming → ADD → NORMALIZE → 与 Geometry.Normal 做 DOT_PRODUCT。

**WGSL 函数**：`fn blinn_phong(n: vec3f, v: vec3f, l: vec3f, power: f32) -> f32`

### 3.2 虚拟日光 (Virtual Sun / Half-Lambert)
**输入**: Image (Color 贴图经校色后的值)
**输出**: 半兰伯特光照模型 (Value)

**逻辑**（经 MCP 核对 `虚拟日光.002`）：
```
N = Geometry.Normal
L = Attribute[SUN]
L_scaled = L * 2.0                       # VectorMath.001 SCALE ×2
dotNL = dot(N, L_scaled)                 # VectorMath DOT_PRODUCT
half_lambert = map_range(dotNL, -1, 1, 0, 1)   # Map Range (LINEAR)
green = Image.Green channel              # Separate Color
smooth = smoothstep(0, 0.2, green)       # Group.005 smoothstep.002
mixed = multiply(half_lambert, smooth)   # Mix MULTIPLY
result = mixed * 0.5 + 0.5               # Math.003 MULTIPLY_ADD(val, 0.5, 0.5)
final = result ^ 2.0                     # Math.001 POWER(_, 2.0) —— 平方，不是开方！
```

⚠️ **关键修正**：最后是 **平方（`^2.0`）**，不是开方。这会让中间调进一步压暗、对比度提升，符合 toon 的硬边终结线效果。

**WGSL 函数**：`fn virtual_sun(n: vec3f, l: vec3f, ilm_green: f32) -> f32`

### 3.3 SDF 脸部阴影 (SDF + SDF.tex)
**输入**: 无（用 UV Map + Attribute[FRONT/RIGHT/SUN]）
**输出**: Value (1 = lit, 0 = shadow)

**逻辑**（经 MCP 核对 `SDF.002`）：
```
# 1. 左右判断：用 RIGHT 与 SUN 的点积（不是 FRONT）
front = Attribute[FRONT]
right = Attribute[RIGHT]
sun   = Attribute[SUN]
dot_R = dot(right, sun)                  # VectorMath.001 DOT_PRODUCT
is_right = dot_R > 0.0                   # Math.001 GREATER_THAN(_, 0.0)
dot_F = dot(front, sun)                  # VectorMath.002 DOT_PRODUCT

# 2. UV 镜像（根据 is_right 翻转 X，使单张 FaceMap 覆盖两侧）
scale = mix(vec3(-1,1,1), vec3(1,1,1), is_right)   # Combine XYZ → Mix
uv_mapped = transform(UV, scale=scale)             # Mapping

# 3. 采样 SDF FaceMap
sdf_alpha = sample(SDF_FaceMap, uv_mapped).a       # SDF.tex.002

# 4. 动态阈值判断（阈值随 dot_F 变化，不是固定 0.5！）
threshold = dot_F * 0.5 + 0.5           # Math MULTIPLY_ADD(_, 0.5, 0.5)
lit = threshold > sdf_alpha             # Math.002 GREATER_THAN(threshold, sdf_alpha)

# 5. Backface guard：太阳在脑后时整张脸不入光
back_facing = dot_F <= 0.0
final = lit && !back_facing
```

⚠️ **关键修正**：
- 左右判断用 `dot(RIGHT, SUN) > 0`（文档原写 `dot_F > 0.5`，错误）。
- 阈值是**动态**的 `dot_F*0.5 + 0.5`，与 SDF alpha 比较决定 lit/shadow（文档原写固定 `> 0.5`，错误）。
- SDF.tex 内部还有一层固定阈值 0.9（`Math.002 GREATER_THAN(_, 0.9)`），用于二值化 SDF alpha。

SDF.tex 内部：根据角色类型从多张 FaceMap 中选 1 张（W_120_Kid / W_140_Girl / W_160_Maid / W_170_Lady / W_168_Miss / M_150_Boy / M_170_Lad / M_180_Male 等，本模型用 `W_140_Girl_FaceMap_00.png`，colorspace=sRGB）。引擎只需绑定实际使用的那张。

**WGSL 函数**：`fn sdf_face_shadow(uv: vec2f, faceFront: vec3f, faceRight: vec3f, sun: vec3f, sdfMap: texture_2d<f32>, sampler: sampler) -> f32`

### 3.4 matcap / matcap.hair (材质捕捉)
**输入**: 无（用 Texture Coordinate.Normal）
**输出**: Color

**逻辑**（经 MCP 核对 `matcap.002` / `matcap.hair.002`）：
```
N_world = Texture Coordinate.Normal
N_view = VectorTransform(N_world, from=WORLD, to=VIEW)  # 法线转到视图空间
uv = N_view.xy * 0.5 + 0.5   # Mapping(Location=0.5, Scale=0.5)
color = sample(matcap_texture, uv)
```

贴图与 colorspace（经 MCP 核对，影响加载方式）：
- `matcap`（身体/衣服）用 `Avatar_Tex_MetalMap.tga`，**colorspace = Non-Color**
- `matcap.hair`（头发）用 `hair_s.bmp`，**colorspace = sRGB**

⚠️ 这两张 matcap colorspace 不同：MetalMap 是数据贴图（Non-Color），hair_s 是颜色贴图（sRGB）。引擎加载时需按 colorspace 区分（Non-Color 用 unorm，sRGB 用 unorm-srgb 自动解码）。

**WGSL 函数**：`fn matcap_sample(n: vec3f, viewMatrix: mat4x4f, matcapTex: texture_2d<f32>, sampler: sampler) -> vec3f`

注意：WGSL 里需要 `camera.view` 矩阵把世界法线转到视图空间。

### 3.5 ramp / ramp.hair (Toon 色阶)

**ramp.clothes.002 (衣服/身体/脸用)** — 经 MCP 核对，**实际采样 Warm Ramp**：
```
# ramp.clothes.002 子组内有 2 张贴图，但只有 Warm 连到输出
cool_color = sample(Body_Cool_Ramp, Vector)   # 未连接输出
warm_color = sample(Body_Warm_Ramp, Vector)   # 连到 Group Output
→ 输出 = warm_color
```
⚠️ 注意：ramp.clothes 子组本身只是贴图采样 + 选 Warm；ramp 的**色阶离散化**和 RGB Curves 在外层 `ramp.002`（衣服/身体）或 `ramp`（脸）子组里：
```
# 外层 ramp 子组（如 ramp.002）
mapped = map_range(Value, 0, 1, 0, 1)         # 恒等映射
v = ramp采样(alpha)                            # alpha→V 行号
vec = combine(mapped, v, 0)
color = ramp.clothes(vec)                      # 采样 Warm Ramp
color = rgb_curves(color)                      # B 曲线 (0.7167,0.4244)
color = rgb_curves_with_factor(color, invert(v))  # B 曲线 (0.563,0.3999)
```
其中 `ramp采样(alpha)` 把 alpha 经 7 档 GREATER_THAN 阈值（0.10/0.20/0.33/0.45/0.58/0.70/0.85）映射到 ramp 贴图的 V 行号：`V = 0.125*N + 0.025`（N∈{0.25,1,2,3,4,5,6,7} → V∈{0.05625,0.15,...,0.9}）。alpha=0 时全档为 false → V=0.05625。

**ramp.hair.002 (头发用)** — 经 MCP 核对，**实际采样 Warm Ramp**（不是 Cool！）：
```
cool_color = sample(Hair_Cool_Ramp, Vector)   # 未连接输出
warm_color = sample(Hair_Warm_Ramp, Vector)   # 连到 RGB Curves → 输出
color = rgb_curves(warm_color)                 # B 曲线 (0.5822, 0.3427)
→ 输出 = color
```
⚠️ **关键修正**：文档原写"头发用 Cool Ramp，Warm 是备用"，**正好反了**。Warm Ramp 才是实际使用的。

**WGSL 函数**：
- 衣服/身体/脸：`fn ramp_lookup(value: f32, alpha: f32, rampTex: texture_2d<f32>, sampler: sampler) -> vec3f`（内含 ramp采样的 V 映射 + 两条 RGB Curves）
- 头发：`fn ramp_hair_lookup(uv: vec2f, rampTex: texture_2d<f32>, sampler: sampler) -> vec3f`（直接采样 + B 曲线）

### 3.6 ilm.clothes / ilm.hair (ILM 控制贴图)
**输入**: Vector (UV)
**输出**: Color (ILM 多通道), Alpha

**逻辑**：纯贴图采样。
```
color = sample(ILM_LightMap, Vector)
alpha = sample(ILM_LightMap, Vector).a
```
ILM 贴图通道含义（星穹铁道标准）：
- R = AO (环境光遮蔽)
- G = specular mask (高光区域)
- B = shadow threshold (阴影阈值)
- A = material region (材质区域 mask)

**WGSL 函数**：直接用 `textureSample`，无需封装。

### 3.7 smoothstep (平滑步进)
**输入**: a, b, x
**输出**: Result

**逻辑**：标准 GLSL smoothstep，但用 19 个 Math 节点手工实现（Blender 无内建 smoothstep）。
```
t = clamp((x - a) / (b - a), 0, 1)
result = t * t * (3 - 2*t)
```

**WGSL 函数**：`fn smoothstep_n(a: f32, b: f32, x: f32) -> f32`（直接用 WGSL 内建 `smoothstep`）

### 3.8 校色 (Color Correct)
**输入**: Color
**输出**: Color

**逻辑**（经 MCP 核对 `校色.002`）：
```
# 有两条 RGB Curves，但只有一条（RGB Curves）连到输出！
c1 = rgb_curves_combined(Color)            # RGB Curves —— 连到 HSV
# RGB Curves.001 是孤立节点（未连到输出），仅记录备查

result = hue_saturation(hue=0.5, sat=1.0, value=1.85, fac=1.0, c1)  # 提亮 1.85x
```

**RGB Curves（实际生效的）** — 仅 Combined(C) 通道有控制点，R/G/B 独立通道为恒等：
```
C 曲线控制点（AUTO handle，经 mapping.evaluate() 采 21 点 LUT）：
(0,0), (0.4109,0.1657), (0.6688,0.314), (0.8847,0.8052), (1,1)
21 点 LUT: 0, 0.017663, 0.035504, 0.053784, 0.072819, 0.092906,
          0.114229, 0.136786, 0.160426, 0.183627, 0.204616, 0.226526,
          0.254368, 0.294495, 0.352857, 0.439046, 0.574615, 0.726822,
          0.834472, 0.921445, 1.0
```
这条曲线把中间值压低（0.5→0.23），再经 HSV value×1.85 提亮——压低+提亮的组合让暗部更暗、亮部更亮，对比度增强。

**RGB Curves.001（孤立，未生效）** — Combined 通道控制点：`(0,0), (0.4771,0.2326), (0.8437,0.7355), (1,1)`。

注：hue=0.5 在 Blender 里是恒等色相（`fract(h+0.5-0.5)=h`），sat=1.0 不变饱和度，所以实际只做 value=1.85 提亮 + C 曲线。

**WGSL 函数**：`fn color_correct(c: vec3f) -> vec3f`（C 曲线用上述 LUT 精确插值，HSV value×1.85，RGB Curves.001 忽略）。

### 3.9 夹角判断 (View Angle Test)
**输入**: 无（用 Attribute[FRONT] + Attribute[SUN]）
**输出**: Result (0-1)

**逻辑**（经 MCP 核对 `夹角判断`）：
```
front = Attribute[FRONT]
sun   = Attribute[SUN]
dot_val = dot(front, sun)                    # Vector Math DOT_PRODUCT
result = map_range(dot_val, 0, 1, 0, 1)      # Map Range (恒等, LINEAR)
```
⚠️ 注意：dot 的范围是 [-1,1]，但 Map Range 的 From 是 [0,1]，所以**负值（太阳在脑后）被 clamp 到 0**，正值原样输出。这给眼睛等部位提供一个"正前方照明强度"的门控信号。
用于眼睛等需要视角判断的部位（如 `眼睫` group 内部）。

**WGSL 函数**：`fn view_angle_test(faceFront: vec3f, sun: vec3f) -> f32`

### 3.10 鼻尖阴影 (Nose Shadow)
**输入**: Color
**输出**: Result

**逻辑**（经 MCP 核对 `鼻尖阴影.002`）：
```
# 法线偏移后做 facing，facing 高的区域（鼻梁）提亮
n = Geometry.Normal
n_mapped = n + (0, -0.4, 0)            # Mapping translation (Y -0.4)
facing = Layer Weight(n_mapped, blend=0.5).Facing
ramp1 = color_ramp(facing, [0.2042→黑, 0.2708→白], EASE)

# 蓝通道门控（限制在鼻阴影 tint 区）
blue = Separate(Color).Blue
ramp2 = color_ramp(blue, [0.0→黑, 0.0458→白], EASE)
inverted = 1.0 - ramp2

# Mix.001: mix(A=inverted, B=未连(默认), factor=ramp1)
# B 未连接 → 用 Mix 节点默认（通常 1.0 白）。factor=ramp1
# 即：鼻梁区(facing高→ramp1=1) 取 inverted；非鼻梁区(facing低→ramp1=0) 取 1.0
result = mix(inverted, 1.0, ramp1)
```
用于脸部鼻尖区域的额外阴影 tint（通过 base color 的蓝通道限制作用区域）。

⚠️ 原文档 `result = mix(inverted, ?, factor)` 的 `?` 经核对：Mix.001.B 未连接，按 Blender Mix 节点默认行为取 1.0（白色）。

**WGSL 函数**：`fn nose_shadow(color: vec3f, n: vec3f, v: vec3f) -> f32`

## 4. 顶层 Group 组合

⚠️ 经 MCP 核对，实际材质不止文档原先记录的 5 种 sr_* 预设。Blender 里风堇模型用到的顶层 shader group 有：

| 顶层 Group | 用途 | 输出类型 | 对应材质（举例） |
|---|---|---|---|
| `星铁@Minyu-Shader.face` / `.face.001` | 脸部 NPR | RGBA | 颜、颜+ |
| `星铁@Minyu-Shader.hair` / `.hair.001` | 头发 NPR | Shader (Emission+Transparent) | 髪、髪1、发圈 |
| `星铁@Minyu-Shader.clothes` / `.clothes.001` | 衣服 NPR | RGBA | 脖子、衣1、裙、蝴蝶结、口枷等 |
| `StarRailShader.身体变体_v17` | 身体皮肤 NPR | RGBA | 身体、手臂、指甲 |
| `StarRailShader.clothes-clean` | 简化衣服 | RGBA | 内衣、吊带、项圈 |
| `眼睫` / `.001` | 眼睛/眉毛/睫毛/舌头/牙齿 | RGBA | 目、白目、目光、眉睫、舌、齿、口 |
| `目影` / `.001` | 眼影区（镂空） | Shader (Transparent) | 目影 |
| `MMDShaderDev` / `.001` | MMD 标准材质 | Shader | bell、大部分配饰的 `actual_*` 版本 |

**脸部 (`星铁@Minyu-Shader.face`, 19 节点) 组合**：
```
校色_out = 校色(input_color)                              # RGB Curves + HSV×1.85
sdf_val  = SDF()                                          # 脸部 SDF 自阴影(用 FRONT/RIGHT/SUN)
mapped   = map_range(sdf_val, 0,1, 0,1)                   # 恒等
ramp_col = ramp(mapped, alpha=0)                          # Warm Ramp 采样 + RGB Curves
nose     = 鼻尖阴影(SDF.tex.Color)                         # 法线偏移+蓝通道门控
Mix      = 校色_out × ramp_col                            # MULTIPLY
Mix.001  = Mix × nose                                     # MULTIPLY
Result   = Mix.001                                         # 直接输出 RGBA(=Emission)
```

**头发 (`星铁@Minyu-Shader.hair`) 组合**：
```
校色_out = 校色(input_color)
ilm      = ilm.hair()                                     # ILM Non-Color 贴图
sun_val  = 虚拟日光(Image=ilm.Green重塑)                    # 半兰伯特 + 平方
ramp_col = ramp.hair(map_range(sun_val,0,1,0,1), Y=0.5)   # Warm Ramp + B曲线
matcap链 = matcap.hair → div(0.05) → ×ilm.Blue → gate(sun>0.85) → 恒等MapRange
Mix.A    = 校色_out
Mix.B    = ramp_col
Mix      = A × B
Mix.001  = Mix × matcap强度                                 # emissionIntensity
Emission.Color = Mix.001
alpha    = hairmask(hairmask贴图 × 0.01)                   # Mix Shader factor
Shader   = mix(Transparent, Emission, alpha)
```

**眼睛 (`眼睫`) 组合**（文档原先未记录）：
```
照度     = 夹角判断(dot(FRONT,SUN))                        # 正面照度 0-1
压暗色   = HSV(value=0.65)(input_color)                    # 压暗到 65%
Mix      = mix(原色, 压暗色, 照度)                          # 太阳越正面越压暗
校色_out = 校色(Mix)                                        # RGB Curves + HSV×1.85
Result   = 校色_out
```

**身体 (`StarRailShader.身体变体_v17`) 组合**：与脸部相同结构（校色 × ramp × 鼻尖阴影），但虚拟日光用 ILM green 门控。

每个 sr_* 材质的 WGSL 按对应 group 的组合顺序实现。

## 5. 贴图清单

风堇模型 `textures/` 目录共 86 个贴图文件，按用途分三大类。下表覆盖**全部**文件（经 MCP 逐个核对用途）。

### 5.1 StarRail 材质贴图槽（sr_face/hair/body/clothes）

| 槽位 | 用途 | face | hair | body | clothes | 眼睫 | colorspace |
|------|------|------|------|------|---------|------|-----------|
| color | 基础颜色贴图 | ✅ | ✅ | ✅ | ✅ | ✅ | sRGB |
| ilm | ILM LightMap（AO/高光/阴影/mask） | ✅ | ✅ | ✅ | ✅ | - | Non-Color |
| warm_ramp | Toon 暖色阶 LUT | ✅(Body) | ✅(Hair) | ✅(Body) | ✅(Body) | - | sRGB |
| cool_ramp | Toon 冷色阶 LUT（可选，实际未用） | ✅(未用) | ✅(未用) | ✅(未用) | ✅(未用) | - | sRGB |
| sdf | SDF 脸部 FaceMap | ✅ | - | ✅(鼻尖阴影用) | - | - | sRGB |
| matcap_metal | 材质捕捉（MetalMap） | - | - | - | ✅ | - | Non-Color |
| matcap_hair | 材质捕捉（hair_s） | - | ✅ | - | - | - | sRGB |
| hairmask | 头发透明 mask | - | ✅ | - | - | - | - |

⚠️ 关键事实（经 MCP 核对）：
- ramp 实际采样 **Warm** Ramp（Cool Ramp 被采样但未连输出）。
- matcap 有两种贴图：MetalMap（Non-Color）用于衣服/身体，hair_s（sRGB）用于头发，colorspace 不同。
- 眼睫 group **只用 color 贴图**，不需要 ILM/ramp/sdf/matcap。

### 5.2 MMD 材质贴图槽（MMDShaderDev，用于配饰/小件）

模型大部分配饰（bell、头饰、帽金属、内衣、白裤袜等 ~50 个材质）用的是 MMD 标准材质 `MMDShaderDev`，而非 StarRail。MMD shader 有三个贴图槽：

| 槽位 | 用途 | 实际文件 | colorspace | 引用材质数 |
|------|------|---------|-----------|-----------|
| base_tex | 基础颜色 | 各材质自己的 color（如 衣.png、配件.png、Body3.png） | sRGB | - |
| toon_tex | 卡通渐变（1D Lambert） | toon4.png(最常用)、toon3.png、toon2.png、toon_b.bmp | sRGB | toon4≈39 / toon3≈9 / toon2≈1 / toon_b≈1 |
| sphere_tex | 球面高光（sph） | 2.bmp(最常用)、SP0d_20190820_005614.bmp、9.JPG、1.png、mc1.png、mc3.png | Linear Rec.709 | 2.bmp≈18 / SP0d≈8 / mc3≈5 等 |

> 这些 toon/sphere 贴图是 MMD 原版模型自带的，StarRail 移植时配饰保留了 MMD shader。

### 5.3 特殊/辅助贴图

| 文件 | 用途 | colorspace | 说明 |
|------|------|-----------|------|
| `Avatar_Hyacine_00_Body_Color_A_L.png` | 身体亮区颜色（StarRail body 用） | sRGB | 区别于 Body3.png |
| `Body3.png` | 身体/特殊部位 color（乳首结等 MMD 材质的 base_tex） | sRGB | 8192×8192，非 StarRail body 的主色 |
| `颜赤.tga` / `颜赤.png` | 腮红贴图（`颜+` 材质的 BlushTex/base） | sRGB | 脸部红晕叠加 |
| `neutral_lightmap.png` | 中性 ILM 占位（全中性值，给无 LightMap 的材质用） | sRGB | 4×4 小图 |
| `LightMap.png` | Body LightMap 的别名副本（与 Avatar_Hyacine_00_Body_LightMap_L 内容相同，MD5 一致） | Non-Color | StarRail ilm 的回退源 |
| `LightMap` 系 `_2`/`_3` 后缀 | 同一贴图的不同副本（导出器为不同 manifest 条目生成，内容一致） | 同上 | 如 Body_Warm_Ramp / _2 / _3 |
| `W_*/M_*_FaceMap_00.png`（8 类×3 版本） | SDF 脸部 FaceMap 候选库 | sRGB | 按角色类型选一张，本模型用 `W_140_Girl_FaceMap_00`；其余是其他角色的 FaceMap，备用 |
| `hair_s.bmp.001.bmp` | 头发 matcap（hair_s）的实际文件名 | sRGB | manifest 的 matcap 槽指向它 |

### 5.4 shader group 内部固定贴图（不在 manifest，已从 Blender packed 导出）

以下贴图被 StarRail shader group **内部硬编码引用**（不通过 manifest 的 texture 槽传入，而是 group 节点树里直接挂的 Image Texture）。它们不在 PMX 贴图表，但渲染时 group 会用到。已用 Blender `save_render()` 从 packed image 导出到 `textures/`：

| 文件 | 引用的 group | 用途 | colorspace | 尺寸 |
|------|------------|------|-----------|------|
| `Avatar_Hyacine_00_Body_Color_mask.png` | `星铁@Minyu-Shader.clothes(.001)` | 衣服 body color mask（控制哪里显示身体色） | sRGB | 1024×512 |
| `Avatar_Hyacine_00_Body_Color_Stockings.png` | `星铁@Minyu-Shader.clothes(.001)` | 衣服 stockings mask（丝袜区域） | sRGB | 1024×512 |
| `Avatar_Sparkle_00_Body_Cool_Ramp.png` | `ramp.clothes2(.001)` / `ramp2.001` | 另一角色(Sparkle/花火)的 ramp，混入衣服 shader（疑似误留） | sRGB | 256×16 |
| `Avatar_Sparkle_00_Body_Warm_Ramp.png` | 同上 | 同上 | sRGB | 256×16 |
| `Avatar_Sparkle_00_Body_LightMap_L.png` | `ilm.clothes2.001` | Sparkle 角色的 ILM（疑似误留） | Non-Color | 4096×2048 |
| `hairmask.png` | `星铁@Minyu-Shader.hair(.001)` | 头发透明 mask（控制头发 alpha） | sRGB | 1024×1024 |

> 移植注意：clothes group 的 mask/stockings 贴图控制身体色与衣服色的混合；hairmask 控制头发透明（头发边缘的发丝镂空）。这些是 StarRail NPR 还原度的关键之一。

### 5.5 丝袜 shader 贴图（SockAIO/SockV3，已从 Blender packed 导出）

丝袜材质用专用 shader group `SockAIO.021` / `SockV3.027` / `PantyhoseThicknessSelector.023`，内部固定引用以下贴图（已导出到 `textures/`）：

| 文件 | group | 用途 | colorspace | 尺寸 |
|------|-------|------|-----------|------|
| `SDFLut.png` | SockAIO/SockV3 | 丝袜 SDF LUT | Linear Rec.709 | 512×64 |
| `sock_tiled_direction.png` | SockAIO/SockV3 | 丝袜纤维方向 | Non-Color | 1024×1024 |
| `sock_tiled_normal.png` | SockAIO/SockV3 | 丝袜法线 | Non-Color | 1024×1024 |
| `sock_tiled_sdf.png` | SockAIO/SockV3 | 丝袜 SDF | Non-Color | 1024×1024 |
| `Substance_graph_FurLayer.png` | SockAIO/SockV3 | 丝袜纤维层 | sRGB | 2048×2048 |
| `cf_panst_00_t.png` 等（00/02/04/07/08/09） | PantyhoseThicknessSelector/SockAIO | 连裤袜厚度选区（不同部位） | sRGB | 1024×2048 (08 为 512×1024) |

### 5.6 未被任何材质引用的残留贴图（Blender 工程未用，PMX 引用）

以下贴图被 PMX 贴图表引用（模型文件指向它们），但在当前 Blender 工程里**没有任何材质节点使用**，属于原作者模型的历史残留/备用：

| 文件 | 备注 |
|------|------|
| `gold.png`、`nuruteka.jpg`、`金属.png` | sph 类，Blender 未导入对应 image datablock |
| `[TOON]Gray.png` | toon 类，未导入 |
| `颜赤.png` | 与 `颜赤.tga` 同名不同格式，未用（用的是 .tga 版） |
| `W_160_Maid_FaceMap_01*.png` | 女仆角色的另一张 FaceMap，本模型非女仆，未用 |

> 这些贴图已复制到 `textures/` 以消除 PMX 加载时的 404，但渲染上不影响（因为材质没引用）。

### 5.7 edge（描边）贴图

StarRail NPR 原版有 `faceedge`/`hairedge` 描边贴图（Blender 里有 image datablock，1024×1024，packed），但风堇模型的描边实际用 hull outline（法线挤出），未使用这些 edge 贴图，因此 `textures/` 里没有它们。

## 6. 移植优先级与难点

1. **简单**（直接采样 + 数学）：ilm, smoothstep, 校色, 夹角判断
2. **中等**（需贴图坐标变换）：matcap, ramp, 虚拟日光, 布林冯
3. **困难**（需条件分支 + 多贴图）：SDF 脸部阴影, 鼻尖阴影

SDF 是还原度的关键——它决定了脸部阴影的"星穹铁道感"。如果 SDF 做对，脸部就有 80% 还原度。
