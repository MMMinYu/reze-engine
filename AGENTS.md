# AGENTS.md — Reze Engine 项目导航

> 本文档为 AI 编码助手提供项目全景索引，帮助快速定位代码、理解架构和遵循约定。
> 如果代码更新导致文档描述和代码不一致，必须更新文档。
> 找问题时必须添加足够的调试信息，而不是自己猜。
> **涉及 Blender/PMX 模型数据、材质设置的结论，必须通过 MCP 连接 Blender 验证，不得凭猜测下结论。**
> **复杂调试任务必须先在 docs/ 创建调试记录文档，每步修改后更新文档。不得在没有记录的情况下反复试错。**

## 项目概览

Reze Engine 是一个**零运行时依赖**的 WebGPU 引擎，专为实时 MMD/PMX 角色渲染设计。全部用 TypeScript 编写，包含渲染器、动画、IK 和物理系统。

- **仓库**: https://github.com/AmyangXYZ/reze-engine
- **包名**: `reze-engine` (npm)
- **版本**: 0.15.1
- **许可**: MIT

## 仓库结构

```
reze-engine/
├── engine/                    # 核心引擎 npm 包
│   └── src/
│       ├── engine.ts          # Engine 主类 (~3700行) — WebGPU 初始化、渲染循环、管线创建、资源管理
│       ├── model.ts           # Model 类 — 骨骼动画、变形、IK、物理桥接
│       ├── animation.ts       # AnimationClip / AnimationState — 关键帧数据与优先级播放
│       ├── camera.ts          # Camera — 轨道相机（球坐标 + 鼠标/触摸输入）
│       ├── math.ts            # Vec3 / Quat / Mat4 — 自研线性代数库
│       ├── pmx-loader.ts      # PmxLoader — PMX 2.0 二进制解析
│       ├── vmd-loader.ts      # VMDLoader — VMD 动作文件解析（Shift-JIS）
│       ├── vmd-writer.ts      # VMDWriter — AnimationClip → VMD 二进制导出
│       ├── ik-solver.ts       # IKSolverSystem — CCD 式 IK 求解器
│       ├── asset-reader.ts    # AssetReader — 统一 I/O 抽象（HTTP / File map）
│       ├── folder-upload.ts   # parsePmxFolderInput / pmxFileAtRelativePath
│       ├── index.ts           # 公共导出
│       ├── physics/           # 自研刚体物理引擎
│       │   ├── physics.ts     # RezePhysics — 物理步进、骨骼同步
│       │   ├── world.ts       # World — 重力、子步管线
│       │   ├── body.ts        # RigidBodyStore — SoA 数据布局
│       │   ├── solver.ts      # solveConstraints — 投影 Gauss-Seidel
│       │   ├── constraint.ts  # SixDofSpringConstraint — 6DOF 弹簧约束
│       │   ├── contact.ts     # ContactPool / findContacts — 窄相碰撞
│       │   └── types.ts       # Rigidbody / Joint 类型定义
│       └── shaders/
│           ├── materials/     # 材质预设 WGSL（9 种标准 + 5 种 StarRail）
│           │   ├── nodes.ts   # 共享 WGSL 原语（BSDF、HSV、噪声等）
│           │   ├── common.ts  # 统一变量、绑定声明、蒙皮 VS、PCF 阴影
│           │   ├── default.ts # Principled BSDF 基准
│           │   ├── face.ts    # 脸部 NPR（toon + 暖色 rim + 亮度门控）
│           │   ├── hair.ts    # 头发 NPR（toon + fresnel + bevel）
│           │   ├── body.ts    # 身体 NPR（toon + rim + noise bump）
│           │   ├── eye.ts     # 眼睛（Principled + 发光）
│           │   ├── stockings.ts # 丝袜（alpha-hashed 透明 + 梯度）
│           │   ├── metal.ts   # 金属（Voronoi 闪光 + 发光叠加）
│           │   ├── cloth_smooth.ts # 光滑布料（toon + 发光）
│           │   ├── cloth_rough.ts  # 粗糙布料（+ noise bump, rough=0.82）
│           │   └── starrail/  # StarRail NPR 预设族（多贴图绑定，见 docs/starrail-shader-reference.md）
│           │       ├── starrail_nodes.ts   # 共享 NPR 函数（SDF/matcap/ramp/ILM）
│           │       ├── bindings.ts         # StarRail 专用 group(2) layout
│           │       ├── starrail_prelude.ts # WGSL 拼接 prelude
│           │       ├── face.ts             # sr_face（SDF 脸部阴影）
│           │       ├── hair.ts             # sr_hair
│           │       ├── body.ts             # sr_body
│           │       ├── clothes.ts          # sr_clothes
│           │       └── eye.ts              # sr_eye
│           ├── passes/        # 后处理 & 工具 Pass
│           │   ├── shadow.ts  # 方向光阴影深度
│           │   ├── ground.ts  # 地面阴影接收
│           │   ├── outline.ts # 倒 hull 轮廓线
│           │   ├── bloom.ts   # EEVEE 风格 Bloom（blit/down/up 金字塔）
│           │   ├── composite.ts # Filmic 色调映射 + gamma
│           │   ├── pick.ts    # GPU 拾取（双击选骨骼/材质）
│           │   ├── selection.ts # 选中高亮（mask + edge）
│           │   ├── gizmo.ts   # 变换 Gizmo（环 + 轴）
│           │   └── mipmap.ts  # 纹理 mipmap 生成
│           ├── dfg_lut.ts     # BRDF DFG LUT 烘焙
│           └── ltc_mag_lut.ts # LTC 幅度 LUT 数据
├── web/                       # Next.js 展示站点
│   └── app/
│       ├── page.tsx           # 主页 — 引擎初始化 + 播放控制
│       └── tutorial/          # 教程页面（5 步渐进式构建引擎）
├── tools/                     # 外部工具脚本（不属 engine npm 包）
│   └── blender-exporters/     # Blender 资源导出器
│       ├── starrail_exporter.py # StarRail 预设 → PMX + 贴图 + manifest.json
│       └── README.md          # 使用说明
└── docs/                      # 细化文档（见下文）
```

## 核心架构速查

| 系统 | 入口文件 | 关键类/函数 | 详细文档 |
|------|---------|------------|---------|
| 引擎核心 | `engine.ts` | `Engine` | [architecture.md](docs/architecture.md) |
| 渲染管线 | `engine.ts` + `shaders/` | 管线创建 / Pass 编排 | [rendering.md](docs/rendering.md) |
| 物理引擎 | `physics/physics.ts` | `RezePhysics` / `World` | [physics.md](docs/physics.md) |
| 动画系统 | `animation.ts` + `model.ts` | `AnimationState` / `Model` | [animation.md](docs/animation.md) |
| 着色器系统 | `shaders/materials/` + `shaders/passes/` | WGSL 模块拼接 | [shader-system.md](docs/shader-system.md) |
| 数学库 | `math.ts` | `Vec3` / `Quat` / `Mat4` | [conventions.md](docs/conventions.md) |
| API 参考 | — | 全部公共接口 | [api-reference.md](docs/api-reference.md) |

## 修改代码时的关键约束

1. **零运行时依赖** — `engine/` 的 `dependencies` 只有 `@webgpu/types`，不要引入任何新包
2. **WGSL 是字符串拼接** — 材质着色器 = `NODES_WGSL` + `COMMON_BINDINGS_WGSL` + `SAMPLE_SHADOW_WGSL` + `COMMON_VS_WGSL` + 材质特有代码，顺序不能乱
3. **Engine 是单例** — `init()` 后 `Engine.getInstance()` 获取；一个页面只有一个 WebGPU 设备
4. **物理固定步长** — 60 Hz 子步，最多 6 子步/帧；不要改动 `fixedTimeStep`
5. **SoA 物理存储** — `RigidBodyStore` 用平行 Float32Array（positions/orientations/...），不要改为 AoS
6. **骨骼索引用 Int32** — PMX 骨骼索引可为 -1（无父节点），不要用 Uint
7. **MMD 单位** — 1 单位 = 8 cm，相机默认距离 ~26-31 单位
8. **HDR 格式** — 优先 `rg11b10ufloat`（Apple TBDR 友好），回退 `rgba16float`
9. **材质预设映射** — 未映射的材质名回退到 `default`，新预设需在 `MaterialPreset` 联合类型中注册
10. **动画帧率** — 固定 30 FPS（`FPS` 常量），VMD 按帧索引存储

## 常见任务指引

### 添加新材质预设
1. 在 `shaders/materials/` 新建 `my_preset.ts`，导出 `MY_PRESET_SHADER_WGSL`
2. 在 `engine.ts` 的 `MaterialPreset` 类型添加 `"my_preset"`
3. 在 `Engine.init()` 中创建对应 `GPURenderPipeline`
4. 在 `pipelineForPreset()` 添加 case
5. 在 `resolvePreset()` 无需修改（已通过 map 查找）

**注意：StarRail 类预设（多贴图）**——如果新预设需要每材质多张贴图（ILM/ramp/matcap 等），参考 `shaders/materials/starrail/` 子目录的架构：用 `STARRAIL_PRELUDE_WGSL`（而非 `COMMON_MATERIAL_PRELUDE_WGSL`）拼接 WGSL，用 `srPipelineLayout`（而非 `mainPipelineLayout`）创建 pipeline，在 `setupMaterialsForInstance` 的 `isStarRail` 分支中处理 bind group 创建。详见 [docs/starrail-shader-reference.md](docs/starrail-shader-reference.md)。

### 添加新后处理 Pass
1. 在 `shaders/passes/` 新建 WGSL 模块
2. 在 `Engine` 类中声明管线 / 纹理 / bind group 字段
3. 在 `init()` 中创建管线和资源
4. 在 `render()` 方法中插入 pass（注意 pass 顺序和纹理依赖）

### 修改物理碰撞
1. 碰撞对在 `contact.ts` 的 `findContacts()` 中按形状分派
2. 新增碰撞对需同时更新 `RigidBodyStore.buildCollisionPairs()` 的过滤逻辑
3. 碰撞法线约定：从 body A 指向 body B

### 修改动画插值
1. VMD 插值曲线在 `vmd-loader.ts` 解析为 `BoneInterpolation`（4 组贝塞尔控制点）
2. 采样在 `model.ts` 的 `applyAnimationClip()` 中执行
3. 插值函数在 `animation.ts` 的 `interpolateControlPoints()`

## 构建与开发

```bash
# 引擎构建
cd engine && npm run build      # tsc 编译到 dist/
cd engine && npm run dev        # tsc --watch

# Web 站点
cd web && npm run dev           # Next.js dev server on :4001
cd web && npm run build         # 生产构建

# 清理缓存和构建产物（修改 WGSL / shader 代码后必须执行）
cd engine && npm run clean      # 删除 dist/
cd web && npm run clean         # 删除 .next/
```

> **重要**：修改任何 WGSL shader 代码（`shaders/` 目录下的 `.ts` 文件）后，必须先执行 `clean` 再重新 `build`/`dev`，否则 tsc/Next.js 的增量编译和 turbo pack 缓存可能不会检测到字符串常量变化，导致 GPU 管线使用旧 shader 代码。

## 文档索引

| 文档 | 内容 |
|------|------|
| [architecture.md](docs/architecture.md) | 整体架构、模块关系、数据流 |
| [rendering.md](docs/rendering.md) | WebGPU 渲染管线、Pass 编排、HDR/Bloom/阴影 |
| [physics.md](docs/physics.md) | 物理引擎内部：求解器、碰撞、约束 |
| [animation.md](docs/animation.md) | 动画系统：VMD 解析、插值、IK、变形 |
| [shader-system.md](docs/shader-system.md) | WGSL 模块体系、材质预设、共享节点 |
| [starrail-shader-reference.md](docs/starrail-shader-reference.md) | StarRail NPR Shader WGSL 移植参考（14 个子 Group 规格） |
| [api-reference.md](docs/api-reference.md) | 全部公共 API 签名与用法 |
| [conventions.md](docs/conventions.md) | 代码风格、命名约定、性能模式 |
| [performance-guide.md](docs/performance-guide.md) | 性能性价比优化指南：按 ROI 排序的优化路线图 |
