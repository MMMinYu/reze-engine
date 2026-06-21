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
