// sr_stocking — 丝袜材质（SockAIO.021 + SockV3.027 逐节点精确复现）。
//
// 经 MCP 全子组展开验证（2026-06-22），10 个子节点组全部无黑盒实现：
//   SockAIO.021 → SockV3.027 → {UVByRatio, AdjustCellUV, BuildCellUV,
//   MappingSDF, ViewDependentCoverage} + ThighhighsInfoGen + PantyhoseThicknessSelector
//
// 关键 Blender 事实（全部经 MCP 验证）：
//   - Type=Pantyhose: Mix.002 Factor=0 → BaseColor=纯白(1,1,1)
//   - Float Curve Factor = 1-BW(白色) = 0 → 所有曲线输出固定常量
//   - FiberWidth=0.03, FiberThickness=0.025×10=0.25, FurAmount=0.01×5=0.05
//   - IsFiber = MappingSDF.Out（标量，非 Direction 贴图）
//   - Alpha = thickness_gate × fiber_coverage
//   - Roughness = mix(0.85, 0.35, (1-FiberWidth)×IsFiber)
//   - Glossy BSDF 不渲染（Add Shader 输出未连接）
//   - UVScale 内部乘 0.6667 后才传给 SockV3
//   - 3 张 sock_tiled 贴图共用相同 adjustedUV（经 cell pattern + noise 扰动）

import { COMMON_BINDINGS_GROUP01_WGSL, SAMPLE_SHADOW_WGSL, COMMON_VS_WGSL, COMMON_FS_OUT_WGSL } from "../common"
import { NODES_WGSL } from "../nodes"

export const STOCKING_MATERIAL_UNIFORM_SIZE = 48

export const STOCKING_BINDINGS_WGSL = /* wgsl */ `

struct StockingMaterialUniforms {
  uvScale: f32,             // 白裤袜=3000, 吊带袜_丝袜=3734
  sockLength: f32,          // 0.75
  cuffLength: f32,          // 0.03
  transmissionWeight: f32,  // 0.3 (Principled Transmission)
  subsurfaceWeight: f32,    // 0.4 (Principled Subsurface)
  roughness: f32,           // 0.35 (Group Input Roughness, Mix.010 的 B 端)
  tensionIntensity: f32,    // 0.8
  thicknessAdjust: f32,     // (SockThickness-0.5)×3, PMX 无属性 → 0
  uvRatio: f32,             // 0.3
  anisotropicRotation: f32, // 0.75
  _pad0: f32,
  _pad1: f32,
}

@group(2) @binding(0) var colorTexture: texture_2d<f32>;
@group(2) @binding(1) var<uniform> sockMaterial: StockingMaterialUniforms;
@group(2) @binding(2) var sockSdfTexture: texture_2d<f32>;
@group(2) @binding(3) var sockDirectionTexture: texture_2d<f32>;
@group(2) @binding(4) var sockNormalTexture: texture_2d<f32>;
@group(2) @binding(5) var thicknessTexture: texture_2d<f32>;
@group(2) @binding(6) var furLayerTexture: texture_2d<f32>;
@group(2) @binding(7) var sdfLutTexture: texture_2d<f32>;
@group(2) @binding(8) var sockSampler: sampler;

`

export const SR_STOCKING_SHADER_WGSL = /* wgsl */ `

${NODES_WGSL}
${COMMON_BINDINGS_GROUP01_WGSL}
${STOCKING_BINDINGS_WGSL}
${SAMPLE_SHADOW_WGSL}
${COMMON_VS_WGSL}
${COMMON_FS_OUT_WGSL}

// ═══════════════════════════════════════════════════════════════════
// UVByRatio.028 — UV 缩放
// ═══════════════════════════════════════════════════════════════════
// X = UV.x × FiberUVRatio × FiberUVScale
// Y = UV.y × FiberUVScale
fn uv_by_ratio(uv: vec2f, ratio: f32, scale: f32) -> vec2f {
  return vec2f(uv.x * ratio * scale, uv.y * scale);
}

// ═══════════════════════════════════════════════════════════════════
// AdjustCellUV.028 — 逐节点精确实现（19 个 Math 节点）
// ═══════════════════════════════════════════════════════════════════
struct AdjustCellUVOut {
  threadLUV: f32,
  knotUV: f32,
  threadRUV: f32,
}

fn adjust_cell_uv(uvx: f32, threadLength: f32) -> AdjustCellUVOut {
  var out: AdjustCellUVOut;

  // Math: ThreadLength × 2.0
  let m_math = threadLength * 2.0;
  // Math.001: 1.0 - Math
  let m001 = 1.0 - m_math;
  // Reroute.001 = Math.001（cellWidth）
  let cellWidth = m001;

  // ThreadLUV:
  // Math.002: UV.x < ThreadLength ? 1 : 0
  let m002 = select(0.0, 1.0, uvx < threadLength);
  // Math.003: UV.x / ThreadLength
  let m003 = uvx / max(threadLength, 1e-6);
  // Math.004: Math.002 × Math.003
  out.threadLUV = m002 * m003;

  // KnotUV:
  // Math.006: ThreadLength + cellWidth
  let m006 = threadLength + cellWidth;
  // Math.005: UV.x < Math.006 ? 1 : 0
  let m005 = select(0.0, 1.0, uvx < m006);
  // Math.007: UV.x > ThreadLength ? 1 : 0
  let m007 = select(0.0, 1.0, uvx > threadLength);
  // Math.008: Math.005 × Math.007
  let m008 = m005 * m007;
  // Math.011: UV.x - ThreadLength
  let m011 = uvx - threadLength;
  // Math.018: Math.011 / cellWidth
  let m018 = m011 / max(abs(cellWidth), 1e-6) * sign(cellWidth);
  // Math.019: Math.008 × Math.018
  out.knotUV = m008 * m018;

  // ThreadRUV:
  // Math.012: ThreadLength + cellWidth (= Math.006)
  let m012 = m006;
  // Math.009: UV.x > Math.012 ? 1 : 0
  let m009 = select(0.0, 1.0, uvx > m012);
  // Math.014: 1.0 - UV.x
  let m014 = 1.0 - uvx;
  // Math.015: Math.014 / ThreadLength
  let m015 = m014 / max(threadLength, 1e-6);
  // Math.016: 1.0 - Math.015
  let m016 = 1.0 - m015;
  // Math.010: Math.009 × Math.016
  out.threadRUV = m009 * m016;

  return out;
}

// ═══════════════════════════════════════════════════════════════════
// BuildCellUV.028 — 逐节点精确实现（Value=0.2）
// ═══════════════════════════════════════════════════════════════════
fn build_cell_uv(threadL: f32, knot: f32, threadR: f32) -> f32 {
  let val: f32 = 0.2;  // ShaderNodeValue 常量

  // ThreadL pattern:
  // Math: ThreadL × Value
  let mL = threadL * val;
  // Math.005: Value × 2.0 = 0.4
  let m005 = val * 2.0;
  // Math.006: 1.0 - Math.005 = 0.6
  let m006 = 1.0 - m005;

  // Knot pattern:
  // Math.001: Knot > 0.0 ? 1 : 0
  let m001 = select(0.0, 1.0, knot > 0.0);
  // Math.003: Knot × Math.006
  let m003 = knot * m006;
  // Math.002: Math.003 + Value
  let m002 = m003 + val;
  // Math.004: Math.001 × Math.002
  let m004 = m001 * m002;

  // ThreadR pattern:
  // Math.009: ThreadR > 0.0 ? 1 : 0
  let m009 = select(0.0, 1.0, threadR > 0.0);
  // Math.008: ThreadR × Value
  let m008 = threadR * val;
  // Math.013: 1.0 - Value = 0.8
  let m013 = 1.0 - val;
  // Math.007: Math.008 + Math.013
  let m007 = m008 + m013;
  // Math.010: Math.009 × Math.007
  let m010 = m009 * m007;

  // Math.011: Math(ThreadL×Value) + Math.004
  let m011 = mL + m004;
  // Math.012: Math.011 + Math.010
  let m012 = m011 + m010;

  return m012;
}

// ═══════════════════════════════════════════════════════════════════
// MappingSDF.028 — SDF smoothstep 映射（5次多项式 smoothstep）
// ═══════════════════════════════════════════════════════════════════
// Clamp: clamp(FiberWidth, 0, 1)
// Math.001: 1.0 - Clamp → min
// Math: Clamp × Softness → softness_part
// Math.002: min + softness_part → max = (1-fw) + fw×softness
// SmoothStep: t³ × (t × (t × 6 - 15) + 10)  [5次多项式，非 WGSL 内置 3 次]
fn _smoothstep5(min_val: f32, max_val: f32, x: f32) -> f32 {
  var t = (x - min_val) / max(max_val - min_val, 1e-6);
  t = clamp(t, 0.0, 1.0);
  return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

fn mapping_sdf(sdf: f32, fiberWidth: f32) -> f32 {
  let fw = clamp(fiberWidth, 0.0, 1.0);
  let softness: f32 = 0.03;
  let mn = 1.0 - fw;
  let mx = mn + fw * softness;
  return _smoothstep5(mn, mx, sdf);
}

// ═══════════════════════════════════════════════════════════════════
// ViewDependentCoverage.028 — 视角相关覆盖（逐节点精确实现）
// ═══════════════════════════════════════════════════════════════════
// NdotV = clamp(dot(Normal, Incoming), 0, 1)
// Math: 1.0 - Thickness                  → offset
// Math.001: NdotV × offset               → scaled
// Math.002: scaled + Thickness           → adjusted = NdotV×(1-t) + t
// Math.004: NdotV / adjusted (DIVIDE)    → ratio
// Math.003: 1.0 - ratio                  → factor
// Mix: mix(Coverage, 1.0, factor)
fn view_dependent_coverage(coverage: f32, thickness: f32, NdotV: f32) -> f32 {
  let offset = 1.0 - thickness;                    // Math
  let scaled = NdotV * offset;                     // Math.001
  let adjusted = scaled + thickness;                // Math.002 = NdotV×(1-t)+t
  let ratio = NdotV / max(adjusted, 1e-6);          // Math.004
  let factor = clamp(1.0 - ratio, 0.0, 1.0);        // Math.003
  return mix(coverage, 1.0, factor);                // Mix
}

// ═══════════════════════════════════════════════════════════════════
// ThighhighsInfoGen.023 — 区域计算
// ═══════════════════════════════════════════════════════════════════
struct ThighInfo {
  mask: f32,
  cuffMask: f32,
  bodyMask: f32,
  bodyUvY: f32,
}

fn thighhighs_info(uv: vec2f, sockLength: f32, cuffLength: f32) -> ThighInfo {
  var info: ThighInfo;
  let height = uv.y;
  // Math.005: height < sockLength ? 1 : 0
  info.mask = select(0.0, 1.0, height < sockLength);
  // Math.010: sockLength - cuffHeight
  let cuffStart = sockLength - cuffLength;
  // Math.007: height > cuffStart ? 1 : 0
  let m007 = select(0.0, 1.0, height > cuffStart);
  // Math.008: mask × m007
  info.cuffMask = info.mask * m007;
  // Math.011: mask - cuffMask
  info.bodyMask = info.mask - info.cuffMask;
  // BodyUV.Y = abs(height - cuffStart)（Math.015 → Math.006 ABSOLUTE）
  info.bodyUvY = abs(height - cuffStart);
  return info;
}

// ═══════════════════════════════════════════════════════════════════
// CustomThickness Float Curve（外部节点，PTS Alpha → thickness）
// 曲线: (0,0.0625)→(0.5007,1.0186)→(0.5315,1.8509)→(1,1.8125)
// ═══════════════════════════════════════════════════════════════════
fn custom_thickness_curve(bodyUvY: f32) -> f32 {
  let t = clamp(bodyUvY, 0.0, 1.0);
  if (t < 0.5007) { return mix(0.0625, 1.0186, t / 0.5007); }
  if (t < 0.5315) { return mix(1.0186, 1.8509, (t - 0.5007) / 0.0308); }
  return mix(1.8509, 1.8125, (t - 0.5315) / 0.4685);
}

// ═══════════════════════════════════════════════════════════════════
// Blender Noise 近似实现（使用 nodes.ts 的 _noise3）
// ═══════════════════════════════════════════════════════════════════
// _noise3 返回 [-1,1]，需映射到 [0,1]
fn _n3_01(p: vec3f) -> f32 {
  return clamp(_noise3(p) * 0.5 + 0.5, 0.0, 1.0);
}

// Noise Texture 3D, detail=0, roughness=0
// Blender detail=0 时仅 1 个 octave，无 roughness 衰减
fn blender_noise_3d(p: vec3f, scale: f32, distortion: f32) -> f32 {
  var q = p;
  if (abs(distortion) > 1e-6) {
    // Blender distortion: 用 noise 在三轴上偏移
    let dx = _n3_01(p * scale * 1.37 + vec3f(2.31, 5.17, 8.09));
    let dy = _n3_01(p * scale * 1.37 + vec3f(5.17, 8.09, 2.31));
    let dz = _n3_01(p * scale * 1.37 + vec3f(8.09, 2.31, 5.17));
    q = p + (vec3f(dx, dy, dz) * 2.0 - 1.0) * distortion;
  }
  return _n3_01(q * scale);
}

// Noise Texture 2D, detail=2, roughness=0, lacunarity=2
// 2D 退化为 3D 的 z=0 切片
fn blender_noise_2d(p: vec2f, scale: f32, distortion: f32) -> f32 {
  var q = vec3f(p, 0.0);
  if (abs(distortion) > 1e-6) {
    let dx = _n3_01(vec3f(p, 0.0) * scale * 1.37 + vec3f(2.31, 5.17, 8.09));
    let dy = _n3_01(vec3f(p, 0.0) * scale * 1.37 + vec3f(5.17, 8.09, 2.31));
    q = vec3f(p, 0.0) + (vec3f(dx, dy, 0.0) * 2.0 - 1.0) * distortion;
  }
  let c = q * scale;
  // detail=2 → 3 个 octave（detail+1）
  let v = _noise3(c) + 0.5 * _noise3(c * 2.0) + 0.25 * _noise3(c * 4.0);
  return v * (1.0 / 1.75) * 0.5 + 0.5;
}

// ═══════════════════════════════════════════════════════════════════
// Wyman Hashed Alpha Testing
// ═══════════════════════════════════════════════════════════════════
fn _hash_wm(a: vec2f) -> f32 {
  return fract(1e4 * sin(17.0 * a.x + 0.1 * a.y) * (0.1 + abs(sin(13.0 * a.y + a.x))));
}
fn _hash3d_wm(a: vec3f) -> f32 {
  return _hash_wm(vec2f(_hash_wm(a.xy), a.z));
}
fn hashed_alpha_threshold(co: vec3f) -> f32 {
  let max_deriv = max(length(dpdx(co)), length(dpdy(co)));
  let pix_scale = 1.0 / max(max_deriv, 1e-6);
  let pix_scale_log = log2(pix_scale);
  let px_lo = exp2(floor(pix_scale_log));
  let px_hi = exp2(ceil(pix_scale_log));
  let a_lo = _hash3d_wm(floor(px_lo * co));
  let a_hi = _hash3d_wm(floor(px_hi * co));
  let fac = fract(pix_scale_log);
  let x = mix(a_lo, a_hi, fac);
  let a = min(fac, 1.0 - fac);
  let one_a = 1.0 - a;
  let denom = 1.0 / max(2.0 * a * one_a, 1e-6);
  let one_x = 1.0 - x;
  let case_lo = (x * x) * denom;
  let case_mid = (x - 0.5 * a) / max(one_a, 1e-6);
  let case_hi = 1.0 - (one_x * one_x) * denom;
  var threshold = select(case_hi, select(case_lo, case_mid, x >= a), x < one_a);
  return clamp(threshold, 1e-6, 1.0);
}

// ═══════════════════════════════════════════════════════════════════
// ENTRY POINT
// ═══════════════════════════════════════════════════════════════════
@fragment fn fs(input: VertexOutput) -> FSOut {
  let n = normalize(input.normal);
  let v = normalize(camera.viewPos - input.worldPos);
  let l = -light.lights[0].direction.xyz;
  let sun = light.lights[0].color.xyz * light.lights[0].color.w;
  let amb = light.ambientColor.xyz;
  let shadow = sampleShadow(input.worldPos, n);
  let NdotV = clamp(dot(n, v), 0.0, 1.0);

  // ═══ 1. UVScale 内部乘 0.6667（Math.011） ═══
  let fiberUVScale = sockMaterial.uvScale * 0.6666659712791443;

  // ═══ 2. UVByRatio ═══
  let fiberUV = uv_by_ratio(input.uv, sockMaterial.uvRatio, fiberUVScale);

  // ═══ 3. ThighhighsInfoGen ═══
  let region = thighhighs_info(input.uv, sockMaterial.sockLength, sockMaterial.cuffLength);

  // ═══ 4. 厚度链 ═══
  // 外部 PantyhoseThicknessSelector (Index="5") → cf_panst_02_t.png Alpha(0,0)=0.5686
  // 外部 Float Curve(0.5686) ≈ 1.65 → CustomThickness
  // Math.004: clamp(1.65 + ThicknessAdjust, 0, 1) = 1.0
  // thickness 只控制 alpha gate（>0.1 则渲染），不影响纤维参数
  let thicknessSample = textureSample(thicknessTexture, sockSampler, vec2f(0.0, 0.0));
  let customThickness = custom_thickness_curve(thicknessSample.a);
  let thickness = clamp(customThickness + sockMaterial.thicknessAdjust, 0.0, 1.0);

  // ═══ 5. Float Curve（Factor=0 因 BaseColor=白 → 输出=0 → 后续曲线在 x=0 采样）═══
  // 纤维参数是固定常量，不由 thickness 驱动
  let fiberWidth: f32 = 0.03;        // Float Curve.001 at x=0
  let fiberThickness: f32 = 0.025 * 10.0;  // Float Curve.002 at x=0, then ×10
  let furAmount: f32 = 0.01 * 5.0;         // Float Curve.003 at x=0, then ×5

  // ═══ 6. SockV3 纤维覆盖率 ═══
  // Separate XYZ(fiberUV) → X, Y
  let fuvx = fiberUV.x;
  let fuvy = fiberUV.y;
  // Math(FRACT, X) → cellUvx
  let cellUvx = fract(fuvx);

  // Noise Texture(3D, Generated×(0.14,0.18,1), scale=10, detail=0, distortion=0.52)
  // PMX 无 Generated 坐标 → 用 input.worldPos 近似
  let noisePos = input.worldPos * vec3f(0.14, 0.18, 1.0);
  let noise3d = blender_noise_3d(noisePos, 10.0, 0.52);

  // Math.009(SockV3): TensionIntensity × 0.5 = 0.4
  let tensionScale = sockMaterial.tensionIntensity * 0.5;
  // Math.001(SockV3): Noise.Factor × tensionScale
  let threadLength = noise3d * tensionScale;

  // AdjustCellUV
  let cell = adjust_cell_uv(cellUvx, threadLength);
  // BuildCellUV
  let cellPattern = build_cell_uv(cell.threadLUV, cell.knotUV, cell.threadRUV);

  // Noise Texture.001(2D, fiberUV, scale=fiberUVScale, detail=2, distortion=0.4)
  let noise2d = blender_noise_2d(fiberUV, fiberUVScale, 0.4);
  // Math.003(SockV3): noise2d - 0.5
  let noiseOffset = noise2d - 0.5;
  // Math.004(SockV3): noiseOffset × 0.2
  let smallOffset = noiseOffset * 0.2;
  // Math.002(SockV3): smallOffset + cellPattern
  let adjustedX = smallOffset + cellPattern;

  // Combine XYZ(adjustedX, Y, 0) → adjustedUV
  let adjustedUV = vec2f(adjustedX, fuvy);

  // 3 张贴图共用 adjustedUV
  let sdfSample = textureSample(sockSdfTexture, sockSampler, adjustedUV);
  let normalTS_sample = textureSample(sockNormalTexture, sockSampler, adjustedUV);

  // Math.013(SockV3): 1.0 - Noise3d.Factor
  // 经 MCP 核对 (SockV3.027): Math.013 SUBTRACT(1.0, Noise Texture[Factor])
  // Noise Texture = 3D, scale=10, detail=0, distortion=0.52 → 即上方 noise3d
  let invFactor = 1.0 - noise3d;
  // Math.012(SockV3): FiberWidth × invFactor
  let scaledFiberWidth = fiberWidth * invFactor;

  // MappingSDF
  let sdfCoverage = mapping_sdf(sdfSample.r, scaledFiberWidth);

  // FurLayer（adjustedUV × 0.5）
  let furUV = adjustedUV * 0.5;
  let furSample = textureSample(furLayerTexture, sockSampler, furUV);
  // Math.005(SockV3): furColor × FurAmount（furColor.r 因为是灰度图）
  let furVal = furSample.r * furAmount;

  // Mix(SCREEN, 1.0, sdfCoverage, furVal)
  // SCREEN: A + B - A×B
  let finalCoverage = sdfCoverage + furVal - sdfCoverage * furVal;

  // ViewDependentCoverage
  let coverage = view_dependent_coverage(finalCoverage, fiberThickness, NdotV);

  // IsFiber = coverage（标量，经 Separate XYZ.001.X = Mix.001.Result = MappingSDF.Out）
  // 当 UseLut=0 时 Mix.001 Factor=0 → A=MappingSDF.Out
  let isFiber = sdfCoverage;

  // ═══ 7. Alpha ═══
  // Math(SockAIO): GREATER_THAN(Mix.005.Result, 0.1) = thickness > 0.1
  let thickness_gate = select(0.0, 1.0, thickness > 0.1);
  // Math.001(SockAIO): thickness_gate × Coverage
  let alpha = thickness_gate * coverage;

  // Blender EEVEE BLEND 模式使用直接 alpha 混合，不做 hashed discard

  // ═══ 8. 法线 bump ═══
  let tsNormal = normalTS_sample.rgb * 2.0 - 1.0;  // [0,1] → [-1,1]
  let dp1 = dpdx(input.worldPos);
  let dp2 = dpdy(input.worldPos);
  let duv1 = dpdx(input.uv);
  let duv2 = dpdy(input.uv);
  let r = 1.0 / max(duv1.x * duv2.y - duv1.y * duv2.x, 1e-8);
  let tbn_t = normalize((dp1 * duv2.y - dp2 * duv1.y) * r);
  let tbn_b = normalize((-dp1 * duv2.x + dp2 * duv1.x) * r);
  let tf = normalize(tbn_t - n * dot(n, tbn_t));
  let bf = normalize(tbn_b - n * dot(n, tbn_b) - tf * dot(tf, tbn_b));
  let bf2 = bf * sign(dot(cross(n, tf), bf));
  let nBumped = normalize(tf * tsNormal.x + bf2 * tsNormal.y + n * tsNormal.z);

  // ═══ 9. 皮肤透色（Transmission Weight=0.3）═══
  let texColor = textureSample(colorTexture, sockSampler, input.uv);
  let skinColor = texColor.rgb;
  let transNdotL = dot(nBumped, l);
  let skinLit = skinColor * (sun * max(transNdotL, 0.0) * shadow + amb);

  // ═══ 10. Roughness（Mix.010: mix(0.85, 0.35, (1-FiberWidth)×IsFiber)）═══
  // Math.026: 1 - FloatCurve.001(FiberWidth=0.03) = 0.97
  let m026 = 1.0 - fiberWidth;
  // Math.025: Math.026 × IsFiber
  let m025 = m026 * isFiber;
  // Mix.010: mix(A=0.85, B=GroupInput.Roughness=0.35, Factor=m025)
  let dynamicRoughness = mix(0.85, sockMaterial.roughness, clamp(m025, 0.0, 1.0));

  // ═══ 11. Specular Tint（Mix.011: mix(白, AnisotropicTint, m025)）═══
  // AnisotropicTint=(1,1,1) → 结果=(1,1,1) 无变化

  // ═══ 12. Subsurface Scale（Mix.008: mix(0.1, 0.001, Alpha)）═══
  let sssScale = mix(0.1, 0.001, clamp(alpha, 0.0, 1.0));

  // ═══ 13. Principled BSDF（白色织物）═══
  let fabric = eval_principled(
    PrincipledIn(vec3f(1.0), 0.0, 0.5, dynamicRoughness, 1e30, 0.02, 0.5),
    nBumped, l, v, sun, amb, shadow
  );

  // ═══ 14. 最终颜色 ═══
  // Transmission 0.3: 30% 透光显示皮肤
  let T = sockMaterial.transmissionWeight;
  // SSS 近似：用 wrapped lighting 模拟次表面散射
  let sssW = sockMaterial.subsurfaceWeight;
  let wrappedNdotL = (max(transNdotL, 0.0) + sssW * 0.5) / (1.0 + sssW * 0.5);
  let sssLight = skinColor * sun * shadow * wrappedNdotL * sssW * sssScale;

  var finalColor = fabric * (1.0 - T) + skinLit * T + sssLight;

  var out: FSOut;
  out.color = vec4f(finalColor, alpha);
  out.mask = vec4f(1.0, 1.0, 0.0, out.color.a);
  return out;
}

`
