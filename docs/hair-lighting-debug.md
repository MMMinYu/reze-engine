# 头发光照调试记录

## ⚠️ 重要：清缓存步骤

**每次修改 engine/src 下的代码后，必须执行以下步骤，否则 Turbopack 不会检测到变化：**

```powershell
# 1. 构建 engine
cd e:\reze-engine\engine; npm run build

# 2. 复制 dist 到 web 的 node_modules（file: 包不会自动同步）
Copy-Item -Path e:\reze-engine\engine\dist\* -Destination e:\reze-engine\web\node_modules\reze-engine\dist\ -Recurse -Force

# 3. 停止 dev server，清理 .next 缓存
Get-Process -Name "node" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
Remove-Item -LiteralPath e:\reze-engine\web\.next -Recurse -Force -ErrorAction SilentlyContinue

# 4. 重启 dev server
cd e:\reze-engine\web; npm run dev
```

**原因：** Web 通过 `file:../engine` 引用引擎包。Turbopack 缓存了 `web/node_modules/reze-engine/dist` 的编译结果，修改 `engine/dist` 后需要手动复制到 `web/node_modules/reze-engine/dist`，并清理 `.next` 缓存目录。

---

## 问题
引擎中头发比 Blender 暗，正面/背面差异不明显。

## 根本原因

### 1. 太阳方向坐标系转换错误

Blender 和引擎使用不同的坐标系：

| 坐标系 | X | Y | Z |
|--------|---|---|---|
| Blender（右手） | right | into screen | up |
| 引擎（左手） | right | up | into screen |

**转换公式：** Blender (X, Y, Z) → 引擎 (X, Z, Y)

Blender SUN 属性值：`(0.296, -0.814, 0.5)`

正确转换：
- Blender X=0.296 → 引擎 X=0.296
- Blender Y=-0.814（into screen, 朝向相机）→ 引擎 Z=-0.814（into screen, 朝向相机）
- Blender Z=0.5（up）→ 引擎 Y=0.5（up）

引擎 SUN（sunDir）：`(0.296, 0.5, -0.814)`

引擎 `direction = -sunDir = (-0.296, -0.5, 0.814)`

### 2. 相机初始位置

引擎相机初始 `alpha = Math.PI`，所以相机在 -Z 方向：
- 相机位置：`(0, target.y, target.z - radius)`
- 视线方向：+Z

角色面向 -Z（朝向相机）。

### 3. 背面剔除

Blender 中头发材质启用 `Backface Culling: True`。
引擎中使用 shader discard 模拟：`if (dot(n, v) < 0.0) { discard; }`

## 修改文件

1. `web/app/page.tsx`：太阳方向 `(-0.296, 0.814, -0.500)` → `(-0.296, -0.500, 0.814)`
2. `engine/src/shaders/materials/starrail/hair.ts`：添加软背面剔除
3. `web/public/models/风堇/manifest.json`：修复头发纹理路径（textures_blender/ → textures/）

## Blender 渲染参考

正面视角平均亮度：0.28（8bit 73）

## 待实现：全局光照（GI）

### 问题分析

Blender EEVEE 启用了 Fast GI（`use_fast_gi: True`），`gi_diffuse_bounces: 3`。
这为场景添加了间接光照（环境光），使整体更亮。

引擎中只有直接光照，没有 GI。导致：
- 亮区：引擎 8bit(210) vs Blender 8bit(224) — 引擎暗 14
- 中区：引擎 8bit(205,181,191) vs Blender 8bit(195,146,154) — 引擎实际更亮
- 暗区：引擎 8bit(204,179,189) vs Blender 8bit(115,75,74) — 引擎亮很多（暗区差异来自背面剔除）

### GI 实现路线图（从简单到复杂）

#### 第 1 步：环境光近似（Hemisphere Light）
- 在 shader 中添加半球环境光
- 上方使用世界颜色 (0.05, 0.05, 0.05)，下方使用更暗的颜色
- 根据法线方向插值
- **工作量：** 小（修改 common.ts 中的光照计算）
- **效果：** 整体提亮，但不精确

#### 第 2 步：IBL（Image-Based Lighting）
- 烘焙环境贴图（Cubemap 或 Equirectangular）
- 使用漫反射环境贴图为场景添加环境光
- **工作量：** 中等（需要烘焙管线和采样器）
- **效果：** 更真实的环境光

#### 第 3 步：SSGI（Screen-Space Global Illumination）
- 在屏幕空间模拟间接光照
- 类似 SSAO 的反向操作
- **工作量：** 大（需要新的后处理 Pass）
- **效果：** 最接近 Blender 的 Fast GI

### 当前状态
- 太阳方向已修复
- 软背面剔除已实现
- 头发纹理路径已修复
- GI 尚未实现
