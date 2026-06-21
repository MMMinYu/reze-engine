// SR_Hair — 星铁@Minyu-Shader.hair.001 精确移植。
//
// Blender 节点图数据流（经 MCP 完整核对 25 节点 28 连接）：
//   Color贴图 → 校色(C曲线 + HSV×1.85) → Mix.A(MULTIPLY)
//   ILM贴图 → SeparateColor:
//     Green → ColorRamp(0→黑,0.1→白) → CombineColor(R,G,B) → 虚拟日光.001(Image)
//     Blue → Math.001(* matcapDiv)
//   虚拟日光.001: dot(N, 2*SUN) → MapRange(-1,1→0,1) × smoothstep(0,0.2,green) → *0.5+0.5 → pow(2)
//   虚拟日光 → MapRange(0,1→0.02,0.99) → CombineXYZ(y=0.5) → ramp.hair.001 → Mix.B
//   Mix(A=校色, B=ramp, MULTIPLY) → Mix.001.A
//   matcap.hair.001 → Color→Float(luminance) → ÷0.05(clamp) → ×ilmBlue → ×(sunVal>0.85)
//     → MapRange.001(0,1→1.0,2.2) → Mix.001.B
//   Mix.001(A=corrected×ramp, B=matcapStrength, MULTIPLY) → Emission(Color)
//   hairmask*0.01 → MixShader factor (Transparent + Emission)
//
// ⚠️ MCP 核对修正:
//   - 虚拟日光最后是 平方(^2.0)，不是 sqrt
//   - Map Range: From 0,1 → To 0.02,0.99（非恒等！）
//   - ramp.hair 实际用 Warm Ramp（不是 Cool）
//   - Map Range.001: From 0,1 → To 1.0, 2.2（matcap 亮度乘数，非恒等！）
//   - matcap 链 IS 连接到 Group Output，通过 Mix.001(MULTIPLY) 参与最终颜色
//   - Mix.001 blend_type = MULTIPLY（不是 MIX）

import { STARRAIL_PRELUDE_WGSL } from "./starrail_prelude"

export const SR_HAIR_SHADER_WGSL = /* wgsl */ `

${STARRAIL_PRELUDE_WGSL}

// Pipeline-override: the engine creates two variants — the normal opaque sr_hair pipeline
// (IS_OVER_EYES=false) and a second pipeline that re-draws hair fragments stencil-matched
// against the eye stamp with 95% alpha so eyes read through the hair silhouette.
override IS_OVER_EYES: bool = false;

// DEBUG_MODE: 0=normal, 1=texColor, 2=corrected, 3=rampColor, 4=sunVal, 5=emissionColor
override DEBUG_MODE: u32 = 0u;

@fragment fn fs(input: VertexOutput) -> FSOut {
  let alpha = srMaterial.alpha;
  if (alpha < 0.001) { discard; }

  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let sunDir = -light.lights[0].direction.xyz;

  // ── 1. 纹理采样 ──
  let texColor = textureSample(colorTexture, srSampler, input.uv);
  let ilmColor = textureSample(ilmTexture, srSampler, input.uv);

  // ── 2. 校色 (RGB Curves C曲线 LUT + HSV Value×1.85) ──
  let corrected = color_correct(texColor.rgb);

  // ── 3. ILM 分色 ──
  let ilmGreen = ilmColor.g;
  let ilmBlue = ilmColor.b;

  // Green → Color Ramp: LINEAR, 0.0→黑, 0.1→白
  let greenRamp = saturate(ilmGreen * 10.0);
  // Combine Color(R=greenRamp, G=greenRamp, B=greenRamp) → 虚拟日光.001(Image)
  let imageForSun = vec3f(greenRamp, greenRamp, greenRamp);

  // ── 4. 虚拟日光.001 (半兰伯特 + 平方) ──
  // Attribute(SUN) → Scale(2.0) → dot(N, 2*SUN) → MapRange(-1,1→0,1)(恒等)
  let sun2 = sunDir * 2.0;
  let dotN2Sun = dot(n, sun2);
  let halfLambert = map_range(dotN2Sun, -1.0, 1.0, 0.0, 1.0);

  // Image.Green → smoothstep(0, 0.2, green) → Mix.B (MULTIPLY with halfLambert)
  let greenSmooth = smoothstep(0.0, 0.2, imageForSun.g);
  let mixHL = halfLambert * greenSmooth;

  // Math.003: MULTIPLY_ADD(val1=0.5, val2=0.5) → result = mixHL*0.5 + 0.5
  let step3 = mixHL * 0.5 + 0.5;

  // Math.001: POWER(2.0) → 平方 → 虚拟日光输出
  // ⚠️ 经 MCP 核对: 是平方(²)不是 sqrt(0.5)
  let sunVal = pow(step3, 2.0);

  // ── 5. Map Range → Ramp 采样 ──
  // MCP 核对: Map Range From 0,1 → To 0.02,0.99（非恒等！）
  let mappedHL = map_range(sunVal, 0.0, 1.0, 0.02, 0.99);
  // Combine XYZ: X=mappedHL, Y=0.5, Z=0.0
  let rampUV = vec2f(mappedHL, 0.5);
  // ramp.hair.001: Warm Ramp + RGB Curves C曲线 [(0,0),(0.5822,0.3427),(1,1)]
  let rampColor = ramp_hair_lookup(rampUV, rampTexture, srSampler);

  // ── 6. Matcap 亮度乘数 (1.0–2.2x) ──
  // matcap.hair.001 → Color→Float(luminance) → ÷0.05(clamp) → ×Blue → ×(sunVal>0.85)
  //   → MapRange.001(0,1→1.0,2.2) → Mix.001.B(MULTIPLY)
  // 当 specFinal=0 时乘数=1.0（无变化），specFinal=1 时乘数=2.2（提亮 2.2x）
  var matcapMul = 1.0;
  if (srMaterial.useMatcap > 0.5) {
    let matcapColor = matcap_sample(n, camera.view, matcapTexture, srSampler);
    // Blender Math DIVIDE 接收 Color→Value: 自动转换为 luminance (Rec.709)
    let matcapLum = dot(matcapColor, vec3f(0.2126, 0.7152, 0.0722));
    // Math(DIVIDE, ÷0.05, use_clamp=true)
    let matcapDiv = clamp(matcapLum / 0.05, 0.0, 1.0);
    // Math.001(MULTIPLY): matcapDiv × ilmBlue
    let matcapMulBlue = matcapDiv * ilmBlue;
    // Math.002(GREATER_THAN): sunVal > 0.85
    let specGate = select(0.0, 1.0, sunVal > 0.85);
    // Math.003(MULTIPLY): matcapMulBlue × specGate
    let specFinal = matcapMulBlue * specGate;
    // Map Range.001: [0,1] → [1.0, 2.2] (clamp=true)
    matcapMul = map_range(specFinal, 0.0, 1.0, 1.0, 2.2);
  }

  // ── 7. 最终混合 ──
  // Mix(MULTIPLY): A=校色, B=ramp → corrected × rampColor
  // Mix.001(MULTIPLY): A=Mix.Result, B=matcapStrength → corrected × rampColor × matcapMul
  // Emission(Color=Mix.001.Result, Strength=1.0) → Mix Shader
  let emissionColor = corrected * rampColor * matcapMul;

  // ── 8. Alpha: hairmask*0.01 → MixShader factor ──
  let hairAlpha = 1.0;  // 默认不透明

  // 软背面剔除: Blender 中头发材质启用 Backface Culling
  // 当法线背向相机时 (dot(N, V) < 0), 丢弃该片元
  var outAlpha = hairAlpha * alpha;
  if (dot(n, v) < 0.0) { discard; }
  if (IS_OVER_EYES) { outAlpha = outAlpha * 0.95; }

  var out: FSOut;
  // 响应 Engine 的 sun strength 设置（基准 5.0）
  let brightnessScale = light.lights[0].color.w / 5.0;
  switch DEBUG_MODE {
    case 1u: { out.color = vec4f(texColor.rgb * brightnessScale, outAlpha); }
    case 2u: { out.color = vec4f(corrected * brightnessScale, outAlpha); }
    case 3u: { out.color = vec4f(rampColor * brightnessScale, outAlpha); }
    case 4u: { out.color = vec4f(sunVal * brightnessScale, sunVal * brightnessScale, sunVal * brightnessScale, outAlpha); }
    case 5u: { out.color = vec4f(emissionColor * brightnessScale, outAlpha); }
    case 6u: { out.color = vec4f(ilmGreen * brightnessScale, ilmGreen * brightnessScale, ilmGreen * brightnessScale, outAlpha); }
    case 7u: { out.color = vec4f(greenSmooth * brightnessScale, greenSmooth * brightnessScale, greenSmooth * brightnessScale, outAlpha); }
    case 8u: { out.color = vec4f(halfLambert * brightnessScale, halfLambert * brightnessScale, halfLambert * brightnessScale, outAlpha); }
    default: { out.color = vec4f(emissionColor * brightnessScale, outAlpha); }
  }
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
