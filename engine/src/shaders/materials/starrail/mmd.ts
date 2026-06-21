// sr_mmd — MMD 标准材质（6 级颜色混合链）。
//
// 复现 MMDShaderDev 的颜色混合：ambient + diffuse × 0.6 → base/toon/sphere 混合 → specular。
// 这是 MMD 原版材质的标准渲染路径，用于配饰（bell、头饰、帽金属等）。
//
// ⚠️ engine.ts 有 import 但无 srMmdPipeline — 暂时此文件为占位，未接入渲染。

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_MMD_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let l = -light.lights[0].direction.xyz;

  // 基础纹理采样
  let texColor = textureSample(colorTexture, srSampler, input.uv);

  // 简单 Lambert + 环境光
  let ndotl = max(dot(n, l), 0.0);
  let ambient = vec3f(0.15);
  let diffuse = texColor.rgb * ndotl;
  let finalColor = ambient + diffuse;

  var out: FSOut;
  out.color = vec4f(finalColor, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
