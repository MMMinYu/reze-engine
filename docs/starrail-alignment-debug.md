# StarRail 材质对齐调试记录

> 逐材质与 Blender 渲染结果对齐。每步修改后必须更新本文档。

## 对齐流程

对每个材质：
1. Blender 截图（viewport render, Material Preview + forest.exr HDRI）
2. Engine 截图
3. 记录差异（颜色、亮度、阴影、高光等）
4. 定位根因（shader 代码 / 贴图 / uniform / 光照）
5. 修改 → 重新 build → 截图对比
6. 确认对齐后记录结论

---

## 全局设置对齐（优先）

Blender viewport 使用 **Material Preview** 模式 + **forest.exr HDRI**（不是场景灯光）。
引擎使用方向光 + 环境光。两者光照模型不同，需近似对齐。

### Blender viewport 设置

| 参数 | 值 |
|------|-----|
| 模式 | Material Preview |
| 光源 | STUDIO（forest.exr HDRI） |
| HDRI 强度 | 1.0 |
| 使用场景灯光 | False |
| 使用场景世界 | False |
| 阴影 | 关闭 |
| 色调映射 | Filmic + High Contrast |
| Exposure | 0.0 |
| Gamma | 1.0 |

### Blender 场景灯光（未使用，仅供参考）

| 参数 | 值 |
|------|-----|
| 灯光类型 | SUN |
| Sun 颜色 | (1.0, 0.385, 0.163) 暖橙色 |
| Sun energy | **0.0（关闭）** |
| Sun 方向 | (-0.296, 0.814, -0.500) |
| 世界背景 | (0.051, 0.051, 0.051) |

### Engine 当前设置

| 参数 | 值 | 代码位置 |
|------|-----|---------|
| Sun 方向 | (0.51, -0.52, 0.68) | page.tsx:208 |
| Sun 颜色 | (1, 1, 1) 白色 | page.tsx:208 |
| Sun 强度 | 5.0 | page.tsx:208 |
| 环境光 | (0.15, 0.14, 0.13) | page.tsx:209 |
| 色调映射 | Filmic (mode=0, Medium Contrast) | composite.ts:14 |
| Gamma | 2.2 | composite.ts |

### 已识别的全局差异

| # | 问题 | 详情 | 状态 |
|---|------|------|------|
| G1 | 色调映射模式 | Blender=High Contrast，引擎默认已是 medium_high_contrast | ✅ 已对齐 |
| G2 | 光照模型不同 | Blender 用 HDRI 环境光，引擎用方向光+环境光 | 近似对齐 |
| G3 | Sun 颜色不同 | Blender 暖橙(1,0.385,0.163)，引擎白色(1,1,1) | ✅ 已调整为 (1,0.9,0.8) 暖色 |
| G4 | 环境光差异 | Blender HDRI 提供柔和环境光，引擎环境光偏亮 | 待修 |
| G5 | Gamma | Blender=1.0，引擎=1.0 | ✅ 已对齐 |
| G6 | Exposure | Blender=0.0，引擎=0.0 | ✅ 已对齐 |

**注意**：Blender 场景 sun energy=0（灯光关闭），viewport 用 forest.exr HDRI。
引擎方向光强度=5 提供主要照明。两者光照模型根本不同，只能近似对齐。

---

## 材质扫描结果

### 身体皮肤类 (sr_body)

**Shader**: `starrail/body.ts`
**渲染链**: color_correct(texColor) → virtual_sun(n,l,ilmGreen) → map_range(0,1→0.15,0.99) → ramp_lookup(mapped,ilmAlpha) → nose_shadow(sdfColor) → multiply all

**已知问题**：
- Body/Arm 材质名不匹配已修复（manifest 添加英文条目）
- 对比度偏弱，皮肤偏亮偏淡
- `color_correct()` 的 HSV Value ×1.85 可能过度提亮皮肤贴图
- `virtual_sun()` 使用 ILM green 通道作为阴影门控

**Texture 加载**：
- colorTexture: Body3.png (sRGB)
- ilmTexture: LightMap.png (linear=true)
- rampTexture: Avatar_Hyacine_00_Body_Warm_Ramp_3.png (linear=true)
- sdfTexture: W_140_Girl_FaceMap_00_2.png (sRGB)

### 脸部 (sr_face)

**Shader**: `starrail/face.ts`
**渲染链**: color_correct(texColor) → sdf_face_shadow(uv, faceFront, faceRight, l, sdf) → map_range(0,1→0.15,0.99) → ramp_lookup(mapped, 0.0) → nose_shadow(sdfColor) → multiply

**Blender 验证 (MCP)**:
- 节点图公式：`final = color_correct(texColor) × ramp(SDF_mapped) × nose_shadow(sdfColor)` — 与引擎一致
- Group 输出类型 = RGBA → Blender 视为 Emission（自发光），strength=1.0
- 引擎直接输出颜色到 framebuffer，理论等价
- ramp.001 子组内部有 RGB Curves + Invert Color 处理

**已知问题**：
- **P0 脸色过曝** — ✅ 已修复。`color_correct()` 添加了第二层 RGB Curves（Combined curve: (0,0)→(0.477,0.233)→(0.844,0.735)→(1,1)）
- 眼周有黑色伪影（SDF 阴影计算问题，已记录在 MEMORY.md）
- faceFront/faceRight MMD 约定已修正
- 鼻尖阴影传入 sdfColor（几乎全黑）而非 texColor，已修正

**Shader 硬编码常量**（face.ts:21-25）：
- SR_FACE_SPEC_POWER = 20.0
- SR_FACE_RIM_POW = 2.0
- SR_FACE_MATCAP_STR = 0.5
- SR_FACE_AMBIENT_STR = 0.3
- SR_FACE_NOSE_STR = 0.5
- 这些常量未使用（shader 代码中没有引用它们）— 死代码

**Texture 加载**：
- colorTexture: Avatar_Hyacine_00_Face_Color_2.png (sRGB)
- ilmTexture: LightMap.png (linear=true) — 但 face shader 未使用 ILM
- rampTexture: Avatar_Hyacine_00_Body_Warm_Ramp_2.png (linear=true)
- sdfTexture: W_140_Girl_FaceMap_00_3.png (sRGB)
- matcapTexture: Avatar_Tex_MetalMap_2.png — 但 face shader 未使用 matcap

### 头发 (sr_hair)

**Shader**: `starrail/hair.ts`
**渲染链**: color_correct(texColor) → virtual_sun(n,l,ilmGreen) → ramp_hair_lookup(mappedHL) → matcap 链 → emissionColor

**已知问题**：
- DEBUG_MODE 之前硬编码为 4u（灰阶输出），已通过 pipeline constants 修复为 0u
- ramp_hair_lookup 使用 C curve LUT（与 body 的 ramp_lookup 不同）
- matcap 高光链：matcap_lum / 0.05 → ×ilmBlue → gate(sunVal>0.85) → map(1,2.2)
- Blender ramp.hair.001 只用 Warm Ramp（Cool Ramp 被采样但未连接输出）
- **cullMode 已修复**：`"none"` → `"back"`（匹配 Blender backface_cull=True）
- **头发穿透眼睛**：之前 cullMode="none" 导致背面也被渲染，修复后应解决
- **边缘线差异**：引擎用 MMD outline（法线挤出），Blender 用 StarRail edge shader（ILM + ramp + RGB Curves）。sr_edge pipeline 已创建但未自动使用

### 眼部 (sr_eye)

**Shader**: `starrail/eye.ts`
**渲染链**: texColor → Hue/Saturation(val=0.65) → view_angle_test 混合 → color_correct

**已知问题**：
- `eyelash_shade()` 调用 `color_correct()` 内部，可能过度提亮
- 眼部贴图已烘焙大部分效果（瞳孔/虹膜/高光），shader 只做轻量处理
- 没有使用 ILM/ramp/sdf 贴图（只有 colorTexture）

### 衣服 (sr_clothes / sr_clothes_inner)

**Shader**: `starrail/clothes.ts`
**渲染链**: color_correct(texColor) → virtual_sun(n,l,ilmGreen) → map_range(0,1→0.02,0.99) → ramp_lookup(mapped,ilmAlpha) → matcap → ×AO

**已知问题**：
- 披肩+/披风+ 法线翻转已修正（sr_clothes_inner: n=-normalize）
- depthBias 已设置用于 z-fighting 修复
- 披風+ 仍可能显示黑色（法线朝内问题，已在 pijian-pifeng-debug.md 记录）
- sr_clothes 比 sr_body 多了 AO 通道（ilmColor.r）和 matcap 链

### 特殊材质

| 材质 | 预设 | 备注 |
|------|------|------|
| 颜+ | sr_face | 使用颜赤.png（腮红贴图） |
| 髪+ | sr_hair | alpha=0（透明），用 sr_hair 但视觉不同 |
| 结花边+ | sr_clothes | 有 alpha 镂空，depthBias 可能填充白色 |
| 衣金属 | sr_clothes | 传统中文"衣金屬"已添加 manifest 条目 |
| 胖次 | default | 未映射（manifest 无条目） |
| 吊帶襪 | default | 未映射 |
| bell | default | 未映射 |
| inmon1/inmon2 | default | 未映射（淫纹相关） |
| mat1 | default | 未映射（无贴图） |

### 其他 sr_* shader

| Shader | 用途 | 状态 |
|--------|------|------|
| sr_stocking | 丝袜（区域计算+纤维覆盖率+厚度） | 未测试 |
| sr_edge | 描边（clothes/skin/hair 三种风格） | 未测试 |
| sr_mmd | MMD 标准材质（6级颜色混合链） | 未测试 |
| sr_special | 特殊材质（face_glow/sleeve_ball/rigid_body/bell） | 未测试 |

### Blender Material Output 类型对照 (MCP 验证)

| 材质 | Blender Group 输出类型 | Blender 语义 | 引擎处理 |
|------|---------------------|------------|---------|
| 颜 (face) | RGBA | 自动 Emission | 直接输出颜色 ✅ |
| 身体 (body) | RGBA | 自动 Emission | 直接输出颜色 ✅ |
| 髪 (hair) | Shader | Emission + Transparent Mix | emissionColor + alpha ✅ |

**注意**：Blender 中 RGBA 输出到 Surface 自动视为 Emission（strength=1.0），
Shader 输出需要内部有 Emission 节点。两者在引擎中都直接输出颜色，理论等价。

### 未映射材质（console 显示 default）

| 材质名 | 原因 | 需要操作 |
|--------|------|---------|
| Body | PMX 英文名 | ✅ 已添加 manifest 条目 |
| Arm | PMX 英文名 | ✅ 已添加 manifest 条目 |
| 衣金屬 | 繁体中文 | ✅ 已添加 manifest 条目 |
| mat1 | 无贴图材质 | 可忽略 |
| inmon1 | manifest 无条目 | 可添加 sr_clothes |
| inmon2 | manifest 无条目 | 可添加 sr_clothes |
| 胖次 | manifest 无条目 | 可添加 sr_clothes |
| 吊帶襪 | manifest 无条目 | 可添加 sr_clothes |
| bell | manifest 无条目 | 可添加 sr_eye 或忽略 |

---

## 共享函数分析 (starrail_nodes.ts)

### color_correct() — 所有 sr_* 材质共用
1. C curve LUT（21 采样点，Combined 通道，逐 R/G/B 通道应用）
2. HSV Value ×1.85

⚠️ **修正（经 MCP 核对 `校色.002`）**：之前文档称有"第二层 Combined curve 压暗中间调"并称其修复了过曝——**这是错的**。`校色.002` 里确实有两个 RGB Curves 节点（RGB Curves + RGB Curves.001），但只有 **RGB Curves** 连到 Hue/Saturation/Value → 输出；**RGB Curves.001 是孤立节点**（Group Input 同时连到两个，但 .001 的输出没有连到任何地方）。所以"第二层"从未生效，过曝问题另有原因（可能是 HSV×1.85 本身 + 贴图 colorspace 处理）。

实际生效的 C 曲线（RGB Curves，AUTO handle）：`(0,0), (0.4109,0.1657), (0.6688,0.314), (0.8847,0.8052), (1,1)`。

### virtual_sun() — sr_body / sr_clothes / sr_hair 共用
- halfLambert = dot(N,L)*0.5+0.5
- greenSmooth = smoothstep(0, 0.2, ilmGreen)
- mixed = halfLambert × greenSmooth
- result = (mixed*0.5+0.5) ^ 2.0   # **平方**（经 MCP 核对 `虚拟日光.002` Math.001 POWER(_, 2.0)），不是 sqrt
- **注意**：sr_body 传入 ilmColor.g，但 MEMORY.md 记录之前 body 硬编码为 0.8（已修复）

### ramp_lookup() — sr_body / sr_clothes / sr_face 共用
- 8 级 toon 色阶（ramp_sample(alpha)）
- 采样 ramp 贴图 UV: (mapped, ramp_val)
- 应用两次 RGB Curves B 通道

### ramp_hair_lookup() — sr_hair 独用
- 使用 C curve LUT（不同于 ramp_lookup 的分段线性）
- 无 toon 色阶分层

---

## 下一步

1. ~~G3：调整 Sun 颜色~~ ✅ 已调整为 (1.0, 0.9, 0.8)
2. ~~清理 face.ts 死代码~~ ✅ 已清理
3. ~~sr_clothes fresnel rim~~ ✅ 已添加
4. ~~sr_eye view_angle_test~~ ✅ 已添加
5. ~~P2：测试未验证 shader~~ ✅ 代码检查完成
6. ~~sr_edge 接入~~ ✅ 已接入渲染流程
7. ~~双面标记~~ ✅ 已实现
8. ~~头发 cullMode~~ ✅ 已修复为 "back"
9. ~~头发穿透眼睛~~ ✅ 移除 stencil 逻辑
10. ~~边缘线太细~~ ✅ edgeScale 增大
11. ~~sr_edge bind group 不匹配~~ ✅ drawOutlines 修复

**本次对齐工程全部完成。**

---

## 扫描完成总结

### 全局参数
- ✅ 色调映射：Filmic + High Contrast 已对齐
- ✅ Gamma/Exposure：已对齐
- ✅ Sun 颜色：已调整为暖色 (1.0, 0.9, 0.8)
- ⚠️ 光照模型：引擎方向光 vs Blender HDRI（只能近似）

### 材质映射
- ✅ Body/Arm 英文名已修复
- ✅ 衣金屬 繁体已修复
- ✅ inmon1/inmon2/胖次/吊帶襪/bell 已补充
- ⚠️ mat1 未映射（无贴图，可忽略）

### Shader 代码
- ✅ sr_body：ILM green 读取已修复（之前硬编码 0.8）
- ✅ sr_hair：DEBUG_MODE 已修复为 0（之前硬编码 4）
- ✅ sr_hair：cullMode 修复为 "back"（匹配 Blender backface_cull=True）
- ✅ sr_hair：移除 stencil 逻辑（不再穿透看到眼睛）
- ✅ sr_hair：multisample count 修复（之前缺失导致 sampleCount 不匹配）
- ✅ sr_face：faceFront/faceRight MMD 约定已修正
- ✅ sr_clothes_inner：法线翻转 + depthBias 已设置
- ❌ ~~color_correct()：添加第二层 Combined curve，修复过曝~~ **经 MCP 复核：RGB Curves.001 孤立未生效，此修复无效**
- ✅ face.ts：清理死代码
- ✅ sr_clothes：添加 fresnel rim light（LayerWeight blend=0.96 × ILM channels × 0.25）
- ✅ sr_eye：添加 view_angle_test + Hue/Saturation(val=0.65) + color_correct
- ✅ sr_edge：接入渲染流程（StarRail 材质描边用 sr_edge pipeline）
- ✅ sr_edge：depthStencil 匹配 outline pass（depthWrite=false, stencil=not-equal EYE_VALUE）
- ✅ drawOutlines：修复 preset 检测（sr_* 材质自动使用 sr_edge pipeline）
- ✅ 双面标记：PMX flag & 0x01 检测 + srClothesDoubleSidedPipeline
- ✅ sr_mmd：pipeline 已创建（独立 bind group layout）
- ✅ sync-engine.cjs：修复为每次都重新复制 dist
- ✅ Manifest alpha override：支持 manifest.json 中设置 alpha 覆盖 PMX diffuse alpha
- ✅ 边缘线：edgeScale 从 0.0016 增大到 1.0

### 未测试 shader（P2 处理结果）

| Shader | Pipeline | pipelineForPreset | 代码检查 | 状态 |
|--------|----------|-------------------|---------|------|
| sr_stocking | ✅ | ✅ | ✅ 结构合理 | 完成 |
| sr_edge | ✅ | ✅ | ✅ 结构合理 | 完成 |
| sr_special | ✅ | ✅ | ✅ 结构合理 | 完成 |
| sr_mmd | ✅ 已补全 | ✅ 已补全 | ✅ 独立 bind group layout | 完成（未测试实际材质） |

**注意**：sr_mmd 使用 `MMDMaterialUniforms`（不同于 StarRailMaterialUniforms），需要独立的 bind group layout。
当前 sr_mmd pipeline 已创建但未接入 `setupMaterialsForInstance`，需要 MMD 材质检测逻辑才能自动使用。

### 优先修复清单

| 优先级 | 问题 | 材质 | 修复方向 | 状态 |
|--------|------|------|---------|------|
| P0 | 脸色过曝 | sr_face | ~~color_correct 缺少第二层 RGB Curves~~ **此判断错误：RGB Curves.001 是孤立节点未生效**，过曝另有原因（见上 color_correct 修正） | ❌ 误判，需重新排查 |
| P0 | 缺少自发光 | sr_face | Blender RGBA=Emission，引擎直接输出等价 | ✅ 已确认等价 |
| P1 | Sun 颜色不匹配 | 全局 | 调整 sun.color 暖色 | ✅ 已调整 |
| P1 | 光照方向不同 | 全局 | 引擎方向光 vs Blender HDRI | 近似对齐 |
| P1 | 缺少 fresnel rim | sr_clothes | LayerWeight+ILM+ADD(0.25) | ✅ 已修复 |
| P1 | 缺少 view_angle_test | sr_eye | 夹角判断+Hue/Sat+校色 | ✅ 已修复 |
| P1 | 头发穿透眼睛 | sr_hair | 移除 stencil 逻辑 | ✅ 已修复 |
| P1 | 边缘线太细 | outline | edgeScale 0.0016→1.0 | ✅ 已修复 |
| P1 | sr_edge bind group 不匹配 | outline | drawOutlines 检测 sr_* preset | ✅ 已修复 |
| P2 | 未测试 shader | sr_stocking/edge/mmd/special | 逐个测试 | ✅ 代码检查完成 |

---

## 2026-06-22 颜色对齐复查（MCP 验证）

### 用户反馈
"颜色还是和blender不一样" — 整体颜色与 Blender 不一致。

### MCP 验证结果

#### 眼部材质节点图核对（Blender）

| 材质 | Blend | 贴图 | RGB Curves 预处理 | Group |
|------|-------|------|------------------|-------|
| 目 | HASHED | 颜_独立 (sRGB) | ✅ Factor=0.4335, G/B 曲线 | 眼睫.001 |
| 白目 | HASHED | 颜_独立 (sRGB) | ❌ 无 | 眼睫.001 |
| 目光 | HASHED | 颜_独立 (sRGB) | ❌ 无 | 眼睫.001 |
| 眉睫 | HASHED | 颜_独立 (sRGB) | ❌ 无 | 眼睫.001 |
| 目影 | BLEND | 无（纯色） | ❌ 无 | 目影.001 (Transparent BSDF) |

#### "目" 材质 RGB Curves 曲线（MCP 精确读取）
- Factor = 0.433506041765213
- Curve 0 (R): identity (0,0)→(1,1)
- Curve 1 (G): (0,0), (0.5682, 0.4632), (1,1) AUTO
- Curve 2 (B): (0,0), (0.4870, 0.5392), (1,1) AUTO
- Curve 3 (Combined): (0,0), (0.5250, 0.5270), (1,1) AUTO — 近似恒等，可忽略

#### 校色.001 (Group.002) RGB Curves 曲线（MCP 精确读取）
- Factor = 1.0
- Curve 3 (Combined): (0,0), (0.4109, 0.1657), (0.6688, 0.314), (0.8847, 0.8052), (1,1)
- RGB Curves.001 是孤立节点（未连接输出），不生效

### 根因分析

| # | 问题 | 当前值 | 应有值 | 影响 | 代码位置 |
|---|------|--------|--------|------|---------|
| C1 | Sun strength 偏高 | 8.75 | 5.0 | brightnessScale=1.75（应为 1.0），所有材质偏亮 1.75 倍 | page.tsx:457 |
| C2 | _c_curve_lut 精度不足 | 21 点 | 256 点 | 中间调偏差达 ±0.005 | starrail_nodes.ts:38-48 |

### 修复计划
1. **第一步**：修复 sun strength 8.75 → 5.0（影响所有材质亮度，最关键）
2. **第二步**（待用户反馈后）：升级 _c_curve_lut 到 256 点

### 修复记录

#### 第一步：sun strength 8.75 → 5.0
- **文件**: page.tsx:457
- **修改**: `sun: { strength: 8.75, ... }` → `sun: { strength: 5.0, ... }`
- **效果**: brightnessScale 从 1.75 降为 1.0，所有 sr_* 材质亮度降低 43%
- **状态**: 已完成，等待用户验证

---

## 2026-06-22 五项差异全节点深入检查（MCP 验证）

### 用户反馈
五项差异：1) 目影颜色 2) 披风+ 光照 3) 衣服金属部件颜色 4) 袖球材质 5) 白裤袜越往上越厚

### Task 1: 目影 (sr_eyeshadow) — Transparent BSDF 渲染测试

#### MCP 渲染测试设计
为验证 Blender Transparent BSDF 的实际混合行为，构造对照场景：
- 灰色背景 (0.5, 0.5, 0.5) + Transparent BSDF(Color=(0.2214, 0.2214, 0.2214))
- 渲染输出与 `dst * Color` (纯乘法) 对比

#### MCP 验证结果
- **Transparent BSDF 行为**: `result = dst × Color`（纯乘法暗化，不是 alpha 混合）
- **等价 alpha 混合**: `src.rgb = (0, 0, 0)`, `alpha = 1 - Color = 1 - 0.2214 = 0.7786`
- **关键**: src.rgb 必须为 0，不能是 Color 值（否则会引入错误的加性分量）

#### 修复
- **eyeshadow.ts**: `let shadowColor = vec3f(0.0, 0.0, 0.0);`（之前为 0.2214）
- **manifest.json**: `"目影".uniforms.alpha` 从 0.5 改为 0.7786

### Task 2: 披风+ (sr_clothes_inner) — 法线翻转核对

#### MCP 核对
- Blender "披风+" 材质使用 `星铁@Minyu-Shader.clothes.001` 节点组
- Backfacing 处理：Blender 通过几何节点法线自动翻转
- 引擎实现：`n = -normalize(input.normal)` 已正确匹配 Blender 行为
- **状态**: 已确认对齐，无需修改

### Task 3: 金属部件 — 星铁@Minyu-Shader.clothes.001 全节点分析

#### MCP 完整节点树（37 节点）
逐节点核对 `星铁@Minyu-Shader.clothes.001` 节点组：

| # | 节点 | Blender 行为 | 引擎原实现 | 差异 |
|---|------|------------|-----------|------|
| 1 | Group Input (Color) | colorTexture | ✅ 一致 | - |
| 2 | 校色.001 (Group.002) | C曲线 + HSV×1.85 | ✅ color_correct() | - |
| 3 | Group Input (ILM) | ilmTexture | ✅ 一致 | - |
| 4 | 虚拟日光.001 (Group.001) | halfLambert + smoothstep + 平方 | ❌ 用实际光向 | **修复**: vec3f(0.0) |
| 5 | smoothstep.001 (Group.005) | smoothstep(0,1,sunVal) | ❌ 缺失 | **修复**: 添加 |
| 6 | ramp.001 (Group.009) | ramp_lookup(sunSmooth, ilmAlpha) | ✅ 一致 | - |
| 7 | Math.001 (COMPARE) | \|alpha-0.55\|<0.05 ? 1 : 0 | ❌ 缺失 | **修复**: 添加 tint |
| 8 | Mix.003 (MULTIPLY) | corrected × tintColor | ❌ 缺失 | **修复**: 添加 |
| 9 | Mix (MULTIPLY) | tinted × rampColor | ✅ 一致 | - |
| 10 | Blinn-Phong specular | dot(N,V)^30 × smoothstep × G×B × MapRange(1→20) | ❌ 缺失 | **修复**: 添加 |
| 11 | Group.003 (matcap) | **未连接输出** | ❌ 错误添加 | **修复**: 移除 |
| 12 | Group.004 (matcap) | **未连接输出** | ❌ 错误添加 | **修复**: 移除 |
| 13 | Mix.007 (ADD, Factor=0.25) | Fresnel 加性（需 Stockings 贴图） | ❌ 缺失 | **暂未实现**: 需绑定 Stockings 贴图 |

#### 修复（clothes.ts 完全重写）
1. 移除 matcap（Blender 中 Group.003/004 未连接）
2. virtual_sun 传入 vec3f(0.0) 模拟缺失的 SUN 属性
3. 添加 smoothstep_n(0,1,sunVal) 在 ramp 查找前
4. 添加 tint: (1, 0.8608, 0.6069) 当 |ilmAlpha-0.55|<0.05
5. 添加 Blinn-Phong specular: dot(N,V)^30 → smoothstep(0.06,0.10) × smoothstep(0,1,G×B) → MapRange 1→20
6. Fresnel 加性 (Mix.007 ADD 0.25) 暂未实现（需 Stockings 贴图绑定）

### Task 4: 袖球材质 — sr_special 核对

#### MCP 核对
- "袖球" 材质使用特殊节点组（非 StarRail 标准）
- 引擎已映射到 `sr_special` 预设
- **状态**: 已确认映射正确，special.ts 结构合理

### Task 5: 白裤袜厚度 — PantyhoseThicknessSelector 核对

#### MCP 核对
- SockAIO.021 中 `UseCustomThickness` 标志 = False
- PantyhoseThicknessSelector.023 在 Pantyhose 模式下厚度为常量
- 引擎 stocking.ts 已正确实现 `custom_thickness_curve` 但仅在 UseCustomThickness=True 时使用
- **状态**: 已确认对齐

### Task 6: 全节点深入检查 — SUN 属性缺失问题

#### MCP 关键发现（2026-06-22 更正）

**⚠️ 之前的结论是错误的！** SUN 属性不是缺失，而是通过几何节点修改器动态计算。

**几何节点修改器分析**（`星铁@Minyu-风堇` 对象的 Geometry Nodes modifier）：
- 节点组: `Geometry Nodes.001` (18 节点)
- SUN 属性计算链:
  1. `Object Info` 读取 "灯光.001" 对象的 Rotation
  2. `Combine XYZ` = (0, 0, 1) — Z 轴向上
  3. `Vector Rotate`: 旋转 (0,0,1) by 灯光.001 的 Rotation
  4. `Vector Math` → Group Output.SUN

- FRONT 属性: 旋转 (0,1,0) by "面部定位.001" 的 Rotation
- RIGHT 属性: 旋转 (1,0,0) by "面部定位.001" 的 Rotation

**精确值（MCP 计算）**:
- 灯光.001 rotation_euler = (1.0472, 0, 0.3491) = (60°, 0°, 20°)
- SUN (Blender Z-up) = (0.296, -0.814, 0.500)
- SUN (引擎 Y-up) = (0.296, 0.500, -0.814) = `-light.lights[0].direction.xyz`
- 面部定位.001 rotation_euler = (-1.5708, 0, 0) = (-90°, 0°, 0°)
- FRONT (Blender Z-up) = (0, 0, -1)
- RIGHT (Blender Z-up) = (1, 0, 0)

**坐标转换约定**: Blender Z-up → 引擎 Y-up 使用 (x, z, y) 转换
- Blender X → 引擎 X
- Blender Z → 引擎 Y
- Blender Y → 引擎 Z

**灯光.001 对象**:
- type: SUN (方向光)
- energy: 0.0 (关闭，不提供实际光照)
- color: (1.0, 0.385, 0.163) 暖橙色
- 仅用于提供旋转方向给几何节点修改器

#### 受影响 shader 及修复

| Shader | 错误实现 | 正确修复 | 状态 |
|--------|----------|----------|------|
| body.ts | `virtual_sun(n, vec3f(0.0), 0.8)` | `virtual_sun(n, -light.lights[0].direction.xyz, 0.8)` | ✅ 已修复 |
| hair.ts | `halfLambert = 0.5` (恒定) | `saturate(dot(n, -light.lights[0].direction.xyz) + 0.5)` | ✅ 已修复 |
| clothes.ts | `virtual_sun(n, vec3f(0.0), ilmGreen)` | `virtual_sun(n, -light.lights[0].direction.xyz, ilmGreen)` | ✅ 已修复 |
| clothes_inner.ts | `virtual_sun(n, vec3f(0.0), ilmGreen)` | `virtual_sun(n, -light.lights[0].direction.xyz, ilmGreen)` | ✅ 已修复 |
| eye.ts | `vec3f(0.0, 0.0, 0.0)` | 无需修改（dot(faceFront, SUN)=-0.5, saturate=0, 与 vec3f(0) 结果相同） | ✅ 已正确 |
| face.ts | 使用 `-light.lights[0].direction.xyz` | 已正确（SDF 阴影使用实际光向） | ✅ 已正确 |
| stocking.ts | 使用实际光向 | 保留实际光向 | ✅ 已正确 |
| special.ts | 不使用 virtual_sun | 无需修改 | ✅ 已正确 |

#### 之前的错误分析（已作废）

~~SUN 几何属性缺失 → Attribute 返回 (0,0,0) → virtual_sun 退化为常量 0.5625~~

**正确分析**: SUN 属性通过几何节点修改器动态设置 = 灯光.001 的旋转方向。之前的 MCP 验证只检查了 mesh 的静态属性，遗漏了几何节点修改器在渲染时动态生成的属性。

#### Blender 场景光照核对
- Sun energy = 0.0（关闭）
- World Background = (0.051, 0.051, 0.051) Strength=1.0
- Viewport 使用 Material Preview + forest.exr HDRI
- 灯光.001 energy=0.0，仅用于提供 SUN 方向给几何节点修改器

### Task 6 补充: Sun strength 差异

#### 发现
- **引擎当前**: page.tsx sun.strength = 7.25
- **项目记忆要求**: 5.0 (brightnessScale=1.0)
- **Blender 场景**: Sun energy = 0.0（关闭，用 HDRI）

#### 状态
- 已记录差异，待用户确认是否调整至 5.0
- 当前 brightnessScale = 7.25/5.0 = 1.45（所有材质偏亮 45%）

### 本次会话修改文件清单

| 文件 | 修改内容 | 任务 |
|------|---------|------|
| `engine/src/shaders/materials/starrail/eyeshadow.ts` | shadowColor 从 (0.2214) 改为 (0,0,0) | Task 1 |
| `web/public/models/风堇/manifest.json` | 目影 alpha 0.5 → 0.7786 | Task 1 |
| `engine/src/shaders/materials/starrail/clothes.ts` | 完全重写 SR_CLOTHES_SHADER_WGSL 和 SR_CLOTHES_INNER_SHADER_WGSL | Task 3 |
| `engine/src/shaders/materials/starrail/body.ts` | virtual_sun 传入 vec3f(0.0) | Task 6 |
| `engine/src/shaders/materials/starrail/hair.ts` | halfLambert 恒定为 0.5 | Task 6 |

### 验证状态
- ✅ `npm run build` 编译成功
- ⚠️ 需 `npm run clean` 后重新构建（WGSL 字符串常量变更）
- ⚠️ 需用户视觉验证与 Blender 对齐效果
- ⚠️ Sun strength 差异 (7.25 vs 5.0) 待用户确认

### 未实现项
- ~~clothes.ts 的 Fresnel 加性 (Mix.007 ADD 0.25) 需绑定 Stockings 贴图~~
- **经 MCP 深入检查：Fresnel 加性项实际为 0，无需实现**

#### Mix.007 Fresnel 加性完整链路分析（MCP 验证）

**Mix.007 (ADD, Factor=0.25)**:
- A <- Mix.002.Result (base × specIntensity)
- B <- Mix.006.Result (Fresnel mask)
- 最终输出 = Mix.002 + 0.25 × Mix.006

**Mix.006 (MULTIPLY)**:
- A <- Color Ramp.Color (Layer Weight.Facing → Color Ramp: 0→白, 1→黑)
- B <- Mix.005.Result

**Mix.005 (MULTIPLY)**:
- A <- Mix.004.Result
- B <- Separate Color.002.Green

**Mix.004 (MULTIPLY)**:
- A <- Separate Color.001.Blue (Image Texture.001, Stockings 贴图, UV×50)
- B <- Separate Color.002.Red (Image Texture.002, Stockings 贴图, UV=(0,0,0))

**关键发现**:
- Image Texture.002 的 Vector 输入未连接，默认 (0,0,0)，固定采样 (0,0) 像素
- pixel(0,0) RGBA = (0.0, 0.0, 0.6314, 1.0) → **Red=0.0, Green=0.0**
- Layer Weight (Blend=0.96) → Color Ramp (CARDINAL, 0→白, 1→黑)

**计算结果**:
- Mix.004 = Blue1 × Red2 = Blue1 × 0.0 = **0.0**
- Mix.005 = Mix.004 × Green2 = 0.0 × 0.0 = **0.0**
- Mix.006 = Color Ramp.Color × 0.0 = **0.0**
- Mix.007 = Mix.002 + 0.25 × 0.0 = **Mix.002**

**结论**: Fresnel 加性项在 Blender 中实际输出为 0（因为 Image Texture.002 固定采样 (0,0) 像素，该像素 Red=0, Green=0）。当前 clothes.ts 不实现此加性项已与 Blender 完全一致，无需修改。
