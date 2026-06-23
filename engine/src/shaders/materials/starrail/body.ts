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

  // ── 1. 校色 (C曲线 + HSV Value×1.85) ──
  let texColor = textureSample(colorTexture, srSampler, input.uv);
  let corrected = color_correct(texColor.rgb);

  // ── 2. ILM 解码 (ilm.clothes) ──
  let ilmColor = textureSample(ilmTexture, srSampler, input.uv);

  // ── 3. 虚拟日光 (半兰伯特 + 平方) ──
  // MCP 核对: 身体变体_v17 里 ilm.clothes/ilm.hair 输出未连接。
  // 虚拟日光的 Image 输入 = 固定灰色 (0.8,0.8,0.8)，不是 LightMap。
  // Green=0.8 → smoothstep(0,0.2,0.8)=1.0。LightMap 纹路不影响身体光照。
  // MCP 核对: SUN 属性通过几何节点修改器动态设置 = 灯光.001 的旋转方向
  // SUN (Y-up) = -light.lights[0].direction.xyz = (0.296, 0.500, -0.814)
  let sunVal = virtual_sun(n, -light.lights[0].direction.xyz, 0.8);

  // ── 4. Ramp 着色 ──
  // MCP 核对: ramp 子组的 alpha 输入 = 0.0（未连接），不是 ilmColor.a。
  let sunMapped = 0.15 + saturate(sunVal) * 0.84;
  let rampColor = ramp_lookup(sunMapped, 0.0, rampTexture, srSampler);

  // ── 5. 鼻尖阴影 ──
  let sdfColor = textureSample(sdfTexture, srSampler, input.uv);
  let noseShadow = nose_shadow(sdfColor.rgb, n, v);

  // ── 6. 合成 (两次 MULTIPLY) ──
  let base = corrected * rampColor;
  let withShadow = base * noseShadow;

  // ── 7. Ambient 补偿 ──
  // Blender Cycles 的 World Background (0.05) 通过间接光照为 emission 材质提供环境光。
  // 引擎无间接光照，添加 ambient 项补偿整体暗度。
  let ambient = light.ambientColor.xyz * corrected;

  var out: FSOut;
  // 响应 Engine 的 sun strength 设置（基准 5.0）
  let brightnessScale = light.lights[0].color.w / 5.0;
  out.color = vec4f((withShadow + ambient) * brightnessScale, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
