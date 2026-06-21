// Decal material — 纹理 alpha 贴花（纹身、脸红叠加层等）。
//
// 与 default 的区别：
// 1. 忽略 material.alpha（PMX diffuse alpha），用纹理 alpha 控制可见性
// 2. 极低 alpha 像素 discard（完全透明区域不渲染，避免遮挡）
// 3. 输出纹理 alpha 做 alpha-blend（半透明区域与底层混合，如脸红的渐变）
//
// 适用场景（经 MCP 验证）：
//   颜赤（颜赤.tga: RGB=(1,0.72,0.70) 粉红, alpha=0.6-0.7 半透明叠加层）
//   淫纹（bq.png: 大部分透明, 纹身图案 alpha=0.5-1.0）

import { NODES_WGSL } from "./nodes"
import { COMMON_MATERIAL_PRELUDE_WGSL } from "./common"

export const DECAL_SHADER_WGSL = /* wgsl */ `

${NODES_WGSL}
${COMMON_MATERIAL_PRELUDE_WGSL}

const DEFAULT_SPECULAR: f32 = 0.5;
const DEFAULT_ROUGHNESS: f32 = 0.5;

@fragment fn fs(input: VertexOutput) -> FSOut {
  let tex = textureSample(diffuseTexture, diffuseSampler, input.uv);
  // 完全透明的像素丢弃（避免无意义的 blend 写入）
  if (tex.a < 0.01) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;
  let sun = light.lights[0].color.xyz * light.lights[0].color.w;
  let amb = light.ambientColor.xyz;
  let shadow = sampleShadow(input.worldPos, n);

  let albedo = tex.rgb;

  let color = eval_principled(
    PrincipledIn(albedo, 0.0, DEFAULT_SPECULAR, DEFAULT_ROUGHNESS, 1e30, 0.0, 0.0),
    n, l, v, sun, amb, shadow
  );

  var out: FSOut;
  // 输出纹理 alpha，让渲染通道的 alpha-blend 正确混合半透明贴花
  out.color = vec4f(color, tex.a);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
