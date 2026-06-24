// sr_special — 袖球材质（sphere mapping 预处理 + StarRailShader.clothes 完整管线）。
//
// 经 MCP 深入核对 Blender "袖球"材质完整节点树（2026-06-23）：
//
// 外层预处理（材质根节点树）：
//   1. Image Texture (Avatar_Hyacine_00_Body_Color_A_L.png) at base UV
//   2. Hue/Saturation/Value (Hue=0.5, Sat=0.9, Val=1.0, Fac=1.0) — 降饱和
//   3. 校色.003 (Group.002): RGB Curves C曲线 + HSV Value×1.85 — 外层 color_correct
//   4. MMDTexUV.004 Sphere UV: Normal → VECT_TRANSFORM(NORMAL, OBJECT→CAMERA)
//      → Mapping(Location=0.5,0.5,0; Scale=0.5,0.5,1.0)
//   5. mmd_sphere_tex (9.JPG) at sphere UV
//   6. Map Range (From 0→1, To 0.42→4.75, clamp=true, LINEAR) — sphere 增亮
//   7. Mix (RGBA, MULTIPLY, Factor=1.0): corrected1 × brightened_sphere
//
// StarRailShader.clothes-by@小二今天吃啥啊 组（Mix.Result → Group → Output）：
//   8.  Group.002 (校色.003): 内层 color_correct（与外层相同的 C曲线 + HSV×1.85）
//   9.  Mix.003 (MULTIPLY, Factor=COMPARE(|ilmAlpha-0.55|<=0.05)):
//       corrected2 × tint(1.0, 0.8608, 0.6069) when |alpha-0.55|<=0.05
//   10. Group.001 (虚拟日光.003): virtual_sun(n, SUN, ilmGreen)
//   11. Group.009 (ramp.004): ramp_lookup(sunVal, ilmAlpha)
//   12. Mix (MULTIPLY, Factor=1.0): tinted × rampColor
//   13. Blinn-Phong specular:
//       - Group (布林冯光照模型.003): dot(N, H) where H = normalize(Incoming + SUN)
//       - Math (POWER, 30): pow(dot(N,H), 30)
//       - Group.007 (smoothstep 0.06→0.10): smoothstep(0.06, 0.10, specPow)
//       - Math.002 (MULTIPLY): ilmGreen × ilmBlue
//       - Group.006 (smoothstep 0→1): smoothstep(0, 1, G×B)
//       - Mix.001 (MULTIPLY): specGate × specMask
//       - Map Range.001 (From 0→1, To 1→20, clamp): mix(1, 20, specIntensity)
//       - Mix.002 (MULTIPLY): base × specScaled
//   14. Mix.007 (ADD, Factor=0.25): base + 0.25 × Fresnel
//       — Fresnel 链路经 MCP 验证输出为 0（Image Texture.002 固定采样 (0,0) 像素，
//         Red=0, Green=0 → Mix.006=0 → Mix.007 = Mix.002），故省略。
//   15. Output → Material Output.Surface (RGBA→SHADER, emission-like)
//
// ⚠️ 关键修正（vs 旧实现）：
//   - Map Range To Max: 2.0 → 4.75（旧值严重偏低，sphere 增亮不足）
//   - 新增外层 color_correct（校色.003，旧实现完全缺失）
//   - 新增内层 color_correct（clothes 组内 Group.002，旧实现完全缺失）
//   - 新增完整 clothes 着色管线（tint + virtual_sun + ramp + specular）
//   - 新增 brightnessScale（与其他 sr_* 材质一致）
//
// ⚠️ 已知差异（无法在 special.ts 内修复）：
//   - 基础贴图：Blender 用 Avatar_Hyacine_00_Body_Color_A_L.png，
//     manifest.json 绑定为 衣.png（manifest 问题，需另行修复）
//   - Sphere UV 空间：Blender 用 VECT_TRANSFORM(OBJECT→CAMERA)，
//     引擎用 camera.view (WORLD→CAMERA)，模型有旋转时会有差异

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_SPECIAL_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;

  // ── 1. 基础贴图采样 ──
  let texColor = textureSample(colorTexture, srSampler, input.uv);

  // ── 2. 降饱和 (Blender HueSaturation: Hue=0.5, Sat=0.9, Val=1.0, Fac=1.0) ──
  // hue_sat_id(saturation, value, fac, color) — Hue=0.5 在 Blender 中表示无色相偏移
  let desaturated = hue_sat_id(0.9, 1.0, 1.0, texColor.rgb);

  // ── 3. 外层校色 (校色.003: RGB Curves C曲线 + HSV Value×1.85) ──
  let corrected1 = color_correct(desaturated);

  // ── 4. Sphere UV 计算 (MMDTexUV.004) ──
  // Blender: Normal → VECT_TRANSFORM(NORMAL, OBJECT→CAMERA) → Mapping(Scale=0.5, Loc=0.5)
  // 引擎: input.normal 是世界空间法线，用 camera.view 变换到相机空间
  // (近似 OBJECT→CAMERA；模型无旋转时等价)
  let normalCam = (camera.view * vec4f(n, 0.0)).xyz;
  let sphereUV = normalCam.xy * 0.5 + vec2f(0.5);

  // ── 5. Sphere 贴图采样 + 增亮 (MapRange: 0→0.42, 1→4.75, clamp=true) ──
  // ⚠️ 旧实现用 To Max=2.0，MCP 核对实际为 4.75
  let sphereSample = textureSample(matcapTexture, srSampler, sphereUV);
  let sphereVal = sphereSample.r;  // 9.JPG 是灰度图
  let brightened = mix(0.42, 4.75, sphereVal);  // MapRange 0→0.42, 1→4.75

  // ── 6. 乘法合成 (Mix MULTIPLY, Factor=1.0): corrected1 × brightened ──
  let mixed = corrected1 * brightened;

  // ── 7. 内层校色 (StarRailShader.clothes 内 Group.002 = 校色.003) ──
  // ⚠️ 旧实现完全缺失此步骤
  let corrected2 = color_correct(mixed);

  // ── 8. ILM 解码 (ilm.clothes.004: LightMap.png at mesh UV) ──
  let ilmColor = textureSample(ilmTexture, srSampler, input.uv);
  let ilm = ilm_decode(ilmColor);
  let ilmGreen = ilm.y;
  let ilmBlue = ilm.z;
  let ilmAlpha = ilm.w;

  // ── 9. Tint (Mix.003 MULTIPLY, Factor=Math.001 COMPARE) ──
  // Math.001: |ilmAlpha - 0.55| <= 0.05 ? 1.0 : 0.0
  // B = (1.0, 0.8608, 0.6069, 1.0) — 暖色 tint
  let tintFactor = select(0.0, 1.0, abs(ilmAlpha - 0.55) <= 0.05);
  let tintColor = vec3f(1.0, 0.8608, 0.6069);
  let tinted = mix(corrected2, corrected2 * tintColor, tintFactor);

  // ── 10. 虚拟日光 (虚拟日光.003: halfLambert × smoothstep(G) → ×0.5+0.5 → ²) ──
  let sunVal = virtual_sun(n, l, ilmGreen);

  // ── 11. Ramp 着色 (ramp.004: 8级toon色阶 + RGB Curves) ──
  let rampColor = ramp_lookup(sunVal, ilmAlpha, rampTexture, srSampler);

  // ── 12. 合成 (Mix MULTIPLY, Factor=1.0): tinted × rampColor ──
  let base = tinted * rampColor;

  // ── 13. Blinn-Phong specular ──
  // Blender 链路:
  //   布林冯光照模型.003: dot(N, H) where H = normalize(Incoming + SUN)
  //   Math (POWER, 30): pow(dot(N,H), 30)
  //   Group.007 (smoothstep 0.06→0.10): smoothstep(0.06, 0.10, specPow)
  //   Math.002 (MULTIPLY): ilmGreen × ilmBlue
  //   Group.006 (smoothstep 0→1): smoothstep(0, 1, G×B)
  //   Mix.001 (MULTIPLY): specGate × specMask
  //   Map Range.001 (From 0→1, To 1→20, clamp): mix(1, 20, specIntensity)
  //   Mix.002 (MULTIPLY): base × specScaled
  let specRaw = blinn_phong(n, v, l, 30.0);
  let specPow = pow(max(specRaw, 0.0), 30.0);
  let specGate = smoothstep_n(0.06, 0.10, specPow);
  let specMask = smoothstep_n(0.0, 1.0, ilmGreen * ilmBlue);
  let specIntensity = specGate * specMask;
  let specScaled = mix(1.0, 20.0, specIntensity);

  // ── 14. 最终合成 (Mix.002 MULTIPLY: base × specScaled) ──
  // Mix.007 (ADD 0.25 × Fresnel) 经 MCP 验证 Fresnel=0，故省略
  let finalColor = base * specScaled;

  var out: FSOut;
  out.color = vec4f(finalColor, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
