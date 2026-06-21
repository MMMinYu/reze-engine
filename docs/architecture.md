# 架构文档

## 整体架构

Reze Engine 采用单文件主类 + 模块化子系统的架构。`Engine` 类是唯一的入口和协调者，所有子系统通过直接引用 Engine 或被 Engine 持有。

```
┌─────────────────────────────────────────────────────────────┐
│                        Engine (engine.ts)                    │
│  - WebGPU 设备 / 上下文 / 管线管理                           │
│  - 渲染循环编排                                              │
│  - 模型实例管理 (Map<string, ModelInstance>)                  │
│  - 相机 / 光照 / 场景配置                                    │
│  - 输入处理 (鼠标/触摸/拾取/Gizmo)                           │
├──────────┬──────────┬──────────┬──────────┬─────────────────┤
│  Model   │  Camera  │  Physics │ Animation│   Shaders       │
│ model.ts │camera.ts │ physics/ │animation │ shaders/        │
│          │          │          │  .ts     │                 │
├──────────┴──────────┴──────────┴──────────┴─────────────────┤
│                     Math (math.ts)                           │
│                Vec3 / Quat / Mat4                            │
├─────────────────────────────────────────────────────────────┤
│                  Asset I/O (asset-reader.ts)                 │
│            HTTP fetch | File map (folder upload)             │
└─────────────────────────────────────────────────────────────┘
```

## 模块关系

### Engine ↔ Model

Engine 持有 `Map<string, ModelInstance>`，每个 `ModelInstance` 包含：
- `model: Model` — 骨骼/动画/变形逻辑
- GPU 资源：vertexBuffer, indexBuffer, jointsBuffer, weightsBuffer, skinMatrixBuffer
- DrawCall 列表：main / shadow / pick 三套
- `physics: RezePhysics | null` — 物理实例
- `materialPresets: MaterialPresetMap` — 材质预设映射
- `hiddenMaterials: Set<string>` — 隐藏材质

Engine 在每帧渲染循环中：
1. 调用 `model.getSkinMatrices()` 获取骨骼矩阵
2. 上传到 `skinMatrixBuffer`
3. 如果 `vertexBufferNeedsUpdate`（变形脏），重新上传顶点数据
4. 按材质预设分派 DrawCall 到对应管线

### Model ↔ Animation

Model 内部持有 `AnimationState`（优先级播放器），通过以下方法交互：
- `loadVmd()` → VMDLoader 解析 → `AnimationClip` → `AnimationState.loadAnimation()`
- `play()` / `pause()` / `stop()` / `seek()` → AnimationState 控制
- 每帧 `applyAnimationClip()` 从 AnimationState 采样当前帧，写入骨骼 localRotation/localTranslation

### Model ↔ Physics

Model 持有 PMX 解析出的 `Rigidbody[]` 和 `Joint[]`。Engine 在 `loadModel()` 时创建 `RezePhysics` 实例并存入 `ModelInstance.physics`。

物理步进流程（每帧）：
1. Engine 调用 `model.getSkinMatrices()` 获取骨骼世界矩阵
2. Engine 调用 `physics.step(dt, boneWorldMatrices, inverseBindMatrices)`
3. Physics 内部：同步 kinematic 体到骨骼 → 子步循环 → 返回动态体变换
4. Engine 将动态体变换写回 Model 的骨骼（覆盖动画驱动的姿势）

### Model ↔ IK

IK 求解在 `Model.getSkinMatrices()` 内部执行：
1. 先应用动画帧到骨骼
2. 如果 `ikEnabled`，调用 `IKSolverSystem.solve()`
3. IK 修改目标骨骼的 localRotation
4. 重新计算世界矩阵

## 数据流：一帧的生命周期

```
requestAnimationFrame
  │
  ├─ 1. AnimationState.advance() — 推进时间线，采样关键帧
  ├─ 2. Model.applyAnimationClip() — 写入骨骼 localRotation/localTranslation
  ├─ 3. Model.applyTweens() — 应用骨骼/变形补间
  ├─ 4. Model.getSkinMatrices()
  │     ├─ 计算骨骼世界矩阵（含 IK）
  │     └─ 返回 Float32Array（boneCount × 16 floats）
  ├─ 5. Physics.step(dt, boneWorldMatrices, ibm)
  │     ├─ 同步 kinematic 体
  │     ├─ 子步循环 ×N
  │     └─ 返回动态体变换 → 写回骨骼
  ├─ 6. Model.applyMorphs() — 应用变形偏移到顶点数据
  ├─ 7. 上传 GPU 资源
  │     ├─ skinMatrixBuffer
  │     ├─ vertexBuffer（如果 morphsDirty）
  │     └─ camera/light uniform buffers
  ├─ 8. WebGPU 渲染 Pass 序列
  │     ├─ Shadow depth pass
  │     ├─ Main color pass (opaque → transparent → hair-over-eyes → stockings)
  │     ├─ Selection mask pass (if selection active)
  │     ├─ Bloom pyramid (blit → downsample × N → upsample × N)
  │     ├─ Composite pass (HDR → Filmic → gamma → canvas)
  │     ├─ Outline pass
  │     ├─ Selection edge pass (if selection active)
  │     ├─ Gizmo pass (if bone selected)
  │     └─ Pick pass (if pending pick)
  └─ 9. Stats 更新 → callback
```

## 单例模式

Engine 使用静态单例：
```typescript
private static instance: Engine | null = null
static getInstance(): Engine
```

`init()` 设置 `instance`，`dispose()` 清除。一个页面只应有一个 Engine 实例，因为 WebGPU 设备是独占的。

## 模型实例生命周期

```
loadModel(name, path)
  ├─ PmxLoader.loadFromReader() → Model 实例
  ├─ 创建 GPU 缓冲区 (vertex/index/joints/weights/skinMatrix)
  ├─ 加载纹理到 textureCache
  ├─ 创建 DrawCall 列表（按材质分组）
  ├─ 创建 RezePhysics（如果有刚体/关节）
  ├─ 创建 shadow bind group
  ├─ 创建 pick draw calls
  └─ 存入 modelInstances Map

removeModel(name)
  ├─ 销毁 GPU 缓冲区
  ├─ 从 textureCache 移除该模型的纹理
  └─ 从 modelInstances Map 删除
```

## 资源管理

### 纹理缓存
- `textureCache: Map<string, GPUTexture>` — 全局共享，路径为 key
- 同一路径只加载一次，多模型共享纹理
- `removeModel()` 时清理该模型的 `textureCacheKeys`

### GPU 缓冲区
- 每个 ModelInstance 拥有独立的 vertex/index/joints/weights/skinMatrix 缓冲区
- 顶点缓冲区在变形脏时重新上传（`vertexBufferNeedsUpdate` 标志）
- 骨骼矩阵缓冲区每帧上传

### AssetReader 抽象
```typescript
type AssetReader = {
  readBinary(logicalPath: string): Promise<ArrayBuffer>
}
```
两种实现：
- `createFetchAssetReader()` — HTTP fetch，用于 URL 加载
- `createFileMapAssetReader(files: Map<string, File>)` — 本地文件夹上传

路径解析：PMX 中的纹理路径是相对于 PMX 文件的，通过 `deriveBasePathFromPmxPath()` + `joinAssetPath()` 拼接。

## Web 端架构

`web/` 是 Next.js 应用，仅作为展示和教程用途：
- `app/page.tsx` — 主页，初始化 Engine、加载模型、播放控制
- `app/tutorial/` — 5 步渐进式教程，每步有独立的 canvas 和 engine 版本
- `components/` — UI 组件（Header、Loading、Slider 等）
- `public/` — 静态资源（模型、动画、音频）

Web 端通过 `import { Engine } from "reze-engine"` 使用引擎 npm 包。
