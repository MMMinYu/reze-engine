// sr_eye — StarRailShader 眼部（眼睫 group）移植。
//
// 经 MCP 核对 眼睫.001 数据流：
//   照度 = 夹角判断(dot(FRONT, SUN))   → saturate(dot)
//   压暗色 = HSV(value=0.65)(input)
//   mix = mix(原色, 压暗色, 照度)       → 太阳越正面越压暗
//   校色_out = 校色(mix)
//
// 眼睛贴图已烘焙大部分效果（瞳孔/虹膜/高光），shader 只做轻量处理。
// 没有使用 ILM/ramp/sdf/matcap 贴图（只有 colorTexture）。

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_EYE_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let l = -light.lights[0].direction.xyz;

  // ── 1. 纹理采样 ──
  let texColor = textureSample(colorTexture, srSampler, input.uv);

  // ── 2. 夹角判断 (照度) ──
  // 经 MCP 核对: dot(FRONT, SUN)，负值 clamp 到 0
  let angle = view_angle_test(srMaterial.faceFront, l);

  // ── 3. HSV 压暗 ──
  // 经 MCP 核对 眼睫.001: Hue/Saturation/Value(value=0.65)
  let darkened = hsv_adjust(texColor.rgb, 0.5, 1.0, 0.65);

  // ── 4. Mix ──
  // 经 MCP 核对: Mix.blend=MIX, factor=angle, A=原色, B=压暗色
  let mixed = mix(texColor.rgb, darkened, angle);

  // ── 5. 校色 (C曲线 + HSV×1.85) ──
  let corrected = color_correct(mixed);

  var out: FSOut;
  out.color = vec4f(corrected, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
