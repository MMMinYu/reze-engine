# 代码约定文档

## 语言与构建

- **语言**: TypeScript 5，严格模式
- **模块系统**: ESM (`"type": "module"`)
- **构建**: `tsc` 直接编译，无 bundler
- **输出**: `dist/` 目录，`.js` + `.d.ts`
- **运行时依赖**: 仅 `@webgpu/types`（类型包），零运行时依赖

## 命名约定

### 文件命名

| 类型 | 约定 | 示例 |
|------|------|------|
| 类文件 | kebab-case | `pmx-loader.ts`, `ik-solver.ts` |
| 着色器文件 | kebab-case | `cloth_smooth.ts`, `dfg_lut.ts` |
| 物理子模块 | 小写单字 | `body.ts`, `world.ts`, `solver.ts` |

### 变量与函数

| 类型 | 约定 | 示例 |
|------|------|------|
| 类 | PascalCase | `Engine`, `Model`, `RigidBodyStore` |
| 接口/类型 | PascalCase | `AnimationClip`, `MaterialPresetMap` |
| 枚举 | PascalCase | `RigidbodyShape`, `RigidbodyType` |
| 枚举值 | PascalCase | `RigidbodyShape.Sphere` |
| 公共方法 | camelCase | `loadModel()`, `getSkinMatrices()` |
| 私有字段 | camelCase + private | `private modelInstances` |
| 常量 | UPPER_SNAKE_CASE | `CONTACT_MARGIN`, `BLOOM_MAX_LEVELS` |
| 静态只读 | UPPER_SNAKE_CASE | `static readonly GIZMO_RING_SEGMENTS` |
| 局部变量 | camelCase | `boneCount`, `firstFrame` |
| WGSL 导出常量 | UPPER_SNAKE_CASE + `_WGSL` 后缀 | `FACE_SHADER_WGSL`, `NODES_WGSL` |

### 骨骼名与变形名

PMX 模型使用日语骨骼名（如 `センター`, `全ての親`, `首`）。代码中直接使用原始日文名，不做翻译：

```typescript
engine.setCameraFollow(model, "センター", new Vec3(0, 3.5, 0))
model.rotateBones({ 首: quat }, 0)
```

## 代码风格

### 类结构顺序

```typescript
class MyClass {
  // 1. 静态成员
  private static readonly CONSTANT = 42
  private static instance: MyClass | null = null

  // 2. 私有字段（按功能分组，用注释分隔）
  // ─── 渲染 ─────────────────────────────
  private pipeline!: GPURenderPipeline
  private texture!: GPUTexture

  // ─── 状态 ─────────────────────────────
  private enabled = true

  // 3. 构造函数
  constructor(...) { ... }

  // 4. 公共方法
  publicMethod(): void { ... }

  // 5. 私有方法
  private helperMethod(): void { ... }
}
```

### GPU 资源声明

使用 TypeScript 的明确赋值断言 (`!`) 声明在 `init()` 中创建的 GPU 资源：

```typescript
private device!: GPUDevice
private pipeline!: GPURenderPipeline
private texture!: GPUTexture
```

### Float32Array 模式

引擎大量使用 `Float32Array` 进行 GPU 数据传输，避免对象分配：

```typescript
// 预分配 scratch 缓冲区（模块级，避免每帧分配）
const _scratchMat = new Float32Array(16)
const _scratchQuat = new Quat(0, 0, 0, 1)

// 统一缓冲区数据
private readonly cameraMatrixData = new Float32Array(36)
private readonly compositeUniformData = new Float32Array(8)
```

### SoA 数据布局

物理系统使用 Structure-of-Arrays 而非 Array-of-Structures：

```typescript
// ✓ SoA — 缓存友好，SIMD 友好
readonly positions: Float32Array      // 3*N
readonly orientations: Float32Array   // 4*N
readonly linearVelocities: Float32Array // 3*N

// ✗ 不要改为 AoS
interface RigidBody { position: Vec3, orientation: Quat, ... }
readonly bodies: RigidBody[]
```

## 性能模式

### 避免每帧分配

- 预分配 Float32Array 作为 scratch 缓冲区
- 使用 `set()` 方法原地更新而非创建新对象
- 骨骼矩阵数组在 Model 中缓存（`skinMatricesArray`）

### GPU 数据上传

- 骨骼矩阵每帧上传（`skinMatrixBuffer`）
- 顶点数据仅在变形脏时上传（`vertexBufferNeedsUpdate` 标志）
- 统一缓冲区使用 `device.queue.writeBuffer()` 而非 map + unmap

### 碰撞对预过滤

`RigidBodyStore.buildCollisionPairs()` 在构造时一次性计算，存为 `Uint16Array`。349 个刚体从 ~60k 对过滤到几千对。

### 固定时间步

物理引擎使用 60 Hz 固定步长 + 时间累加器，最多 6 子步/帧。不要改为可变步长——弹簧/阻尼的确定性依赖固定 dt。

## WGSL 约定

### 字符串模板

使用 tagged template literal 标注语言：

```typescript
export const MY_SHADER_WGSL = /* wgsl */ `
  @fragment fn fs(...) { ... }
`
```

### 拼接顺序

严格遵循：NODES → BINDINGS → SHADOW → VS → 材质代码。顺序错误会导致 WGSL 编译失败（重复声明或未定义引用）。

### 绑定编号

Group 0 = per-frame, Group 1 = per-model, Group 2 = per-material。新绑定必须追加到现有编号之后，不要插入中间。

## 错误处理

- PMX/VMD 解析错误：抛出 `Error` 并描述具体问题
- GPU 不可用：`init()` 中检测并抛出
- 资源加载失败：`AssetReader.readBinary()` 抛出 `Error`（含路径信息）
- 物理发散：不抛异常，调用 `resetPhysics()` 恢复

## 注释风格

- 使用英文注释
- 区块分隔使用 `─── 标题 ─────` 风格
- 关键算法引用论文/作者（如 `Wyman & McGuire 2017`, `Fdez-Agüera 2019`）
- WGSL 注释解释"为什么"而非"是什么"

## 导入顺序

```typescript
// 1. 本模块的其他导出
import { Camera } from "./camera"
import { Mat4, Quat, Vec3 } from "./math"

// 2. 子模块
import { PmxLoader } from "./pmx-loader"
import { RezePhysics } from "./physics"

// 3. 类型导入
import { type AssetReader } from "./asset-reader"

// 4. 着色器
import { FACE_SHADER_WGSL } from "./shaders/materials/face"
```

## 测试

当前项目无自动化测试。验证方式：
- 手动在 Web 端加载模型和动画
- 视觉检查渲染结果
- 对比 Blender 参考渲染
