# 袖球 Shader 详解

## 一、使用部位

| 材质名 | 版本 | 节点数 | 连线数 | 应用位置 |
|--------|------|--------|--------|----------|
| `actual_袖球` | MMD完整版 | 7 | 10 | slot63 袖球 |
| `袖球` | 自定义shader版 (v20修复后) | 8 | 7 | slot63 袖球 |

## 二、贴图清单

| 贴图 | 尺寸 | 色彩空间 | 用途 |
|------|------|----------|------|
| 衣.png | 4096×2048 | sRGB | 基础色贴图 |
| 9.JPG | 512×512 | Linear | Sphere 环境贴图（法线驱动） |
| toon4.png | 800×800 | — | Toon 卡通阴影贴图 |

袖球是少数同时使用 Base + Toon + Sphere 三张贴图的材质。

## 三、信号流图

### 3.1 actual_袖球 MMD完整版 (7节点, 10连线)

```
mmd_tex_uv [MMDTexUV]
  │
  ├── Base UV ──→ mmd_base_tex [衣.png 4096×2048] ──→ mmd_shader [MMDShaderDev]
  │                                                     │
  ├── Toon UV ──→ mmd_toon_tex [toon4.png 800×800] ──→ mmd_shader
  │                                                     │
  └── Sphere UV ──→ mmd_sphere_tex [9.JPG 512×512 Linear] ──→ mmd_shader
                                                            │
                                               mmd_shader ──→ Material Output
```

标准三贴图 MMDShaderDev：Base + Toon + Sphere 全部启用。

### 3.2 袖球 自定义shader版 (8节点, 7连线) — v20修复后

```
UV1
  │
  └──→ tex_衣 [衣.png 4096×2048]
         │
         └── Color ──→ 降饱和 (HSV Sat=0.9)
                         │
                         └── Color ──→ 贴图×sphere (Multiply混合)
                                          ↑
MMDTexUV.Sphere ──→ tex_9JPG_sphere [9.JPG 512×512] ──→ sphere增亮 (Map Range: [0,1]→[0.42,2.0])
                                                            │
                                                            └── Color ──→ 贴图×sphere
                                                                            │
                                                               Material Output.Surface
```

**信号流简化：**
```
衣.png → 降饱和 ─┐
                  ├→ Multiply混合 → 输出
9.JPG → 增亮 ────┘
```

### 3.3 Sphere Mapping 原理

```
纹理坐标.Normal
  → 矢量变换 (NORMAL, OBJECT → CAMERA)
    → 映射 (Location=(0.5, 0.5, 0), Scale=(0.5, 0.5, 1.0))
      → Sphere UV（法线驱动的环境贴图UV）
```

Sphere 贴图不是用普通 UV 采样的，而是根据表面法线方向在相机空间中计算采样坐标，产生类似环境反射的效果。

## 四、节点详解

### 4.1 MMD完整版关键节点

| 节点 | 类型 | 功能 |
|------|------|------|
| mmd_tex_uv | MMDTexUV | 分离 Base/Toon/Sphere 三路 UV |
| mmd_base_tex | Image Texture | 衣.png 基础色 |
| mmd_toon_tex | Image Texture | toon4.png 卡通阴影 |
| mmd_sphere_tex | Image Texture | 9.JPG 环境反射 |
| mmd_shader | MMDShaderDev | MMD 标准着色器（三贴图输入） |

### 4.2 自定义shader版关键节点

| 节点 | 类型 | 功能 |
|------|------|------|
| UV1 | UV Map | 基础 UV 坐标 |
| tex_衣 | Image Texture | 衣.png 采样 |
| 降饱和 | Hue/Saturation/Value | HSV Saturation = 0.9，降低饱和度 10% |
| tex_9JPG_sphere | Image Texture | 9.JPG Sphere 采样 (Linear) |
| sphere增亮 | Map Range | From [0, 1] → To [0.42, 2.0]，增亮 Sphere 信号 |
| 贴图×sphere | Mix (Multiply) | 贴图降饱和结果 × Sphere增亮结果 |
| Material Output | Output | 最终输出 |

## 五、颜色公式

### 5.1 自定义版最终颜色

```
降饱和贴图:
  base_hsv = RGB_to_HSV(衣.png采样)
  base_hsv.S = base_hsv.S × 0.9
  desaturated = HSV_to_RGB(base_hsv)

Sphere增亮:
  sphere_raw = 9.JPG采样
  sphere_bright = sphere_raw × (2.0 - 0.42) + 0.42
  即: sphere_bright = sphere_raw × 1.58 + 0.42

最终:
  result = desaturated × sphere_bright
```

### 5.2 WGSL 等效

```
adjusted = hsv_adjust(base, 0.5, 0.9, 1.0)  // 保持色相和明度，饱和度×0.9
sphere_bright = adjusted.rgb × 1.21          // 增亮系数
result = vec4f(sphere_bright, adjusted.a)
```

## 六、因素分析

| 因素 | 影响 | 当前值 |
|------|------|--------|
| 衣.png | 基础颜色和纹理 | 4096×2048 sRGB |
| 9.JPG | 环境反射光泽 | 512×512 Linear |
| toon4.png | MMD版卡通阴影 | 800×800 |
| HSV Saturation | 饱和度降低程度 | 0.9（降 10%） |
| Sphere Map Range | 反射亮度范围 | [0, 1] → [0.42, 2.0] |
| Sphere 增亮系数 | 实际乘数 | 1.58×，偏移 +0.42 |
| Multiply 混合模式 | 基础色与反射的叠加方式 | 乘法（暗色相乘更暗，亮色相乘更亮） |

## 七、调节切入点

| 目标 | 调节方式 | 节点/参数 |
|------|----------|-----------|
| 袖球颜色饱和度 | 改 HSV Saturation | 降饱和节点 (当前 0.9，越小越灰) |
| 袖球光泽/反射强度 | 改 Sphere Map Range To 值 | sphere增亮节点 (当前 [0.42, 2.0]，增大更亮) |
| 袖球整体亮度 | 改 Sphere 增亮下限 | Map Range To Min (当前 0.42，增大=全提亮) |
| 环境反射纹理 | 换 9.JPG 贴图 | tex_9JPG_sphere |
| 基础颜色 | 重绘衣.png 对应区域 | 外部图像编辑 |
| MMD版效果 | 改 toon4.png 或 mmd_shader 参数 | mmd_shader |
| 反射质感 | 改 Sphere 映射参数 | 映射节点 Location/Scale |

## 八、WGSL 代码

```wgsl
fn sleeve_ball_fragment(in: FragmentInput) -> vec4f {
    let base = textureSample(eye_base_tex, eye_sampler, in.uv);
    let adjusted = hsv_adjust(base, 0.5, 0.9, 1.0);
    let sphere_bright = vec4f(adjusted.rgb * 1.21, adjusted.a);
    return sphere_bright;
}
```
