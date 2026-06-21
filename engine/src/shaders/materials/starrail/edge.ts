// sr_edge — StarRail NPR 描边 shader（占位）。
//
// ⚠️ engine.ts 的 drawOutlines 用的是固定的 outlinePipeline（非 SR），
// srEdgePipeline 虽然创建了但实际未被调用（edge drawCall 走 drawOutlines）。
// 此文件目前是占位，确保 import 不会报错。
// 后续可改为真正的 NPR 描边（ILM + ramp 风格化描边颜色）。

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_EDGE_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  // 简单描边：使用贴图颜色暗化作为描边色
  let texColor = textureSample(colorTexture, srSampler, input.uv);
  let edgeColor = texColor.rgb * 0.3;  // 暗化

  var out: FSOut;
  out.color = vec4f(edgeColor, srMaterial.alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
