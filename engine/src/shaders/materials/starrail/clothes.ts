// SR_Clothes — StarRail 衣服 NPR 材质预设。
//
// 复现 StarRailShader.clothes。核心 NPR 技术栈：
//   1. ramp toon           — ramp LUT 色阶
//   2. clothes matcap      — Avatar_Tex_MetalMap 材质捕捉
//   3. ILM 控制            — R=AO, G=高光mask, B=阴影阈值, A=材质区域
//   4. 虚拟日光            — Half-Lambert + ILM G 通道门控 + 平方
//
// ⚠️ 经 MCP 核对:
//   - 虚拟日光直连 ramp.Value（无顶点 Map Range，恒等）
//   - matcap Map Range.001 是恒等 (0,1→0,1)
//   - ramp 实际采样 Warm Ramp

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_CLOTHES_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;

  // ── 1. 纹理采样 ──
  let texColor = textureSample(colorTexture, srSampler, input.uv);
  let ilmColor = textureSample(ilmTexture, srSampler, input.uv);

  // ── 2. 校色 ──
  let corrected = color_correct(texColor.rgb);

  // ── 3. ILM 解码 ──
  let ilm = ilm_decode(ilmColor);
  let ilmGreen = ilm.y;
  let ilmBlue = ilm.z;
  let ilmAlpha = ilm.w;

  // ── 4. 虚拟日光 ──
  let sunVal = virtual_sun(n, l, ilmGreen);

  // ── 5. Ramp 着色 ──
  let rampColor = ramp_lookup(sunVal, ilmAlpha, rampTexture, srSampler);

  // ── 6. Matcap 高光 ──
  var matcapAdd = vec3f(0.0);
  if (srMaterial.useMatcap > 0.5) {
    let matcapColor = matcap_sample(n, camera.view, matcapTexture, srSampler);
    let matcapLum = dot(matcapColor, vec3f(0.2126, 0.7152, 0.0722));
    let matcapDiv = clamp(matcapLum / 0.05, 0.0, 1.0);
    let matcapMulBlue = matcapDiv * ilmBlue;
    let specGate = select(0.0, 1.0, sunVal > 0.85);
    let specFinal = matcapMulBlue * specGate;
    matcapAdd = matcapColor * specFinal * 0.5;
  }

  // ── 7. 合成 ──
  let base = corrected * rampColor;
  let finalColor = base + matcapAdd;

  var out: FSOut;
  let brightnessScale = light.lights[0].color.w / 5.0;
  out.color = vec4f(finalColor * brightnessScale, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`

// SR_Clothes_Inner — 披肩+/披風+，法线翻转（mesh 法线指向体内）。
export const SR_CLOTHES_INNER_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  // 法线翻转：内层面料的法线指向体内，翻转后正确光照
  let n = -normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;

  // ── 1. 纹理采样 ──
  let texColor = textureSample(colorTexture, srSampler, input.uv);
  let ilmColor = textureSample(ilmTexture, srSampler, input.uv);

  // ── 2. 校色 ──
  let corrected = color_correct(texColor.rgb);

  // ── 3. ILM 解码 ──
  let ilm = ilm_decode(ilmColor);
  let ilmGreen = ilm.y;
  let ilmBlue = ilm.z;
  let ilmAlpha = ilm.w;

  // ── 4. 虚拟日光 ──
  let sunVal = virtual_sun(n, l, ilmGreen);

  // ── 5. Ramp 着色 ──
  let rampColor = ramp_lookup(sunVal, ilmAlpha, rampTexture, srSampler);

  // ── 6. Matcap 高光 ──
  var matcapAdd = vec3f(0.0);
  if (srMaterial.useMatcap > 0.5) {
    let matcapColor = matcap_sample(n, camera.view, matcapTexture, srSampler);
    let matcapLum = dot(matcapColor, vec3f(0.2126, 0.7152, 0.0722));
    let matcapDiv = clamp(matcapLum / 0.05, 0.0, 1.0);
    let matcapMulBlue = matcapDiv * ilmBlue;
    let specGate = select(0.0, 1.0, sunVal > 0.85);
    let specFinal = matcapMulBlue * specGate;
    matcapAdd = matcapColor * specFinal * 0.5;
  }

  // ── 7. 合成 ──
  let base = corrected * rampColor;
  let finalColor = base + matcapAdd;

  var out: FSOut;
  let brightnessScale = light.lights[0].color.w / 5.0;
  out.color = vec4f(finalColor * brightnessScale, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
