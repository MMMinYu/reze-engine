// Shared WGSL primitives for Blender-style NPR material nodes.
// Every function here maps 1:1 to a Blender shader node type used in the preset JSONs.
// Hand-ported material shaders concatenate this block before their own code.

export const NODES_WGSL = /* wgsl */ `

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

// ─── Split-sum environment BRDF (Karis 2013, UE4) ───────────────────
// Curve-fit replacement for the DFG LUT: returns F_ambient = F0 * scale + bias
// for use as  env_spec = env_brdf_approx(F0, r, ndotv) * probe_radiance.

fn env_brdf_approx(F0: vec3f, roughness: f32, ndotv: f32) -> vec3f {
  let c0 = vec4f(-1.0, -0.0275, -0.572, 0.022);
  let c1 = vec4f(1.0, 0.0425, 1.04, -0.04);
  let r = roughness * c0 + c1;
  let a004 = min(r.x * r.x, exp2(-9.28 * ndotv)) * r.x + r.y;
  let AB = vec2f(-1.04, 1.04) * a004 + r.zw;
  return F0 * AB.x + vec3f(AB.y);
}

`;
