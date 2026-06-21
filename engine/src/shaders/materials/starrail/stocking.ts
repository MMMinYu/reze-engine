// sr_stocking — 丝袜 NPR 材质预设。
//
// 复现 SockAIO/SockV3 shader 的纤维覆盖率 + 厚度 + SDF 阴影。
// 使用专用的丝袜贴图（SDFLut、sock_tiled_direction/normal/sdf、Substance_graph_FurLayer）。
//
// ⚠️ 此 shader 暂时为基本实现。完整的丝袜纤维渲染需要额外的贴图绑定扩展。

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_STOCKING_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;

  // 基础纹理采样
  let texColor = textureSample(colorTexture, srSampler, input.uv);
  let ilmColor = textureSample(ilmTexture, srSampler, input.uv);

  // 校色
  let corrected = color_correct(texColor.rgb);

  // 虚拟日光
  let sunVal = virtual_sun(n, l, ilmColor.g);

  // Ramp
  let rampColor = ramp_lookup(sunVal, ilmColor.a, rampTexture, srSampler);

  // 基础合成
  let finalColor = corrected * rampColor;

  var out: FSOut;
  out.color = vec4f(finalColor, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
