// sr_eye — StarRailShader 眼部（眼睫 group）移植。
//
// 经 MCP 完整核对 "目" 材质 + 眼睫.001 + 夹角判断.001 + 校色.001：
//   颜_独立.png → RGB Curves(Factor=0.4335) → 眼睫.001:
//     Mix(A=Input, B=HSV(Input,val=0.65), Factor=夹角判断) → 校色.001 → Output
//
// 夹角判断.001: dot(Attribute(FRONT), Attribute(SUN)) → MapRange(0,1→0,1)
// MCP 核对: FRONT 和 SUN 属性都不存在 → dot(0,0)=0 → MapRange=0
// → Mix Factor=0 → 不压暗，直接用原色 A

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_EYE_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

// "目" 材质的 RGB Curves LUT（Factor=0.4335，4 条曲线）
// Curve 0 (R): 恒等
// Curve 1 (G): [(0,0),(0.5682,0.4632),(1,1)]
fn _eye_curve_g(t: f32) -> f32 {
  let idx_f = saturate(t) * 20.0;
  let idx = i32(idx_f);
  let frac = idx_f - f32(idx);
  let LUT = array<f32, 21>(
    0.000000, 0.035524, 0.071209, 0.107274, 0.143992,
    0.181724, 0.220826, 0.261639, 0.304418, 0.349283,
    0.396200, 0.445016, 0.495611, 0.548232, 0.603461,
    0.661892, 0.723957, 0.789615, 0.858224, 0.928708,
    1.000000
  );
  let i0 = clamp(idx, 0, 19);
  return mix(LUT[i0], LUT[i0 + 1], frac);
}

// Curve 2 (B): [(0,0),(0.4870,0.5392),(1,1)]
fn _eye_curve_b(t: f32) -> f32 {
  let idx_f = saturate(t) * 20.0;
  let idx = i32(idx_f);
  let frac = idx_f - f32(idx);
  let LUT = array<f32, 21>(
    0.000000, 0.059178, 0.118133, 0.176562, 0.234121,
    0.290458, 0.345393, 0.398874, 0.451022, 0.502036,
    0.552093, 0.601265, 0.649409, 0.696406, 0.742207,
    0.786851, 0.830521, 0.873444, 0.915862, 0.957992,
    1.000000
  );
  let i0 = clamp(idx, 0, 19);
  return mix(LUT[i0], LUT[i0 + 1], frac);
}

// RGB Curves 预处理（Factor=0.4335）
fn eye_rgb_curves(c: vec3f) -> vec3f {
  let curved = vec3f(c.r, _eye_curve_g(c.g), _eye_curve_b(c.b));
  return mix(c, curved, 0.4335);
}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  // ── 1. 纹理采样 ──
  let texColor = textureSample(colorTexture, srSampler, input.uv);

  // ── 2. RGB Curves 预处理（仅"目"材质启用，Factor=0.4335）──
  // MCP 核对: 只有"目"材质在 Image Texture 后接 RGB Curves，
  // "白目"/"目光"/"眉睫" 直接进 Group(眼睫.001)。
  // useRGBCurves uniform 由 manifest 控制（目=1.0, 其他=0.0）。
  var inputColor = texColor.rgb;
  if (srMaterial.useRGBCurves > 0.5) {
    inputColor = eye_rgb_curves(texColor.rgb);
  }
  let curved = inputColor;

  // ── 3. 夹角判断 (照度) ──
  // MCP 核对: FRONT 和 SUN 属性都不存在 → dot(0,0)=0 → angle=0
  // → Mix Factor=0 → 不压暗，直接用原色
  let frontYup = vec3f(srMaterial.faceFront.x, srMaterial.faceFront.z, -srMaterial.faceFront.y);
  let angle = view_angle_test(frontYup, vec3f(0.0, 0.0, 0.0));

  // ── 4. HSV 压暗 (value=0.65) ──
  let darkened = hsv_adjust(curved, 0.5, 1.0, 0.65);

  // ── 5. Mix (factor=angle=0 → 不压暗) ──
  let mixed = mix(curved, darkened, angle);

  // ── 6. 校色 (C曲线 + HSV×1.85) ──
  let corrected = color_correct(mixed);

  var out: FSOut;
  out.color = vec4f(corrected, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
