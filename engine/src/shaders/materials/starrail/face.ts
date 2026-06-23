// sr_face — StarRailShader.face 移植（含 SDF 脸部阴影）。
//
// Blender 节点图（星铁@Minyu-Shader.face, 19 节点）经 MCP 核对的数据流：
//   color_correct(texColor) × ramp(SDF_mapped) × nose_shadow(sdfColor)
// 顶点 Map Range: From 0,1 → To 0.15,0.99，然后进入 ramp 子组（inner 0.02,0.99）。
//
// Group 输出 RGBA → Blender 视为 Emission（strength=1.0）

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_FACE_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);

  // ── 1. 纹理采样 + 校色 ──
  let texColor = textureSample(colorTexture, srSampler, input.uv);
  let corrected = color_correct(texColor.rgb);

  // ── 2. SDF 脸部阴影 ──
  // 经 MCP 核对: dot(RIGHT,SUN)>0 判断左右，动态阈值 dot_F*0.5+0.5
  // SUN 属性在 mesh 上不存在，Blender 默认 (0,0,0)；引擎用真实方向光驱动 SDF
  // 以获得正面光照效果（Blender 的 HDRI 环境光提供类似效果）。
  let l = -light.lights[0].direction.xyz;
  let sdfShadow = sdf_face_shadow(input.uv, srMaterial.faceFront, srMaterial.faceRight, l, sdfTexture, srSampler);

  // ── 3. Ramp 着色 ──
  // MCP 核对: 外层 Map Range From 0,1 → To 0.15,0.99，然后进入 ramp 子组（inner 0.02,0.99）。
  let rampMapped = 0.15 + saturate(sdfShadow) * 0.84;
  let rampColor = ramp_lookup(rampMapped, 0.0, rampTexture, srSampler);

  // ── 4. 鼻尖阴影 ──
  // 经 MCP 核对: SDF.tex 的 Color（非 baseColor）作为输入
  let sdfColor = textureSample(sdfTexture, srSampler, input.uv);
  let noseShadow = nose_shadow(sdfColor.rgb, n, v);

  // ── 5. 合成 ──
  let base = corrected * rampColor;
  let withShadow = base * noseShadow;

  var out: FSOut;
  // 响应 Engine 的 sun strength 设置（基准 5.0）
  let brightnessScale = light.lights[0].color.w / 5.0;
  // alpha: 取 material.alpha 与纹理 alpha 的较小值。
  // 颜.png alpha=1.0 → 不透明；颜赤.png alpha=0.6-0.7 → 半透明叠加。
  let effectiveAlpha = min(alpha, texColor.a);
  out.color = vec4f(withShadow * brightnessScale, effectiveAlpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
