// sr_special — 袖球材质（MMDTexUV sphere mapping + desaturation）。
//
// 经 MCP 核对 Blender "袖球"材质节点树：
//   1. tex_衣 (衣.png) at base UV → 降饱和 (HueSaturation, Saturation=0.9)
//   2. MMDTexUV.001 Sphere UV: Normal → VECT_TRANSFORM(OBJECT→CAMERA) → Mapping(Scale=0.5, Loc=0.5)
//   3. tex_9JPG_sphere (9.JPG) at sphere UV → sphere增亮 (MapRange 0→0.42, 1→2.0)
//   4. 贴图×sphere (MULTIPLY): desaturated_tex * brightened_sphere
//   5. Output → Material Output.Surface (emission-like, 无光照)
//
// 注意：Blender 中 RGBA 连接到 Surface(SHADER) 类型不匹配，EEVEE 解释为 Emission。

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_SPECIAL_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);

  // ── 1. 基础贴图采样 ──
  let texColor = textureSample(colorTexture, srSampler, input.uv);

  // ── 2. 降饱和 (Blender HueSaturation: Hue=0.5, Saturation=0.9, Value=1.0, Factor=1.0) ──
  // hue_sat_id(saturation, value, fac, color) — Hue=0.5 在 Blender 中表示无色相偏移
  let desaturated = hue_sat_id(0.9, 1.0, 1.0, texColor.rgb);

  // ── 3. Sphere UV 计算 (MMDTexUV.001) ──
  // Blender: Normal → VECT_TRANSFORM(OBJECT→CAMERA) → Mapping(Scale=0.5, Loc=0.5)
  // 引擎: input.normal 是世界空间法线，用 camera.view 变换到相机空间
  let normalCam = (camera.view * vec4f(n, 0.0)).xyz;
  let sphereUV = normalCam.xy * 0.5 + vec2f(0.5);

  // ── 4. Sphere 贴图采样 + 增亮 (MapRange: 0→0.42, 1→2.0, clamp=true) ──
  let sphereSample = textureSample(matcapTexture, srSampler, sphereUV);
  let sphereVal = sphereSample.r;  // 9.JPG 是灰度图
  let brightened = 0.42 + sphereVal * 1.58;  // mix(0.42, 2.0, sphereVal)

  // ── 5. 乘法合成 (贴图×sphere: MULTIPLY, Factor=1.0) ──
  let finalColor = desaturated * brightened;

  // ── 6. 输出 (emission-like, 无光照) ──
  var out: FSOut;
  out.color = vec4f(finalColor, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
