# Checklist

## 整体提亮
- [x] 通过 MCP 查询 Blender 场景 SunLight strength/color、World ambient、View exposure、Color Management look
- [x] page.tsx 中 sun.strength 与 Blender 一致（5.0，Blender energy=0.0 纯 emission）
- [x] page.tsx 中 world.color / world.strength 与 Blender 一致（0.0509×1.0）
- [x] page.tsx 中 view.exposure 与 Blender 一致（0.0）
- [x] 各 sr_* 材质的 brightnessScale 基准与 Blender SunLight strength 匹配（5.0/5.0=1.0）
- [x] composite.ts 的 Filmic + exposure 应用链与 Blender Color Management 一致
- [x] sr_* shader 添加 ambient 项以匹配 Blender Cycles 间接光照（body/face/clothes×2/hair/eye/special 已完成；stocking 通过 eval_principled 内置 amb，eyeshadow/edge/mmd 不需要）
- [x] docs/ 调试文档已更新亮度部分（starrail-alignment-debug.md）

## 丝袜材质流程对齐
- [x] stocking.ts 末尾 DEBUG 测试代码已移除
- [x] noise3d_fixed TEMP 代码已修复（使用实际 noise3d 值）
- [x] 通过 MCP 逐节点核对 Blender SockAIO.021 完整节点树（81 节点）
- [x] BaseColor 使用纯白（非 Body3.png 贴图）
- [x] Alpha = thickness_gate × fiber_coverage（含厚度门控）
- [x] UVScale 内部乘 0.6667
- [x] Float Curve Factor=0 输出常量（FiberWidth=0.03, FiberThickness=0.025, FurAmount=0.01）
- [x] Roughness A/B 端正确（mix(0.85, 0.35, ...)）
- [x] Subsurface Scale 动态调整（mix(0.1, 0.001, Alpha)）
- [x] Specular Tint 动态混合
- [x] Normal Map UV 变换正确
- [x] manifest.json 贴图路径与 uniforms 与 Blender 一致（7 张贴图全部存在）
- [x] 缺失的文件/公式已明确告知用户（见下方差异清单）
- [ ] 实现各向异性高光（Direction 贴图驱动）
- [ ] docs/stockings-alignment-debug.md 已更新

### 丝袜材质差异清单（经 MCP 核对 SockAIO.021 + SockV3.027）
**文件**: 全部 7 张贴图已存在且正确绑定，无缺失文件
1. color: textures/Body3.png ✓
2. sock_sdf: textures/sock_tiled_sdf.png ✓
3. sock_direction: textures/sock_tiled_direction.png ✓（引擎声明但未使用）
4. sock_normal: textures/sock_tiled_normal.png ✓
5. thickness: textures/cf_panst_07_t.png ✓
6. fur_layer: textures/Substance_graph_FurLayer.png ✓
7. sdf_lut: textures/SDFLut.png ✓（UseLut=0 时不使用，正确）

**缺失公式**:
1. **各向异性高光（Anisotropic）**: Blender 用 sock_tiled_direction.png 的 RG 通道计算切线方向，IsFiber×Direction.X×50 计算各向异性旋转。引擎 eval_principled 不支持各向异性 GGX
2. **次表面散射（Subsurface）**: Blender Principled BSDF Weight=0.4, Radius=(1,0.2,0.1), 动态 Scale。引擎用 wrapped lighting 近似
3. **透射（Transmission）**: Blender Principled BSDF Weight=0.3。引擎用简单皮肤色混合
4. **Generated 坐标**: Blender 用 Generated（对象空间归一化 [0,1]），引擎用 worldPos 近似

## 脸部光照方向对齐
- [x] 通过 MCP 核对 Blender SDF 子组的 SUN 方向来源
- [x] 通过 MCP 查询 PMX 中 faceFront/faceRight/faceUp 的实际值与坐标空间
- [x] sdf_face_shadow 坐标转换公式正确（无错误的 Y 轴取负）
- [x] face.ts 中 SUN 方向与 body.ts/clothes.ts 一致
- [x] 脸部 SDF 阴影方向与身体/衣服/头发一致
- [x] docs/ 调试文档已更新脸部光照方向部分（starrail-alignment-debug.md）
