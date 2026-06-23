// sr_eyeshadow — 目影专用 shader（Transparent BSDF 纯色半透明）
//
// 经 MCP 核对 "目影" 材质:
//   目影.001 group: Transparent BSDF(Color=(0.2214, 0.2214, 0.2214))
//   Material Output.Surface 直接接 BSDF
//   blend_method = BLEND
//
// 经 MCP 渲染测试验证（Standard view transform）:
//   白底 0.5176 sRGB → 0.2307 linear
//   目影区 0.2588 sRGB → 0.0544 linear
//   线性比值 ≈ 0.2214 = Color 值
//
// 结论: Transparent BSDF 在 EEVEE 中是纯乘法暗化: result = dst * Color
// 等价于 alpha blending: src=0 (黑), alpha = 1 - Color = 1 - 0.2214 = 0.7786
//   result = 0 * alpha + dst * (1 - alpha) = dst * 0.2214

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_EYESHADOW_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  // Transparent BSDF(Color=(0.2214, 0.2214, 0.2214))
  // 经 MCP 渲染测试: result = dst * Color (纯乘法暗化)
  // 等价于 src=0 (黑), alpha = 1 - 0.2214 = 0.7786
  // src.rgb 必须为 0，不能是 Color 值（否则会引入错误的加性分量）
  let shadowColor = vec3f(0.0, 0.0, 0.0);

  var out: FSOut;
  out.color = vec4f(shadowColor, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
