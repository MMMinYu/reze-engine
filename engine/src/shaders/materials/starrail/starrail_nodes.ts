// StarRail NPR shader — shared WGSL node functions.
//
// Ports the sub-groups of the "风堇1.0_私模" StarRailShader preset (by 小二今天吃啥啊)
// from Blender's shader node graph to WGSL. Each function maps 1:1 to a sub-group
// documented in docs/starrail-shader-reference.md §3.
//
// Concatenation order for an sr_* material:
//   NODES_WGSL              (nodes.ts — base math/BSDF helpers; reused here)
//   COMMON_BINDINGS_WGSL    (uniform structs + @group/@binding declarations)
//   SAMPLE_SHADOW_WGSL      (3×3 PCF shadow sampler)
//   COMMON_VS_WGSL          (skinning vertex shader)
//   STARRAIL_BINDINGS_WGSL  (StarRail-specific group(2) bindings)
//   STARRAIL_NODES_WGSL     (this file — StarRail NPR helpers)
//   <material's own constants + @fragment fn fs>
//
// Textures and samplers are passed as function parameters — no @binding is declared
// here (bindings live in the host material's bind group). textureSample() calls are
// fragment-only, so every helper below is meant to be called from a @fragment entry.

export const STARRAIL_NODES_WGSL = /* wgsl */ `

// ─── smoothstep (子 Group: smoothstep) ──────────────────────────────
// Blender has no built-in smoothstep, so the original graph emulates it with ~19
// Math nodes (t = clamp((x-a)/(b-a)); t*t*(3-2t)). WGSL ships smoothstep() as a
// builtin, so this is a thin wrapper kept for 1:1 graph parity.

fn smoothstep_n(a: f32, b: f32, x: f32) -> f32 {
  return smoothstep(a, b, x);
}

// ─── 校色 / Color Correct (子 Group: 校色) ──────────────────────────
// Original chain: RGB Curves(C curve, all channels) → Hue/Saturation(hue=0.5, sat=1, value=1.85).
// hue=0.5 is identity in Blender (fract(h+0.5-0.5)=h), so only the C curve and
// the 1.85× value multiplier matter.
//
// The C curve has 5 control points with AUTO handles:
//   (0,0), (0.4109,0.1657), (0.6688,0.314), (0.8847,0.8052), (1,1)
// It applies to ALL channels (R, G, B) via Blender's RGB Curves node.
// LUT: 21 samples from Blender mapping.evaluate(), linearly interpolated.

fn _c_curve_lut(t: f32) -> f32 {
  let idx_f = saturate(t) * 20.0;
  let idx = i32(idx_f);
  let frac = idx_f - f32(idx);
  let LUT = array<f32, 21>(
    0.000000, 0.017663, 0.035504, 0.053784, 0.072819,
    0.092906, 0.114229, 0.136786, 0.160426, 0.183627,
    0.204616, 0.226526, 0.254368, 0.294495, 0.352857,
    0.439046, 0.574615, 0.726822, 0.834472, 0.921445,
    1.000000
  );
  let i0 = clamp(idx, 0, 19);
  let i1 = i0 + 1;
  return mix(LUT[i0], LUT[i1], frac);
}

fn color_correct(c: vec3f) -> vec3f {
  // Blender 校色 (子 Group: 校色):
  //   RGB Curves Combined 曲线实际等效于对 R/G/B 三通道独立应用同一条 C 曲线；
  //   然后 Hue/Saturation/Value 在 scene-linear 空间把 Value × 1.85。
  let curved = vec3f(_c_curve_lut(c.r), _c_curve_lut(c.g), _c_curve_lut(c.b));
  // HSV: Value × 1.85
  let hsv = rgb_to_hsv(curved);
  let result = hsv_to_rgb(vec3f(hsv.x, hsv.y, hsv.z * 1.85));
  return result;
}

// ─── 夹角判断 / View Angle Test (子 Group: 夹角判断) ────────────────
// dot(faceFront, sun) mapped from [-1,1] → [0,1]. Used to gate view-dependent
// regions (e.g. eyes). 经 MCP 核对: Map Range 恒等 (From 0,1 → To 0,1)，
// 负值 clamp 到 0。

fn view_angle_test(faceFront: vec3f, sun: vec3f) -> f32 {
  let d = dot(faceFront, sun);
  return saturate(d);
}

// ─── 布林冯光照模型 / Blinn-Phong (子 Group: 布林冯光照模型) ────────
// Half-vector Blinn-Phong specular.
// 经 MCP 核对: 只有 Value 输出,无 Color。节点链: ADD(Incoming, SUN) → NORMALIZE → DOT(Normal, H)。

fn blinn_phong(n: vec3f, v: vec3f, l: vec3f, power: f32) -> f32 {
  let h = normalize(l + v);
  let ndoth = max(dot(n, h), 0.0);
  return pow(ndoth, power);
}

// ─── 虚拟日光 / Virtual Sun — Half-Lambert (子 Group: 虚拟日光) ──────
// Half-Lambert wrap lighting modulated by the ILM green (spec mask) channel and
// reshaped into a soft toon terminator:
//   L_scaled = SUN * 2.0               # VectorMath.001 SCALE
//   dotNL = dot(N, L_scaled)           # VectorMath DOT_PRODUCT
//   half_lambert = map_range(dotNL, -1, 1, 0, 1)   # Map Range
//   green_smooth = smoothstep(0, 0.2, ilm_green)    # ILM G channel as shadow mask
//   mixed = half_lambert * green_smooth              # Mix MULTIPLY
//   step3 = mixed * 0.5 + 0.5                        # MULTIPLY_ADD
//   final = step3 ^ 2.0                               # POWER(_, 2.0) — 平方，不是开方！
//
// ⚠️ 经 MCP 核对: 最后是平方 (^2.0)，不是文档原写的 sqrt。平方让中间调压暗、对比度提升。
//
// ⚠️ 经 MCP 核对: Blender 材质用 Attribute(SUN) 读取名为 SUN 的几何属性，
// 但身体/头发 mesh 上并没有该属性 → Blender 返回默认值 (0,0,0)。
// 因此 SUN 始终为 0，整条链路退化为常数：
//   dot(N, 0) = 0 → MapRange(0; -1,1→0,1) = 0.5
//   green_smooth = smoothstep(0, 0.2, G) 仍由 ILM 控制
//   mixed = 0.5 * green_smooth → step3 = 0.25*green_smooth + 0.5
//   final = (0.25*green_smooth + 0.5)^2
// green_smooth 在无 ILM 贴图时按调用者传入的 0.8 计算 ≈ 1.0，
// 最终 ≈ 0.5625，与法线和场景 sun 方向无关。

fn virtual_sun(n: vec3f, l: vec3f, ilm_green: f32) -> f32 {
  // 动态半兰斯特光照: SUN → SCALE(2.0) → DOT(N, 2*SUN) → MapRange(-1,1→0,1)
  // 合并: halfLambert = saturate(dot(N, L) + 0.5)
  let half_lambert = saturate(dot(n, l) + 0.5);
  let green_smooth = smoothstep(0.0, 0.2, ilm_green);
  let mixed = half_lambert * green_smooth;
  let step3 = mixed * 0.5 + 0.5;
  return pow(step3, 2.0);
}

// ─── matcap / matcap.hair (子 Group: matcap, matcap.hair) ───────────
// Material capture: transform the world-space normal into view space, remap its
// xy from [-1,1] to [0,1] and sample the matcap sphere texture. matcap uses
// Avatar_Tex_MetalMap.tga; matcap.hair uses hair_s.bmp.
// viewMat is the camera view matrix (mat4x4f); w=0 drops the translation column,
// yielding the rotation-only normal transform (valid for orthonormal view matrices).

fn matcap_sample(n: vec3f, viewMat: mat4x4f, matcapTex: texture_2d<f32>, matcapSampler: sampler) -> vec3f {
  let nView = (viewMat * vec4f(n, 0.0)).xyz;
  let uv = nView.xy * 0.5 + vec2f(0.5);
  return textureSample(matcapTex, matcapSampler, uv).rgb;
}

// ─── ramp / ramp.hair — Toon 色阶 (子 Group: ramp, ramp.hair) ────────
// 1D ramp LUT sampled along u with v fixed at 0.5. The ramp texture encodes the
// toon shade bands (cool ramp for hair, clothes ramp for body/garments).
//
// 经 MCP 核对 ramp采样.002:
//   Value.007 = 0.125（乘数）
//   MULTIPLY_ADD: 0.125 * N + 0.025
//   7 档 GREATER_THAN 阈值: 0.10, 0.20, 0.33, 0.45, 0.58, 0.70, 0.85
//   N 值: 0.25, 1, 2, 3, 4, 5, 6, 7
//   V 值: 0.05625, 0.15, 0.275, 0.4, 0.525, 0.65, 0.775, 0.9

fn ramp_sample(alpha: f32) -> f32 {
  if (alpha > 0.85) { return 0.125 * 7.0 + 0.025; }  // 0.9
  if (alpha > 0.70) { return 0.125 * 6.0 + 0.025; }  // 0.775
  if (alpha > 0.58) { return 0.125 * 5.0 + 0.025; }  // 0.65
  if (alpha > 0.45) { return 0.125 * 4.0 + 0.025; }  // 0.525
  if (alpha > 0.33) { return 0.125 * 3.0 + 0.025; }  // 0.4
  if (alpha > 0.20) { return 0.125 * 2.0 + 0.025; }  // 0.275
  if (alpha > 0.10) { return 0.125 * 1.0 + 0.025; }  // 0.15
  return 0.125 * 0.25 + 0.025;                         // 0.05625
}

// ramp RGB Curves Combined 使用 AUTO 手柄贝塞尔曲线，分段线性近似误差达 0.097。
// 改用 21 点 LUT（与 _c_curve_lut 同方法），经 MCP mapping.evaluate() 采样。
fn _ramp_c1_lut(t: f32) -> f32 {
  let idx_f = saturate(t) * 20.0;
  let idx = i32(idx_f);
  let frac = idx_f - f32(idx);
  let LUT = array<f32, 21>(
    0.000000, 0.018768, 0.037717, 0.057061, 0.077070,
    0.098078, 0.120472, 0.144691, 0.171224, 0.200682,
    0.233504, 0.270136, 0.311146, 0.356581, 0.406740,
    0.461930, 0.525185, 0.601463, 0.699871, 0.833454,
    1.000000
  );
  let i0 = clamp(idx, 0, 19);
  let i1 = i0 + 1;
  return mix(LUT[i0], LUT[i1], frac);
}

fn _ramp_c2_lut(t: f32) -> f32 {
  let idx_f = saturate(t) * 20.0;
  let idx = i32(idx_f);
  let frac = idx_f - f32(idx);
  let LUT = array<f32, 21>(
    0.000000, 0.028377, 0.056969, 0.086059, 0.116019,
    0.147323, 0.180469, 0.215965, 0.254232, 0.295529,
    0.339911, 0.387233, 0.437248, 0.490287, 0.547153,
    0.608969, 0.676674, 0.750787, 0.830648, 0.914437,
    1.000000
  );
  let i0 = clamp(idx, 0, 19);
  let i1 = i0 + 1;
  return mix(LUT[i0], LUT[i1], frac);
}

fn ramp_lookup(value: f32, alpha: f32, rampTex: texture_2d<f32>, rampSampler: sampler) -> vec3f {
  // ramp 子组内部 Map Range: From 0,1 → To 0.02,0.99（经 MCP 核对）。
  // face/body 调用者在外层做了 [0,1]→[0.15,0.99]，此处再做 [0,1]→[0.02,0.99]。
  // clothes/stockings 没有外层 Map Range，直接进入此处。
  let mapped = 0.02 + saturate(value) * 0.97;
  let ramp_val = ramp_sample(alpha);
  // WebGPU V=0 对应纹理顶部，Blender V=0 对应底部。翻转 V 以匹配 Blender 行为。
  let uv = vec2f(mapped, 1.0 - ramp_val);
  // 方案3: 强制 mip level 0。ramp 贴图是 256x16 的细长 LUT，
  // mipmap 降采样会把色阶边界模糊， sdfShadow 的 0/1 硬切导致 UV 导数巨大，
  // GPU 自动选择高 mip level → 多条平行线。强制 level 0 保持原始精度。
  let ramp_color = textureSampleLevel(rampTex, rampSampler, uv, 0.0);

  // 经 MCP 核对: ramp.002 里的两个 RGB Curves 节点都只修改了 Combined (curve 3) 曲线，
  // Blender 的 RGB Curves Combined 行为等效于对 R/G/B 三通道独立应用同一条曲线。
  let first_curved = vec3f(_ramp_c1_lut(ramp_color.r), _ramp_c1_lut(ramp_color.g), _ramp_c1_lut(ramp_color.b));

  // Factor = Invert(GREATER_THAN(alpha, 0.10)) — binary 0/1, not continuous.
  // alpha > 0.10 → factor=0 (use first_curved); alpha ≤ 0.10 → factor=1 (use second_curved).
  let second_factor = select(1.0, 0.0, alpha > 0.10);
  let second_curved = vec3f(_ramp_c2_lut(first_curved.r), _ramp_c2_lut(first_curved.g), _ramp_c2_lut(first_curved.b));

  return mix(first_curved, second_curved, second_factor);
}

// ─── ramp_lookup_dual — 冷暖双 ramp 色阶 ───────────────────────────
// 当有 warm ramp 和 cool ramp 两张贴图时，按 mixFactor 在两者之间混合。
// mixFactor=1.0 → warm ramp，mixFactor=0.0 → cool ramp。
// 典型用途：脸部用 dot(faceFront, sun) 映射冷暖，头发/身体用 dot(N, L) 映射。

fn ramp_lookup_dual(value: f32, alpha: f32, warmRampTex: texture_2d<f32>, coolRampTex: texture_2d<f32>, rampSampler: sampler, mixFactor: f32) -> vec3f {
  let warm = ramp_lookup(value, alpha, warmRampTex, rampSampler);
  let cool = ramp_lookup(value, alpha, coolRampTex, rampSampler);
  return mix(cool, warm, mixFactor);
}

// ─── ilm.clothes / ilm.hair — ILM 控制贴图解码 (子 Group: ilm.*) ────
// Star-Rail-standard ILM LightMap channel packing:
//   R = AO (ambient occlusion)
//   G = specular mask
//   B = shadow threshold
//   A = material region mask

fn ilm_decode(ilmColor: vec4f) -> vec4f {
  return vec4f(ilmColor.r, ilmColor.g, ilmColor.b, ilmColor.a);
}

// ─── SDF 脸部阴影 / SDF Face Shadow (子 Group: SDF + SDF.tex) ───────
// 经 MCP 核对 SDF.002:
//   dot_R = dot(RIGHT, SUN)  → GREATER_THAN(_, 0.0) → is_right
//   UV.x = mix(-uv.x, uv.x, is_right)  镜像
//   sdf_alpha = sample(SDF_FaceMap, uv).a
//   dot_F = dot(FRONT, SUN)
//   threshold = dot_F * 0.5 + 0.5  (动态阈值)
//   lit = threshold > sdf_alpha
//   backface guard: dot_F <= 0 → 全暗
//
// ⚠️ 关键修正: 左右判断用 dot(RIGHT,SUN)>0，阈值是动态的 dot_F*0.5+0.5

fn sdf_face_shadow(uv: vec2f, faceFront: vec3f, faceRight: vec3f, sun: vec3f, sdfMap: texture_2d<f32>, sdfSampler: sampler) -> f32 {
  // faceFront/faceRight 存储的是 Blender Z-up 值，sun 是 engine Y-up 值。
  // 转换: Z-up (x,y,z) → Y-up (x, z, -y)。
  let front = vec3f(faceFront.x, faceFront.z, -faceFront.y);
  let right = vec3f(faceRight.x, faceRight.z, -faceRight.y);

  let dot_R = dot(right, sun);
  let is_right = step(0.0, dot_R);
  var uvMapped = uv;
  // is_right=1 时不翻转 UV.x；is_right=0 时镜像翻转。
  uvMapped.x = mix(-uv.x, uv.x, is_right);
  let alpha = textureSample(sdfMap, sdfSampler, uvMapped).a;
  // 动态阈值: DOT(FRONT, SUN) * 0.5 + 0.5
  let dot_F = dot(front, sun);
  let threshold = dot_F * 0.5 + 0.5;
  return select(0.0, 1.0, threshold <= alpha);
}

// ─── 鼻尖阴影 / Nose Shadow (子 Group: 鼻尖阴影) ───────────────────
// 经 MCP 核对 鼻尖阴影.002:
//   n_mapped = normalize(n + (0, -0.4, 0))
//   facing = LayerWeight(blend=0.5).Facing
//   ramp1 = color_ramp(facing, [0.2042→黑, 0.2708→白], EASE)
//   blue = Separate(Color).Blue
//   ramp2 = color_ramp(blue, [0.0→黑, 0.0458→白], EASE)
//   inverted = 1.0 - ramp2
//   result = mix(inverted, 1.0, ramp1)  (B 未连接，取默认 1.0)

fn nose_shadow(baseColor: vec3f, n: vec3f, v: vec3f) -> f32 {
  let nMapped = normalize(vec3f(n.x, n.y - 0.4, n.z));
  let facing = layer_weight_facing(0.5, nMapped, v);
  // Color Ramp: pos 0.2042→black, 0.2708→white
  let facingMask = smoothstep(0.2042, 0.2708, facing);
  // ColorRamp.001 on blue: pos 0.0→black, 0.0458→white → Invert
  let blueGate = smoothstep(0.0, 0.0458, baseColor.b);
  let inverted = 1.0 - blueGate;
  // Mix.001: mix(inverted, 1.0, facingMask) — B=1.0 (white)
  return mix(inverted, 1.0, facingMask);
}

// ─── 眼睫 / Eyelash Shade (子 Group: 眼睫) ──────────────────────────
// 经 MCP 核对 眼睫.001:
//   照度 = 夹角判断(dot(FRONT, SUN))   → saturate(dot)
//   压暗色 = HSV(value=0.65)(input)
//   mix = mix(原色, 压暗色, 照度)
//   校色_out = 校色(mix)

fn eyelash_shade(input_color: vec3f, faceFront: vec3f, sun: vec3f) -> vec3f {
  let angle = saturate(dot(faceFront, sun));
  let darkened = hsv_adjust(input_color, 0.5, 1.0, 0.65);
  let mixed = mix(input_color, darkened, angle);
  return color_correct(mixed);
}

// ─── 颜+ / Face Glow Shade (子 Group: 颜+) ──────────────────────────
fn face_glow_shade(color: vec3f, fac: f32) -> vec3f {
  var b = color.b;
  if (b <= 0.6455) {
    b = b * (0.3032 / 0.6455);
  } else {
    b = 0.3032 + (b - 0.6455) * (1.0 - 0.3032) / (1.0 - 0.6455);
  }
  let curved = vec3f(color.r, color.g, b);
  let emission = curved * 1.0;
  let layer1 = mix(vec3f(1.0), emission, fac);
  return layer1;
}

// ─── 衣服 Fresnel ColorRamp (CARDINAL 三次曲线) ──────────────────────
fn color_ramp_clothes_fresnel(factor: f32) -> f32 {
  let t = clamp(factor, 0.0, 1.0);
  return 1.0 - t + 0.58 * t * (t - 0.5) * (t - 1.0);
}

// ─── ramp.hair 采样 (含 RGB Curves C曲线) ────────────────────────────
// ramp.hair.001: Warm Ramp → RGB Curves Combined [(0,0),(0.5822,0.3427),(1,1)]
// Combined 曲线应用到所有 R/G/B 通道（Blender RGB Curves Combined 行为）
// 经 MCP 核对: 输出用的是 Warm Ramp（不是 Cool！Cool 被采样但未连到输出）

fn _ramp_hair_c_curve_lut(t: f32) -> f32 {
  let idx_f = saturate(t) * 20.0;
  let idx = i32(idx_f);
  let frac = idx_f - f32(idx);
  let LUT = array<f32, 21>(
    0.000000, 0.020349, 0.040947, 0.062096, 0.084244,
    0.107841, 0.133541, 0.161956, 0.193668, 0.229166,
    0.268744, 0.312462, 0.360181, 0.411820, 0.468364,
    0.531591, 0.603718, 0.687120, 0.782838, 0.888835,
    1.000000
  );
  let i0 = clamp(idx, 0, 19);
  let i1 = i0 + 1;
  return mix(LUT[i0], LUT[i1], frac);
}

fn ramp_hair_lookup(uv: vec2f, rampTex: texture_2d<f32>, rampSampler: sampler) -> vec3f {
  let raw = textureSample(rampTex, rampSampler, uv);
  return vec3f(
    _ramp_hair_c_curve_lut(raw.r),
    _ramp_hair_c_curve_lut(raw.g),
    _ramp_hair_c_curve_lut(raw.b)
  );
}

// ─── map_range ──────────────────────────────────────────────────────
fn map_range(value: f32, from_min: f32, from_max: f32, to_min: f32, to_max: f32) -> f32 {
  let denom = from_max - from_min;
  if (abs(denom) < 0.0001) { return to_min; }
  let t = clamp((value - from_min) / denom, 0.0, 1.0);
  return mix(to_min, to_max, t);
}

// ─── 分段线性插值 ───────────────────────────────────────────────────
fn piecewise_linear_3(x: f32, x0: f32, y0: f32, x1: f32, y1: f32, x2: f32, y2: f32) -> f32 {
  if (x <= x0) { return y0; }
  if (x >= x2) { return y2; }
  if (x <= x1) {
    let t = (x - x0) / (x1 - x0);
    return mix(y0, y1, t);
  }
  let t = (x - x1) / (x2 - x1);
  return mix(y1, y2, t);
}

fn piecewise_linear_4(x: f32, x0: f32, y0: f32, x1: f32, y1: f32, x2: f32, y2: f32, x3: f32, y3: f32) -> f32 {
  if (x <= x0) { return y0; }
  if (x >= x3) { return y3; }
  if (x <= x1) {
    let t = (x - x0) / (x1 - x0);
    return mix(y0, y1, t);
  }
  if (x <= x2) {
    let t = (x - x1) / (x2 - x1);
    return mix(y1, y2, t);
  }
  let t = (x - x2) / (x3 - x2);
  return mix(y2, y3, t);
}

// ─── HSV 调整 (hsv_adjust) ──────────────────────────────────────────
// Blender Hue/Saturation/Value 节点：hue=0.5 是恒等（fract(h+0.5-0.5)=h）
fn hsv_adjust(color: vec3f, hue: f32, saturation: f32, value_scale: f32) -> vec3f {
  let hsv = rgb_to_hsv(color);
  let h = fract(hsv.x + hue - 0.5);
  let s = clamp(hsv.y * saturation, 0.0, 1.0);
  let v = clamp(hsv.z * value_scale, 0.0, 1.0);
  return hsv_to_rgb(vec3f(h, s, v));
}

// ─── 夹角判断 / check_angle ────────────────────────────────────────
fn check_angle(attr_a: vec3f, attr_b: vec3f) -> f32 {
  let dot_val = dot(normalize(attr_a), normalize(attr_b));
  return map_range(dot_val, 0.0, 1.0, 0.0, 1.0);
}

// ─── Invert Color ──────────────────────────────────────────────────
fn invert_color(color: vec3f) -> vec3f {
  return 1.0 - color;
}

// ─── RGB to BW ──────────────────────────────────────────────────────
fn rgb_to_bw(color: vec3f) -> f32 {
  return dot(color, vec3f(0.2126, 0.7152, 0.0722));
}

// ─── ColorRamp 函数 ────────────────────────────────────────────────

// 鼻尖阴影 Color Ramp: 0.2042→black, 0.2708→white
fn color_ramp_nose_shadow(factor: f32) -> f32 {
  return smoothstep(0.2042, 0.2708, factor);
}

// 鼻尖阴影 ColorRamp.001: 0.0→black, 0.0458→white
fn color_ramp_nose_shadow_001(factor: f32) -> f32 {
  return smoothstep(0.0, 0.0458, factor);
}

// ─── Float Curve 函数 ──────────────────────────────────────────────

// Material Float Curve (custom_thickness): [(0, 0.0625), (0.5007, 1.0186), (0.5315, 1.8509), (1, 1.8125)]
fn float_curve_thickness(x: f32) -> f32 {
  return piecewise_linear_4(x, 0.0, 0.0625, 0.5007, 1.0186, 0.5315, 1.8509, 1.0, 1.8125);
}

// Material Float Curve.004: [(0,0), (0.5164, 0.035), (1, 0.115)]
fn float_curve_thickness_004(x: f32) -> f32 {
  return piecewise_linear_3(x, 0.0, 0.0, 0.5164, 0.035, 1.0, 0.115);
}

// ─── 刘海阴影 / bangs_shadow ────────────────────────────────────────
fn bangs_shadow(image: vec3f, input_color: vec3f, depth: f32, face_depth: vec3f) -> vec3f {
  let mapped = map_range(depth, 0.0, 1.0, 0.0, 1.0);
  let d1 = mapped * (-34.9);
  let d2 = d1 + 0.5;
  let d3 = d2 * 0.2;
  let d4 = d3 * 1.0;
  let threshold = d4;
  let shadow_color = vec3f(0.821, 0.306, 0.295);
  return mix(input_color, shadow_color, threshold);
}

// ─── MMD 颜色混合链 ────────────────────────────────────────────────
fn mmd_color_blend(
  ambient_color: vec3f, diffuse_color: vec3f, specular_color: vec3f,
  base_color: vec4f, toon_color: vec4f, sphere_color: vec4f,
  sphere_mul_add: f32, global_alpha: f32, double_sided: f32, backfacing: f32
) -> vec4f {
  // 颜色混合链
  let c0 = ambient_color + diffuse_color * 0.6;
  let c1 = c0 * (1.0 - base_color.a * (1.0 - base_color.rgb));
  let c2 = c1 * (1.0 - toon_color.a * (1.0 - toon_color.rgb));
  let c3 = c2 * (1.0 - sphere_color.a * (1.0 - sphere_color.rgb));
  let c4 = c2 + sphere_color.rgb * sphere_color.a;
  let final_color = mix(c3, c4, sphere_mul_add);

  // Shader混合
  let spec_factor = 0.02;
  let shader_result = mix(final_color, specular_color, spec_factor);

  // Alpha计算
  var alpha = global_alpha;
  alpha *= base_color.a;
  alpha *= toon_color.a;
  alpha *= sphere_color.a;

  // Backfacing/DoubleSided
  let is_front = select(0.0, 1.0, backfacing < 0.5);
  let show_face = max(is_front, double_sided);
  alpha = min(show_face, alpha);

  return vec4f(shader_result, alpha);
}

`;
