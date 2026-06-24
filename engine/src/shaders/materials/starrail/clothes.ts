// SR_Clothes — StarRail 衣服 NPR 材质预设。
//
// 复现 星铁@Minyu-Shader.clothes.001。核心 NPR 技术栈：
//   1. 校色 (color_correct)      — C曲线 + HSV Value×1.85
//   2. 虚拟日光 (virtual_sun)     — Half-Lambert + ILM G 通道门控 + 平方
//   3. smoothstep(0,1,sunVal)    — 平滑日光值
//   4. ramp toon (ramp_lookup)   — ramp LUT 色阶
//   5. tint (|alpha-0.55|<=0.05) — 暖色着色
//   6. Blinn-Phong specular      — dot(N,H)^30 → smoothstep → G×B → MapRange(1→20)
//   7. ILM 控制                  — R=AO, G=高光mask, B=阴影阈值, A=材质区域
//
// ⚠️ 经 MCP 核对 (2026-06-23):
//   - matcap (Group.003/004) 在 Blender 中未连接输出，已移除
//   - smoothstep(0,1,sunVal) 在 ramp 查找前，之前缺失
//   - tint (Mix.003) 当 |ilmAlpha-0.55|<=0.05 时乘暖色，之前缺失
//   - Blinn-Phong specular 链之前缺失，已添加
//   - Fresnel 加性 (Mix.007 ADD 0.25) 经 MCP 验证输出为 0，省略

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

  // ── 5. smoothstep(0,1,sunVal) — 平滑日光值 ──
  let sunSmooth = smoothstep_n(0.0, 1.0, sunVal);

  // ── 6. Ramp 着色 ──
  let rampColor = ramp_lookup(sunSmooth, ilmAlpha, rampTexture, srSampler);

  // ── 7. Tint (Mix.003: |ilmAlpha-0.55|<=0.05 ? 乘暖色) ──
  let tintFactor = select(0.0, 1.0, abs(ilmAlpha - 0.55) <= 0.05);
  let tintColor = vec3f(1.0, 0.8608, 0.6069);
  let tinted = mix(corrected, corrected * tintColor, tintFactor);

  // ── 8. 合成 base = tinted × rampColor ──
  let base = tinted * rampColor;

  // ── 9. Blinn-Phong specular ──
  // Blender 链路: blinn_phong(dot(N,H)) → pow(30) → smoothstep(0.06,0.10)
  //   → ×smoothstep(0,1,G×B) → MapRange(0,1→1,20) → base × specScaled
  let specRaw = blinn_phong(n, v, l, 30.0);
  let specPow = pow(max(specRaw, 0.0), 30.0);
  let specGate = smoothstep_n(0.06, 0.10, specPow);
  let specMask = smoothstep_n(0.0, 1.0, ilmGreen * ilmBlue * 0.5);
  let specIntensity = specGate * specMask;
  let specScaled = mix(1.0, 20.0, specIntensity);
  let finalColor = base * specScaled;

  var out: FSOut;
  out.color = vec4f(finalColor, alpha);
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

  // 经 MCP 核对 Blender: 内层 mesh 法线本来就朝内（背向相机），
  // Blender shader 不翻转法线。引擎与 Blender 保持一致，不翻转。
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

  // ── 5. smoothstep(0,1,sunVal) — 平滑日光值 ──
  let sunSmooth = smoothstep_n(0.0, 1.0, sunVal);

  // ── 6. Ramp 着色 ──
  let rampColor = ramp_lookup(sunSmooth, ilmAlpha, rampTexture, srSampler);

  // ── 7. Tint (Mix.003: |ilmAlpha-0.55|<=0.05 ? 乘暖色) ──
  let tintFactor = select(0.0, 1.0, abs(ilmAlpha - 0.55) <= 0.05);
  let tintColor = vec3f(1.0, 0.8608, 0.6069);
  let tinted = mix(corrected, corrected * tintColor, tintFactor);

  // ── 8. 合成 base = tinted × rampColor ──
  let base = tinted * rampColor;

  // ── 9. Blinn-Phong specular ──
  let specRaw = blinn_phong(n, v, l, 30.0);
  let specPow = pow(max(specRaw, 0.0), 30.0);
  let specGate = smoothstep_n(0.06, 0.10, specPow);
  let specMask = smoothstep_n(0.0, 1.0, ilmGreen * ilmBlue * 0.5);
  let specIntensity = specGate * specMask;
  let specScaled = mix(1.0, 20.0, specIntensity);
  let finalColor = base * specScaled;

  var out: FSOut;
  out.color = vec4f(finalColor, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}
`
