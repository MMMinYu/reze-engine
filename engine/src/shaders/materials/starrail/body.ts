// SR_Body — StarRailShader.身体变体_v17 移植。
// 复现"风堇1.0_私模"预设的身体皮肤 NPR。
//
// Blender 节点图数据流（StarRailShader.身体变体_v17, 经 MCP 核对）：
//   Color → 校色(C曲线 + HSV×1.85)
//   ILM → Green → 虚拟日光(smoothstep(0,0.2,G) × NdotL → 平方)
//   虚拟日光 → ramp(Value, alpha=ILM_alpha) → ramp.clothes(WarmRamp)
//   SDF.tex → 鼻尖阴影
//   校色 × ramp × 鼻尖阴影 → 输出
//
// ⚠️ 经 MCP 核对: 顶点 Map Range From 0,1 → To 0.15,0.99（非恒等！）

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_BODY_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;

  // ── 1. 校色 (C曲线 + HSV Value×1.85) ──
  let texColor = textureSample(colorTexture, srSampler, input.uv);
  let corrected = color_correct(texColor.rgb);

  // ── 2. ILM 解码 (ilm.clothes) ──
  let ilmColor = textureSample(ilmTexture, srSampler, input.uv);

  // ── 3. 虚拟日光 (半兰伯特 + 平方) ──
  let sunVal = virtual_sun(n, l, ilmColor.g);

  // ── 4. Ramp 着色 ──
  // MCP 核对: 外层 Map Range From 0,1 → To 0.15,0.99，然后进入 ramp 子组（inner 0.02,0.99）。
  let sunMapped = 0.15 + saturate(sunVal) * 0.84;
  let rampColor = ramp_lookup(sunMapped, ilmColor.a, rampTexture, srSampler);

  // ── 5. 鼻尖阴影 ──
  let sdfColor = textureSample(sdfTexture, srSampler, input.uv);
  let noseShadow = nose_shadow(sdfColor.rgb, n, v);

  // ── 6. 合成 (两次 MULTIPLY) ──
  let base = corrected * rampColor;
  let withShadow = base * noseShadow;

  var out: FSOut;
  // 响应 Engine 的 sun strength 设置（基准 5.0）
  let brightnessScale = light.lights[0].color.w / 5.0;
  out.color = vec4f(withShadow * brightnessScale, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
