// Shared WGSL primitives for Blender-style NPR material nodes.
// Every function here maps 1:1 to a Blender shader node type used in the preset JSONs.
// Hand-ported material shaders concatenate this block before their own code.

export const NODES_WGSL = /* wgsl */ `

// Baked 64×64 rgba8unorm combined BRDF LUT — created once at engine init by dfg_lut.ts.
//   .rg = split-sum DFG (Karis: tint = f0·x + f90·y)  → F_brdf_*_scatter
//   .ba = Heitz 2016 LTC magnitude (ltc_mag_ggx)       → ltc_brdf_scale_from_lut
// Paired with group(0) binding(2) diffuseSampler (linear filter). Sample once per
// fragment via brdf_lut_sample() — callers feed .rg and the whole vec4 into the
// helpers below, halving LUT taps on the default Principled path.
@group(0) @binding(9) var brdfLut: texture_2d<f32>;

// ─── RGB ↔ HSV ──────────────────────────────────────────────────────

fn rgb_to_hsv(rgb: vec3f) -> vec3f {
  let c_max = max(rgb.r, max(rgb.g, rgb.b));
  let c_min = min(rgb.r, min(rgb.g, rgb.b));
  let delta = c_max - c_min;

  var h = 0.0;
  if (delta > 1e-6) {
    if (c_max == rgb.r) {
      h = (rgb.g - rgb.b) / delta;
      if (h < 0.0) { h += 6.0; }
    } else if (c_max == rgb.g) {
      h = 2.0 + (rgb.b - rgb.r) / delta;
    } else {
      h = 4.0 + (rgb.r - rgb.g) / delta;
    }
    h /= 6.0;
  }
  let s = select(0.0, delta / c_max, c_max > 1e-6);
  return vec3f(h, s, c_max);
}

fn hsv_to_rgb(hsv: vec3f) -> vec3f {
  let h = hsv.x;
  let s = hsv.y;
  let v = hsv.z;
  if (s < 1e-6) { return vec3f(v); }

  let hh = fract(h) * 6.0;
  let sector = u32(hh);
  let f = hh - f32(sector);
  let p = v * (1.0 - s);
  let q = v * (1.0 - s * f);
  let t = v * (1.0 - s * (1.0 - f));

  switch (sector) {
    case 0u: { return vec3f(v, t, p); }
    case 1u: { return vec3f(q, v, p); }
    case 2u: { return vec3f(p, v, t); }
    case 3u: { return vec3f(p, q, v); }
    case 4u: { return vec3f(t, p, v); }
    default: { return vec3f(v, p, q); }
  }
}

// ─── HUE_SAT node ───────────────────────────────────────────────────

fn hue_sat(hue: f32, saturation: f32, value: f32, fac: f32, color: vec3f) -> vec3f {
  var hsv = rgb_to_hsv(color);
  hsv.x = fract(hsv.x + hue - 0.5);
  hsv.y = clamp(hsv.y * saturation, 0.0, 1.0);
  hsv.z *= value;
  return mix(color, hsv_to_rgb(hsv), fac);
}

// ─── BRIGHTCONTRAST node ────────────────────────────────────────────

fn bright_contrast(color: vec3f, bright: f32, contrast: f32) -> vec3f {
  let a = 1.0 + contrast;
  let b = bright - contrast * 0.5;
  return max(vec3f(0.0), color * a + vec3f(b));
}

// ─── INVERT node ────────────────────────────────────────────────────

fn invert(fac: f32, color: vec3f) -> vec3f {
  return mix(color, vec3f(1.0) - color, fac);
}

fn invert_f(fac: f32, val: f32) -> f32 {
  return mix(val, 1.0 - val, fac);
}

// ─── Color ramp (VALTORGB) — 2-stop variants ───────────────────────
// All 7 presets use exclusively 2-stop ramps.

fn ramp_constant(f: f32, p0: f32, c0: vec4f, p1: f32, c1: vec4f) -> vec4f {
  return select(c0, c1, f >= p1);
}

// CONSTANT ramp with screen-space edge AA — kills sparkle where fwidth(f) straddles a hard step (NPR terminator)
fn ramp_constant_edge_aa(f: f32, edge: f32, c0: vec4f, c1: vec4f) -> vec4f {
  let w = max(fwidth(f) * 1.75, 6e-6);
  let t = smoothstep(edge - w, edge + w, f);
  return mix(c0, c1, t);
}

fn ramp_linear(f: f32, p0: f32, c0: vec4f, p1: f32, c1: vec4f) -> vec4f {
  let t = saturate((f - p0) / max(p1 - p0, 1e-6));
  return mix(c0, c1, t);
}

fn ramp_cardinal(f: f32, p0: f32, c0: vec4f, p1: f32, c1: vec4f) -> vec4f {
  // cardinal spline with 2 stops degrades to smoothstep
  let t = saturate((f - p0) / max(p1 - p0, 1e-6));
  let ss = t * t * (3.0 - 2.0 * t);
  return mix(c0, c1, ss);
}

// ─── MATH node operations ───────────────────────────────────────────

fn math_add(a: f32, b: f32) -> f32 { return a + b; }
fn math_multiply(a: f32, b: f32) -> f32 { return a * b; }
fn math_power(a: f32, b: f32) -> f32 { return pow(max(a, 0.0), b); }
fn math_greater_than(a: f32, b: f32) -> f32 { return select(0.0, 1.0, a > b); }

// Blender's implicit Color → Float socket conversion uses BT.601 grayscale
// (rgb_to_grayscale in blenkernel/intern/node.cc). When a material graph plugs a
// Color output into a Math node's Value input, this is the scalar it actually sees.
fn color_to_value(c: vec3f) -> f32 {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

// ─── MIX node (blend_type variants) ────────────────────────────────

fn mix_blend(fac: f32, a: vec3f, b: vec3f) -> vec3f {
  return mix(a, b, fac);
}

fn mix_overlay(fac: f32, a: vec3f, b: vec3f) -> vec3f {
  let lo = 2.0 * a * b;
  let hi = vec3f(1.0) - 2.0 * (vec3f(1.0) - a) * (vec3f(1.0) - b);
  let overlay = select(hi, lo, a < vec3f(0.5));
  return mix(a, overlay, fac);
}

fn mix_multiply(fac: f32, a: vec3f, b: vec3f) -> vec3f {
  return mix(a, a * b, fac);
}

fn mix_lighten(fac: f32, a: vec3f, b: vec3f) -> vec3f {
  return mix(a, max(a, b), fac);
}

// Blender Mix (Color) blend LINEAR_LIGHT: result = mix(A, A + 2*B - 1, Fac)
fn mix_linear_light(fac: f32, a: vec3f, b: vec3f) -> vec3f {
  return mix(a, a + 2.0 * b - vec3f(1.0), fac);
}

// Luminance for Shader→RGB scalar gates (linear RGB, Rec.709 weights)
fn luminance_rec709_linear(c: vec3f) -> f32 {
  return dot(max(c, vec3f(0.0)), vec3f(0.2126, 0.7152, 0.0722));
}

// ─── FRESNEL node ───────────────────────────────────────────────────
// Schlick approximation matching Blender's Fresnel node

fn fresnel(ior: f32, n: vec3f, v: vec3f) -> f32 {
  let f0 = pow((ior - 1.0) / (ior + 1.0), 2.0);
  let cos_theta = clamp(dot(n, v), 0.0, 1.0);
  return f0 + (1.0 - f0) * pow(1.0 - cos_theta, 5.0);
}

// ─── LAYER_WEIGHT node ──────────────────────────────────────────────

fn layer_weight_fresnel(blend: f32, n: vec3f, v: vec3f) -> f32 {
  let eta = max(1.0 - blend, 1e-4);
  let f0 = pow((1.0 - eta) / (1.0 + eta), 2.0);
  let cos_theta = clamp(abs(dot(n, v)), 0.0, 1.0);
  return f0 + (1.0 - f0) * pow(1.0 - cos_theta, 5.0);
}

fn layer_weight_facing(blend: f32, n: vec3f, v: vec3f) -> f32 {
  var facing = abs(dot(n, v));
  let b = clamp(blend, 0.0, 0.99999);
  if (b != 0.5) {
    let exponent = select(2.0 * b, 0.5 / (1.0 - b), b >= 0.5);
    facing = pow(facing, exponent);
  }
  return 1.0 - facing;
}

// ─── SHADER_TO_RGB (white DiffuseBSDF) ──────────────────────────────
// Eevee captures lit diffuse: (albedo/π)*sun*N·L*shadow + ambient (linear). Albedo=1.
// Matches default.ts direct term scale so VALTORGB thresholds from Blender JSON stay valid.

fn shader_to_rgb_diffuse(n: vec3f, l: vec3f, sun_rgb: vec3f, ambient_rgb: vec3f, shadow: f32) -> f32 {
  const PI_S: f32 = 3.141592653589793;
  let ndotl = max(dot(n, l), 0.0);
  let rgb = sun_rgb * (ndotl * shadow / PI_S) + ambient_rgb;
  return luminance_rec709_linear(rgb);
}

// ─── AMBIENT_OCCLUSION node (faked) ─────────────────────────────────
// Real SSAO is a non-goal. We approximate: use the "inside" value from
// concavity heuristic: 1.0 = fully lit, lower = occluded.
// For now returns 1.0 (no darkening). Individual presets can override.

fn ao_fake(n: vec3f, v: vec3f) -> f32 {
  return 1.0;
}

// ─── BUMP node ──────────────────────────────────────────────────────
// Screen-space bump from a scalar height field. Needs dFdx/dFdy which
// WGSL provides as dpdx/dpdy.

fn bump(strength: f32, height: f32, normal: vec3f, world_pos: vec3f) -> vec3f {
  let dhdx = dpdx(height);
  let dhdy = dpdy(height);
  let dpdx_pos = dpdx(world_pos);
  let dpdy_pos = dpdy(world_pos);
  let perturbed = normalize(normal) - strength * (dhdx * normalize(cross(dpdy_pos, normal)) + dhdy * normalize(cross(normal, dpdx_pos)));
  return normalize(perturbed);
}

// LH engine + WebGPU fragment Y: flip dhdy contribution so height peaks read as outward bumps vs Blender reference
fn bump_lh(strength: f32, height: f32, normal: vec3f, world_pos: vec3f) -> vec3f {
  let dhdx = dpdx(height);
  let dhdy = dpdy(height);
  let dpdx_pos = dpdx(world_pos);
  let dpdy_pos = dpdy(world_pos);
  let perturbed = normalize(normal) - strength * (dhdx * normalize(cross(dpdy_pos, normal)) - dhdy * normalize(cross(normal, dpdx_pos)));
  return normalize(perturbed);
}

// ─── NOISE texture (Perlin-style) ───────────────────────────────────
// Simplified gradient noise matching Blender's default noise output.

fn _hash33(p: vec3f) -> vec3f {
  var q = vec3f(
    dot(p, vec3f(127.1, 311.7, 74.7)),
    dot(p, vec3f(269.5, 183.3, 246.1)),
    dot(p, vec3f(113.5, 271.9, 124.6))
  );
  return fract(sin(q) * 43758.5453123) * 2.0 - 1.0;
}

fn _noise3(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);

  return mix(
    mix(
      mix(dot(_hash33(i + vec3f(0,0,0)), f - vec3f(0,0,0)),
          dot(_hash33(i + vec3f(1,0,0)), f - vec3f(1,0,0)), u.x),
      mix(dot(_hash33(i + vec3f(0,1,0)), f - vec3f(0,1,0)),
          dot(_hash33(i + vec3f(1,1,0)), f - vec3f(1,1,0)), u.x), u.y),
    mix(
      mix(dot(_hash33(i + vec3f(0,0,1)), f - vec3f(0,0,1)),
          dot(_hash33(i + vec3f(1,0,1)), f - vec3f(1,0,1)), u.x),
      mix(dot(_hash33(i + vec3f(0,1,1)), f - vec3f(0,1,1)),
          dot(_hash33(i + vec3f(1,1,1)), f - vec3f(1,1,1)), u.x), u.y),
    u.z);
}

fn tex_noise(p: vec3f, scale: f32, detail: f32, roughness: f32, distortion: f32) -> f32 {
  var q = p;
  if (abs(distortion) > 1e-6) {
    let w = _noise3(p * scale * 1.37 + vec3f(2.31, 5.17, 8.09));
    q = p + (w * 2.0 - 1.0) * distortion;
  }
  let coords = q * scale;
  var value = 0.0;
  var amplitude = 1.0;
  var frequency = 1.0;
  var total_amp = 0.0;
  let octaves = i32(clamp(detail, 0.0, 15.0)) + 1;
  for (var i = 0; i < octaves; i++) {
    value += amplitude * _noise3(coords * frequency);
    total_amp += amplitude;
    amplitude *= roughness;
    frequency *= 2.0;
  }
  return value / max(total_amp, 1e-6) * 0.5 + 0.5;
}

// ─── TEX_GRADIENT (linear) ──────────────────────────────────────────
// Used by Stockings preset. Maps the input vector's X to a 0–1 gradient.

fn tex_gradient_linear(uv: vec3f) -> f32 {
  return clamp(uv.x, 0.0, 1.0);
}

// ─── TEX_VORONOI (distance only) ────────────────────────────────────
// Used by Metal preset. Simplified F1 cell noise.

fn tex_voronoi_f1(p: vec3f, scale: f32) -> f32 {
  let coords = p * scale;
  let i = floor(coords);
  let f = fract(coords);
  var min_dist = 1e10;
  for (var z = -1; z <= 1; z++) {
    for (var y = -1; y <= 1; y++) {
      for (var x = -1; x <= 1; x++) {
        let neighbor = vec3f(f32(x), f32(y), f32(z));
        let point = _hash33(i + neighbor) * 0.5 + 0.5;
        let diff = neighbor + point - f;
        min_dist = min(min_dist, dot(diff, diff));
      }
    }
  }
  return sqrt(min_dist);
}

// ─── SEPXYZ node ────────────────────────────────────────────────────

fn separate_xyz(v: vec3f) -> vec3f { return v; }

// ─── VECT_MATH (cross product) ──────────────────────────────────────

fn vect_math_cross(a: vec3f, b: vec3f) -> vec3f { return cross(a, b); }

// ─── MAPPING node ───────────────────────────────────────────────────
// Point-type mapping: scale, rotate (euler XYZ), translate.

fn mapping_point(v: vec3f, loc: vec3f, rot: vec3f, scl: vec3f) -> vec3f {
  var p = v * scl;
  // simplified: skip rotation when all angles are zero (common case)
  if (abs(rot.x) + abs(rot.y) + abs(rot.z) > 1e-6) {
    let cx = cos(rot.x); let sx = sin(rot.x);
    let cy = cos(rot.y); let sy = sin(rot.y);
    let cz = cos(rot.z); let sz = sin(rot.z);
    let rx = vec3f(p.x, cx*p.y - sx*p.z, sx*p.y + cx*p.z);
    let ry = vec3f(cy*rx.x + sy*rx.z, rx.y, -sy*rx.x + cy*rx.z);
    p = vec3f(cz*ry.x - sz*ry.y, sz*ry.x + cz*ry.y, ry.z);
  }
  return p + loc;
}

// ─── NORMAL_MAP node (tangent-space) ────────────────────────────────
// Applies a tangent-space normal map. Requires TBN from vertex stage.

fn normal_map(strength: f32, map_color: vec3f, normal: vec3f, tangent: vec3f, bitangent: vec3f) -> vec3f {
  let ts = map_color * 2.0 - 1.0;
  let perturbed = normalize(tangent * ts.x + bitangent * ts.y + normal * ts.z);
  return normalize(mix(normal, perturbed, strength));
}

// ─── EEVEE Principled BSDF primitives ───────────────────────────────
// Ports from Blender 3.6 source/blender/draw/engines/eevee/shaders/
//   bsdf_common_lib.glsl + gpu_shader_material_principled.glsl.
// Usage pattern (see material shaders): direct spec = bsdf_ggx × sun × shadow
// (NL baked in, no F yet); ambient spec = probe_radiance; tint both with
// reflection_color = F_brdf_multi_scatter(f0, f90, split_sum) AFTER summing.

const EEVEE_PI: f32 = 3.141592653589793;

// Fused analytic GGX specular (direct lights). Returns BRDF × NL.
// 4·NL·NV is cancelled via G1_Smith reciprocal form — see bsdf_common_lib.glsl:115.
fn bsdf_ggx(N: vec3f, L: vec3f, V: vec3f, roughness: f32) -> f32 {
  let a = max(roughness, 1e-4);
  let a2 = a * a;
  let H = normalize(L + V);
  let NH = max(dot(N, H), 1e-8);
  let NL = max(dot(N, L), 1e-8);
  let NV = max(dot(N, V), 1e-8);
  // G1_Smith_GGX_opti reciprocal form — denominator piece only.
  let G1L = NL + sqrt(NL * (NL - NL * a2) + a2);
  let G1V = NV + sqrt(NV * (NV - NV * a2) + a2);
  let G = G1L * G1V;
  // D_ggx_opti = pi * denom² — reciprocal D × a².
  let tmp = (NH * a2 - NH) * NH + 1.0;
  let D_opti = EEVEE_PI * tmp * tmp;
  return NL * a2 / (D_opti * G);
}

// Split-sum DFG LUT — Karis 2013 curve fit stand-in for the 64×64 baked LUT.
// Returns (lut.x, lut.y) in Blender convention: tint = f0·lut.x + f90·lut.y.
fn brdf_lut_approx(NV: f32, roughness: f32) -> vec2f {
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * NV)) * r.x + r.y;
  return vec2f(-1.04, 1.04) * a004 + r.zw;
}

// Baked combined BRDF LUT — exact port of Blender bsdf_lut_frag.glsl packed with
// ltc_mag_ggx from eevee_lut.c. Single sample returns DFG (.rg) and LTC mag (.ba).
// Addressed as Blender's common_utiltex_lib.glsl:lut_coords:
//   coords = (roughness, sqrt(1 - NV)), then half-texel bias for filtering.
// Requires group(0) binding(9) brdfLut + binding(2) diffuseSampler in the host shader.
fn brdf_lut_sample(NV: f32, roughness: f32) -> vec4f {
  let LUT_SIZE: f32 = 64.0;
  var uv = vec2f(saturate(roughness), sqrt(saturate(1.0 - NV)));
  uv = uv * ((LUT_SIZE - 1.0) / LUT_SIZE) + 0.5 / LUT_SIZE;
  return textureSampleLevel(brdfLut, diffuseSampler, uv, 0.0);
}

fn F_brdf_single_scatter(f0: vec3f, f90: vec3f, lut: vec2f) -> vec3f {
  return lut.y * f90 + lut.x * f0;
}

// Fdez-Agüera 2019 multi-scatter compensation (EEVEE do_multiscatter=1).
fn F_brdf_multi_scatter(f0: vec3f, f90: vec3f, lut: vec2f) -> vec3f {
  let FssEss = lut.y * f90 + lut.x * f0;
  let Ess = lut.x + lut.y;
  let Ems = 1.0 - Ess;
  let Favg = f0 + (1.0 - f0) / 21.0;
  let Fms = FssEss * Favg / (1.0 - (1.0 - Ess) * Favg);
  return FssEss + Fms * Ems;
}

// EEVEE direct-specular energy compensation factor — closure_eval_glossy_lib.glsl:79-81:
//   ltc_brdf_scale = (ltc.x + ltc.y) / (split_sum.x + split_sum.y)
// Blender evaluates direct lights via LTC (Heitz 2016) but indirect via split-sum;
// direct radiance is rescaled so total-energy matches the split-sum LUT.
// Takes a pre-sampled vec4f from brdf_lut_sample() to share the fetch with
// F_brdf_multi_scatter on the same fragment.
fn ltc_brdf_scale_from_lut(lut: vec4f) -> f32 {
  return (lut.z + lut.w) / max(lut.x + lut.y, 1e-6);
}

// Luminance-normalized hue extraction — Blender tint_from_color (isolates hue+sat).
fn tint_from_color(color: vec3f) -> vec3f {
  let lum = dot(color, vec3f(0.3, 0.6, 0.1));
  return select(vec3f(1.0), color / lum, lum > 0.0);
}

`;
