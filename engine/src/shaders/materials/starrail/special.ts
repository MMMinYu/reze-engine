// sr_special — 特殊材质（face_glow/sleeve_ball/rigid_body/bell）。
//
// 这些材质用简单的 NPR 渲染：校色 + 虚拟日光 + ramp。
//
// ⚠️ 此文件是占位实现，需要根据实际材质需求细化。

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_SPECIAL_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let l = -light.lights[0].direction.xyz;

  let texColor = textureSample(colorTexture, srSampler, input.uv);
  let corrected = color_correct(texColor.rgb);

  // 简单 Lambert + ramp
  let ilmColor = textureSample(ilmTexture, srSampler, input.uv);
  let sunVal = virtual_sun(n, l, ilmColor.g);
  let rampColor = ramp_lookup(sunVal, ilmColor.a, rampTexture, srSampler);

  let finalColor = corrected * rampColor;

  var out: FSOut;
  out.color = vec4f(finalColor, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
