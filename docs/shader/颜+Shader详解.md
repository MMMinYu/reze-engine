# 颜+ Shader 详解

## 一、使用部位

| 材质名 | 版本 | 节点数 | 连线数 |
|--------|------|--------|--------|
| `颜+` | 星铁渲染版 | 8 | 8 |
| `actual_颜+` | MMD原版 | 6 | 7 |
| `actual_颜+.002` | 混合版 | 8 | 10 |

## 二、贴图清单

| 贴图 | 尺寸 | 色彩空间 | 均值 RGB | 用途 |
|------|------|----------|----------|------|
| 颜赤.tga | 1024×1024 | sRGB | 0.200 / 0.139 / 0.134 | 腮红贴图（Color + Alpha 双通道） |
| toon3.png | — | — | — | MMD版Toon贴图 |

## 三、信号流图

### 3.1 颜+ 星铁版 (8节点, 8连线)

```
UV [UVMap]
  │
  ├── Color ──→ BlushTex [颜赤.tga 1024×1024]
  │                 │
  │                 ├── Color ──→ face_shader [星铁@Minyu-Shader.face.001]
  │                 │                │
  │                 │                └── Shader ──→ MixShader.Shader2
  │                 │
  │                 └── Alpha ──→ Mul (Math) ←── Drv (Value驱动)
  │                                  │
  │                                  └── Value ──→ MixShader.Factor
  │
  └─────────────────────────────────────────────────┐
                                                     │
                          transparent ──→ MixShader.Shader1
                                                     │
                                        MixShader ──→ Material Output.Surface
```

**face_shader 内部 (19节点)：**
```
SDF光照 → Map Range(0.15~0.99) → ramp → 校色 → 鼻尖阴影 → 最终混合
```

### 3.2 actual_颜+ MMD版 (6节点, 7连线)

```
mmd_tex_uv [MMDTexUV]
  │
  ├── Base UV ──→ mmd_base_tex [颜赤.tga] ──→ mmd_shader [MMDShaderDev]
  │                                                │
  └── Toon UV ──→ mmd_toon_tex [toon3.png] ──→ mmd_shader
                                                     │
                                        mmd_shader ──→ Material Output
```

标准 MMDShaderDev 结构，无 Sphere 贴图。

### 3.3 actual_颜+.002 混合版 (8节点, 10连线)

```
mmd_tex_uv [MMDTexUV]
  │
  ├── Base UV ──→ mmd_base_tex [颜赤.tga]
  │                 │
  │                 ├── Color ──→ Group [颜+]
  │                 │                │
  │                 │                └── Shader ──→ Shader to RGB
  │                 │                                │
  │                 │                                └── Color ──→ mmd_shader.Base Tex
  │                 │
  │                 └── Alpha ──┬──→ mmd_shader.Base Alpha
  │                             └──→ Group [颜+].Fac
  │
  └── Toon UV ──→ mmd_toon_tex ──→ mmd_shader
                                     │
                        mmd_shader ──→ Material Output
```

先用颜+节点组处理（含 Emission + 透明混合），再 Shader to RGB 转颜色送入 MMDShaderDev。

## 四、节点详解

### 4.1 星铁版关键节点

| 节点 | 类型 | 功能 |
|------|------|------|
| UV | UV Map | 输出 UVMap 坐标 |
| BlushTex | Image Texture | 采样颜赤.tga，输出 Color(RGB) + Alpha(A) |
| face_shader | NodeGroup (19子节点) | 星铁面部 SDF 光照 + ramp + 校色 + 鼻尖阴影 |
| Mul | Math (Multiply) | Alpha × 驱动值，控制腮红强度 |
| Drv | Value (Driver) | 驱动值，外部控制腮红显示程度 |
| MixShader | Mix Shader | 在 transparent 和 face_shader 之间混合 |
| transparent | Transparent BSDF | 完全透明（用于 Alpha 混合的基底） |
| Material Output | Output | 最终输出 |

**face_shader 内部节点链：**
1. SDF 光照计算
2. Map Range：输入 [0, 1] → 输出 [0.15, 0.99]
3. ColorRamp：明暗分级（ramp）
4. 校色：颜色校正
5. 鼻尖阴影：附加阴影区域
6. 最终混合：输出 Shader

### 4.2 MMD版关键节点

| 节点 | 类型 | 功能 |
|------|------|------|
| mmd_tex_uv | MMDTexUV | MMD UV 分离器 |
| mmd_base_tex | Image Texture | 颜赤.tga |
| mmd_toon_tex | Image Texture | toon3.png |
| mmd_shader | MMDShaderDev | 标准 MMD 着色器 |

### 4.3 混合版关键节点

| 节点 | 类型 | 功能 |
|------|------|------|
| Group [颜+] | NodeGroup | 颜+节点组（Emission + 透明混合） |
| Shader to RGB | Converter | 将 Shader 输出转为颜色 |
| mmd_shader | MMDShaderDev | 接收转换后的颜色 |

## 五、颜色公式

### 5.1 星铁版最终颜色

```
最终颜色 = mix(Transparent, face_shader输出, Alpha × 驱动值)
```

其中 `Alpha × 驱动值` 控制 MixShader 的 Factor：
- Factor = 0 → 完全透明（看不见腮红）
- Factor = 1 → 完全显示 face_shader 输出（腮红全显）

### 5.2 颜+节点组内部

```
蓝通道压缩:
  if B ≤ 0.6455:
    B' = B × (0.3032 / 0.6455)
  else:
    B' = 0.3032 + (B - 0.6455) × (1.0 - 0.3032) / (1.0 - 0.6455)

Emission:
  emission = (R, G, B') × 1.0

双层混合:
  layer1 = mix(白色(1,1,1,1), emission, fac)
  layer2 = mix(白色(1,1,1,1), layer1, 1.0) = layer1
```

**简化：** `输出 = mix(白色, 压缩后颜色, alpha)`

### 5.3 混合版最终输出

```
颜+处理 → Shader to RGB → 颜色
颜色 → MMDShaderDev.Base Tex
Alpha → MMDShaderDev.Base Alpha
```

## 六、因素分析

| 因素 | 影响 | 范围 |
|------|------|------|
| 颜赤.tga Alpha | 腮红形状遮罩 | 贴图内含，不可调 |
| 颜赤.tga Color | 腮红基础色调 | 贴图内含，偏暖粉 (0.2/0.139/0.134) |
| Drv 驱动值 | 腮红整体显示/隐藏强度 | 0~1 |
| face_shader Map Range | 面部明暗范围 | 0.15~0.99 |
| 蓝通道压缩曲线 | 腮红冷暖偏移 | 拐点 0.6455→0.3032 |
| MixShader Factor | 透明度混合权重 | = Alpha × Drv |

## 七、调节切入点

| 目标 | 调节方式 | 节点/参数 |
|------|----------|-----------|
| 腮红强度 | 改 Drv 驱动值 | Value (Driver) 节点 |
| 腮红颜色偏暖/偏冷 | 改 face_shader 内校色 | face_shader 子节点 |
| 腮红形状 | 重绘颜赤.tga | 外部图像编辑 |
| 腮红蓝通道偏移 | 改压缩曲线参数 | 颜+节点组内部 |
| 面部明暗对比 | 改 Map Range 范围 | face_shader 内 Map Range (当前 0.15~0.99) |
| 腮红边界柔和度 | 改颜赤.tga Alpha 模糊程度 | 外部图像编辑 |
| MMD版腮红强度 | 改 mmd_base_tex Alpha 通道影响 | MMDShaderDev 参数 |

## 八、WGSL 代码

```wgsl
fn face_glow_shade(color: vec4f, fac: f32) -> vec4f {
    var b = color.b;
    if (b <= 0.6455) {
        b = b * (0.3032 / 0.6455);
    } else {
        b = 0.3032 + (b - 0.6455) * (1.0 - 0.3032) / (1.0 - 0.6455);
    }
    let curved = vec4f(color.r, color.g, b, color.a);
    let emission = curved * 1.0;
    let layer1 = mix(vec4f(1.0), emission, fac);
    let layer2 = mix(vec4f(1.0), layer1, 1.0);
    return layer2;
}

fn face_glow_fragment(in: FragmentInput) -> vec4f {
    let base = textureSample(eye_base_tex, eye_sampler, in.uv);
    let glow = face_glow_shade(base, base.a);
    let mix_factor = base.a * 0.5;
    return mix(vec4f(1, 1, 1, 0), glow, mix_factor);
}
```
