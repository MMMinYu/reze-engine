// StarRail 专用 per-material bind group layout。
//
// 替换 COMMON_BINDINGS_WGSL 的 group(2) 部分 —— group(0)（camera/light/shadow/
// brdfLut）和 group(1)（skinMats）仍由 common.ts + nodes.ts 声明，StarRail 与
// 现有 9 个材质共享这两个 group。
//
// WGSL 是模块级编译：同一模块内 @group(N) @binding(M) 的声明只能出现一次。
// 因此 StarRail 材质 shader 拼接时跳过 COMMON_BINDINGS_WGSL 的 group(2) 部分，
// 改用本文件的 STARRAIL_BINDINGS_WGSL（拼法：NODES_WGSL + group(0/1) 声明 +
// 本文件 + SAMPLE_SHADOW_WGSL + COMMON_VS_WGSL + COMMON_FS_OUT_WGSL + 材质 fs）。
//
// 与 common.ts 的对照：
//   common.ts group(2):  binding(0) diffuseTexture + binding(1) MaterialUniforms
//   本文件   group(2):  binding(0) colorTexture（语义同 diffuseTexture，便于回退）
//                        binding(1) StarRailMaterialUniforms
//                        binding(2-5) ilm/ramp/sdf/matcap 贴图
//                        binding(6) 共用 sampler
//                        binding(7) coolRampTexture（可选冷暖双 ramp）
//
// group(2) 的 binding 编号独立于 group(0)/group(1)，不会冲突。

export const STARRAIL_BINDINGS_WGSL = /* wgsl */ `

// StarRail 专用 per-material uniforms。
// 字段布局严格遵循 WGSL uniform 地址空间的 std140 式对齐规则：
//   - vec3f 对齐 16 字节、大小 12 字节，因此每个 vec3f 后紧跟一个 f32 pad/标量
//     凑成 16 字节，避免隐式填充导致 TS 端写 buffer 时错位。
//   - 结构体总大小必须是 16 字节的倍数（结构体对齐 = 最大成员对齐 = 16）。
//   - 逐字段偏移：faceFront=0, _pad0=12, faceRight=16, _pad1=28, faceUp=32,
//   rampStrength=44, warmColor=48, coolStrength=60, coolColor=64,
//   specularPower=76, specularColor=80, specularStrength=92, rimColor=96,
//   rimStrength=108, emissionColor=112, emissionStrength=124, alpha=128,
//   useSDF=132, useMatcap=136, useRamp=140, useCoolRamp=144,
//   _pad2=148, _pad3=152, _pad4=156 → 总计 160 字节。
struct StarRailMaterialUniforms {
  faceFront: vec3f,       // 脸部前向（MMD 约定: -Y），仅 sr_face 用
  _pad0: f32,
  faceRight: vec3f,       // 脸部右向（MMD 约定: +X），仅 sr_face 用
  _pad1: f32,
  faceUp: vec3f,          // 脸部上向（MMD 约定: +Z），仅 sr_face 用
  rampStrength: f32,      // toon ramp 强度
  warmColor: vec3f,       // 暖色（lit 区色调）
  coolStrength: f32,      // 冷色强度（shadow 区）
  coolColor: vec3f,       // 冷色（shadow 区色调）
  specularPower: f32,     // Blinn-Phong power
  specularColor: vec3f,   // 高光颜色
  specularStrength: f32,  // 高光强度
  rimColor: vec3f,        // rim light 颜色
  rimStrength: f32,       // rim 强度
  emissionColor: vec3f,   // 自发光颜色
  emissionStrength: f32,  // 自发光强度
  alpha: f32,             // 透明度（与现有 MaterialUniforms.alpha 语义一致）
  useSDF: f32,            // 1.0 = 启用 SDF 脸部阴影，0.0 = 禁用
  useMatcap: f32,         // 1.0 = 启用 matcap
  useRamp: f32,           // 1.0 = 启用 toon ramp
  useCoolRamp: f32,       // 1.0 = 有 cool ramp 贴图，启用冷暖双 ramp
  useRGBCurves: f32,      // 1.0 = 启用 sr_eye RGB Curves 预处理（仅"目"材质）
  _pad3: f32,
  _pad4: f32,
};

@group(2) @binding(0) var colorTexture: texture_2d<f32>;   // 基础颜色贴图（语义同 diffuseTexture）
@group(2) @binding(1) var<uniform> srMaterial: StarRailMaterialUniforms;
@group(2) @binding(2) var ilmTexture: texture_2d<f32>;     // ILM LightMap（AO/高光/阴影/mask）
@group(2) @binding(3) var rampTexture: texture_2d<f32>;    // Toon ramp LUT（warm ramp）
@group(2) @binding(4) var sdfTexture: texture_2d<f32>;     // SDF 脸部 FaceMap（仅 face）
@group(2) @binding(5) var matcapTexture: texture_2d<f32>;  // matcap 球面贴图
@group(2) @binding(6) var srSampler: sampler;              // 共用 sampler
@group(2) @binding(7) var coolRampTexture: texture_2d<f32>; // Cool ramp LUT（可选冷暖双 ramp）

`;

// StarRailMaterialUniforms 的字节大小（用于引擎端创建 GPUBuffer）。
//
// 计算（WGSL uniform 地址空间：vec3f 对齐 16/大小 12，f32 对齐 4/大小 4；
// 结构体对齐 = 最大成员对齐 = 16）：
//   8 组 (vec3f + 配对 f32)，每组占 16 字节 → 8 × 16 = 128 字节
//     （faceFront/_pad0, faceRight/_pad1, faceUp/rampStrength,
//      warmColor/coolStrength, coolColor/specularPower,
//      specularColor/specularStrength, rimColor/rimStrength,
//      emissionColor/emissionStrength — 共 8 组 → 8 × 16 = 128 字节）
//   再加 8 个尾随连续 f32（alpha/useSDF/useMatcap/useRamp/useCoolRamp/_pad2/_pad3/_pad4）
//   = 32 字节
//   合计 128 + 32 = 160 字节，已是 16 的倍数。
//
// 等价地按末字段校验：offset(_pad4) = 156，+ sizeof(f32) = 160。
export const STARRAIL_MATERIAL_UNIFORM_SIZE = 160;
