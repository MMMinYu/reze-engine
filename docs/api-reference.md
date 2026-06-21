# API 参考文档

## 公共导出

```typescript
// engine.ts
export { Engine }
export { DEFAULT_BLOOM_OPTIONS, DEFAULT_VIEW_TRANSFORM }
export type { EngineStats, EngineOptions, BloomOptions, ViewTransformOptions }
export type { LoadModelFromFilesOptions, MaterialPreset, MaterialPresetMap }
export type { GizmoDragEvent, GizmoDragCallback, GizmoDragKind }

// folder-upload.ts
export { parsePmxFolderInput, pmxFileAtRelativePath }
export type { PmxFolderInputResult }

// model.ts
export { Model }

// math.ts
export { Vec3, Quat, Mat4 }

// animation.ts
export { FPS }
export type { AnimationClip, AnimationPlayOptions, AnimationProgress }
export type { BoneKeyframe, MorphKeyframe, BoneInterpolation, ControlPoint }

// physics
export { RezePhysics }
export { RigidBodyStore }
export { RigidbodyShape, RigidbodyType }
export type { Rigidbody, Joint }
```

---

## Engine

### 构造

```typescript
new Engine(canvas: HTMLCanvasElement, options?: EngineOptions)
```

### EngineOptions

```typescript
type EngineOptions = {
  world?: {
    color?: Vec3       // 环境光颜色（线性，默认 Vec3(0.4014, 0.4944, 0.647)）
    strength?: number  // 环境光强度（默认 0.3）
  }
  sun?: {
    color?: Vec3       // 太阳光颜色（默认白色）
    strength?: number  // 太阳光强度（默认 2.0）
    direction?: Vec3   // 光线方向（从太阳指向场景，默认 Vec3(-0.0873, -0.3844, 0.919)）
  }
  camera?: {
    distance?: number  // 轨道距离（默认 26.6）
    target?: Vec3      // 轨道中心（默认 Vec3(0, 12.5, 0)）
    fov?: number       // 垂直 FOV 弧度（默认 π/4）
  }
  bloom?: Partial<BloomOptions>
  view?: Partial<ViewTransformOptions>
  onRaycast?: RaycastCallback
  onGizmoDrag?: GizmoDragCallback
}
```

### 生命周期

| 方法 | 签名 | 说明 |
|------|------|------|
| `init` | `async init(): Promise<void>` | 初始化 WebGPU 设备、创建管线和资源。必须 await |
| `dispose` | `dispose(): void` | 销毁所有 GPU 资源，停止渲染循环 |

### 模型管理

| 方法 | 签名 | 说明 |
|------|------|------|
| `loadModel` | `async loadModel(name: string, path: string): Promise<Model>` | 从 URL 加载 PMX 模型 |
| `loadModel` | `async loadModel(name: string, opts: LoadModelFromFilesOptions): Promise<Model>` | 从文件夹上传加载 |
| `getModel` | `getModel(name: string): Model \| undefined` | 获取已加载模型 |
| `getModelNames` | `getModelNames(): string[]` | 所有已加载模型名 |
| `removeModel` | `removeModel(name: string): void` | 移除模型并释放 GPU 资源 |

### 材质

| 方法 | 签名 | 说明 |
|------|------|------|
| `setMaterialPresets` | `setMaterialPresets(name: string, map: MaterialPresetMap): void` | 映射材质名到 NPR 预设 |
| `setMaterialVisible` | `setMaterialVisible(name: string, material: string, visible: boolean): void` | 设置材质可见性 |
| `toggleMaterialVisible` | `toggleMaterialVisible(name: string, material: string): void` | 切换材质可见性 |
| `isMaterialVisible` | `isMaterialVisible(name: string, material: string): boolean` | 查询材质可见性 |

#### MaterialPreset 联合类型

```typescript
type MaterialPreset =
  | "default" | "face" | "hair" | "body" | "eye"
  | "stockings" | "metal" | "cloth_smooth" | "cloth_rough"
  // StarRail NPR 预设族（多贴图绑定，见 docs/starrail-shader-reference.md）
  | "sr_face" | "sr_hair" | "sr_body" | "sr_clothes" | "sr_eye"
```

#### StarRail manifest.json 格式

StarRail 预设需要 Blender 导出器（`tools/blender-exporters/starrail_exporter.py`）生成的 `manifest.json`。**注意：实际 manifest 没有顶层 `presets` 字段**——preset 是每个材质条目内的字段。真实结构（取自 `web/public/models/风堇/manifest.json`）：

```json
{
  "version": 1,
  "model": "model.pmx",
  "materials": {
    "actual_颜.001": {
      "preset": "sr_face",
      "textures": {
        "color": "textures/Avatar_Hyacine_00_Face_Color.png",
        "ilm": "textures/Avatar_Hyacine_00_Body_LightMap_L.png",
        "warm_ramp": "textures/Avatar_Hyacine_00_Body_Warm_Ramp.png",
        "cool_ramp": "textures/Avatar_Hyacine_00_Body_Cool_Ramp.png",
        "sdf": "textures/W_140_Girl_FaceMap_00.png",
        "matcap": "textures/Avatar_Tex_MetalMap.png"
      },
      "uniforms": {
        "rampStrength": 1.0,
        "useSDF": 1.0
      }
    }
  }
}
```

关键字段：
- **材质名**：Blender 导出保留 `actual_` 前缀和 `.NNN` 后缀（如 `actual_颜.001`），引擎按名匹配。
- **textures** 槽位：`color` / `ilm` / `warm_ramp` / `cool_ramp` / `sdf` / `matcap`（不是单一 `ramp`，ramp 分 warm/cool 两张）。
- **uniforms**：每材质可覆盖 uniform（`rampStrength`/`useSDF`/`useMatcap`/`useCoolRamp`/`alpha` 等），缺省用引擎默认。

### 物理

| 方法 | 签名 | 说明 |
|------|------|------|
| `setPhysicsEnabled` | `setPhysicsEnabled(enabled: boolean): void` | 启用/禁用物理 |
| `resetPhysics` | `resetPhysics(): void` | 重置物理体到骨骼姿势 |

### 相机

| 方法 | 签名 | 说明 |
|------|------|------|
| `setCameraFollow` | `setCameraFollow(model: Model \| null, bone?: string, offset?: Vec3): void` | 相机跟随模型骨骼 |
| `setCameraTarget` | `setCameraTarget(vec3: Vec3): void` | 设置轨道中心 |
| `setCameraDistance` | `setCameraDistance(d: number): void` | 设置轨道距离 |
| `setCameraAlpha` | `setCameraAlpha(a: number): void` | 设置水平旋转角 |
| `setCameraBeta` | `setCameraBeta(b: number): void` | 设置垂直旋转角 |

### 场景

| 方法 | 签名 | 说明 |
|------|------|------|
| `addGround` | `addGround(options?: { width?, height?, diffuseColor? }): void` | 添加地面（带阴影） |
| `setWorld` | `setWorld(opts: { color?: Vec3, strength?: number }): void` | 运行时修改环境光 |
| `setSun` | `setSun(opts: { color?: Vec3, strength?: Vec3, direction?: Vec3 }): void` | 运行时修改太阳光 |
| `setBloomOptions` | `setBloomOptions(opts: Partial<BloomOptions>): void` | 运行时修改 Bloom |
| `setViewTransform` | `setViewTransform(opts: Partial<ViewTransformOptions>): void` | 运行时修改色调映射 |

### 渲染

| 方法 | 签名 | 说明 |
|------|------|------|
| `runRenderLoop` | `runRenderLoop(callback?: () => void): void` | 启动渲染循环 |
| `stopRenderLoop` | `stopRenderLoop(): void` | 停止渲染循环 |
| `getStats` | `getStats(): EngineStats` | 获取 FPS 和帧时间 |

### 交互

| 方法 | 签名 | 说明 |
|------|------|------|
| `setSelectedMaterial` | `setSelectedMaterial(model: string \| null, material: string \| null): void` | 选中材质（橙色高亮） |
| `setSelectedBone` | `setSelectedBone(model: string \| null, bone: string \| null): void` | 选中骨骼（显示 Gizmo） |
| `setIKEnabled` | `setIKEnabled(enabled: boolean): void` | 启用/禁用 IK |

---

## Model

### 动画

| 方法 | 签名 | 说明 |
|------|------|------|
| `loadVmd` | `async loadVmd(name: string, url: string): Promise<void>` | 加载 VMD 动画 |
| `loadClip` | `loadClip(name: string, clip: AnimationClip): void` | 加载编程式动画 |
| `show` | `show(name: string): void` | 显示指定动画（不播放） |
| `play` | `play(name?: string, options?: AnimationPlayOptions): void` | 播放动画 |
| `pause` | `pause(): void` | 暂停 |
| `stop` | `stop(): void` | 停止 |
| `seek` | `seek(time: number): void` | 跳转（秒） |
| `getAnimationProgress` | `getAnimationProgress(): AnimationProgress` | 查询进度 |
| `getClip` | `getClip(name: string): AnimationClip \| undefined` | 获取动画数据 |
| `exportVmd` | `exportVmd(name: string): ArrayBuffer` | 导出为 VMD 二进制 |

### AnimationPlayOptions

```typescript
type AnimationPlayOptions = {
  priority?: number  // 越高越优先，默认 0
  loop?: boolean     // 循环播放，默认 false
}
```

### 骨骼操作

| 方法 | 签名 | 说明 |
|------|------|------|
| `rotateBones` | `rotateBones(bones: Record<string, Quat>, ms?: number): void` | 旋转骨骼（VMD 相对，可选补间） |
| `moveBones` | `moveBones(bones: Record<string, Vec3>, ms?: number): void` | 平移骨骼（VMD 相对，可选补间） |
| `setMorphWeight` | `setMorphWeight(name: string, weight: number, ms?: number): void` | 设置变形权重 |
| `resetAllBones` | `resetAllBones(): void` | 重置所有骨骼到 bind pose |
| `resetAllMorphs` | `resetAllMorphs(): void` | 重置所有变形权重为 0 |
| `getBoneWorldPosition` | `getBoneWorldPosition(name: string): Vec3` | 获取骨骼世界位置 |
| `getBoneLocalRotation` | `getBoneLocalRotation(index: number): Quat` | 获取骨骼本地旋转 |
| `getBoneLocalTranslation` | `getBoneLocalTranslation(index: number): Vec3` | 获取骨骼本地平移 |
| `setBoneLocalTranslation` | `setBoneLocalTranslation(index: number, v: Vec3): void` | 直接设置本地平移 |

### 姿势编辑

| 方法 | 签名 | 说明 |
|------|------|------|
| `setClipApplySuspended` | `setClipApplySuspended(suspended: boolean): void` | 冻结动画重采样 |
| `isClipApplySuspended` | `isClipApplySuspended(): boolean` | 查询冻结状态 |

### 根变换

| 属性 | 类型 | 说明 |
|------|------|------|
| `position` | `Vec3` | 模型世界位置 |
| `rotation` | `Quat` | 模型世界旋转 |
| `setPosition(v)` | `void` | 设置位置 |
| `setRotation(q)` | `void` | 设置旋转 |

---

## Vec3

```typescript
class Vec3 {
  x: number; y: number; z: number
  constructor(x: number, y: number, z: number)
  static zeros(): Vec3
  add(v: Vec3): Vec3
  subtract(v: Vec3): Vec3
  length(): number
  normalize(): Vec3       // 原地归一化
  cross(v: Vec3): Vec3
  dot(v: Vec3): number
  scale(s: number): Vec3
  clone(): Vec3
  set(v: Vec3): void      // 原地复制
}
```

## Quat

```typescript
class Quat {
  x: number; y: number; z: number; w: number
  constructor(x: number, y: number, z: number, w: number)
  static identity(): Quat
  static fromAxisAngle(axis: Vec3, angle: number): Quat
  static slerp(a: Quat, b: Quat, t: number): Quat
  multiply(q: Quat): Quat
  conjugate(): Quat
  normalize(): Quat       // 原地归一化
  clone(): Quat
  set(q: Quat): void
}
```

## Mat4

```typescript
class Mat4 {
  values: Float32Array  // column-major 16 floats
  static identity(): Mat4
  static translation(v: Vec3): Mat4
  static rotation(q: Quat): Mat4
  static scale(v: Vec3): Mat4
  multiply(m: Mat4): Mat4
  inverse(): Mat4
  transformPoint(v: Vec3): Vec3
  transformVector(v: Vec3): Vec3
}
```

---

## 文件夹上传

### parsePmxFolderInput

```typescript
function parsePmxFolderInput(fileList: FileList | null | undefined): PmxFolderInputResult
```

返回值按 `status` 分支：
- `"empty"` — 无文件
- `"not_directory"` — 非目录上传
- `"no_pmx"` — 无 PMX 文件
- `"single"` — `{ files: File[], pmxFile: File }`
- `"multiple"` — `{ files: File[], pmxRelativePaths: string[] }`

### pmxFileAtRelativePath

```typescript
function pmxFileAtRelativePath(files: File[], relativePath: string): File | undefined
```

---

## 回调类型

### RaycastCallback

```typescript
type RaycastCallback = (
  modelName: string,       // 空字符串 = 未命中
  material: string | null, // 命中材质名
  bone: string | null,     // 命中骨骼名
  screenX: number,
  screenY: number
) => void
```

### GizmoDragCallback

```typescript
type GizmoDragCallback = (event: GizmoDragEvent) => void

interface GizmoDragEvent {
  modelName: string
  boneName: string
  boneIndex: number
  kind: "rotate" | "translate"
  localRotation: Quat
  localTranslation: Vec3
  phase?: "start" | "end"  // undefined = 拖拽中
}
```

---

## 常量

| 常量 | 值 | 说明 |
|------|---|------|
| `FPS` | `30` | 动画帧率 |
| `DEFAULT_BLOOM_OPTIONS` | `{ threshold: 0.5, knee: 0.5, radius: 4.0, ... }` | 默认 Bloom 设置 |
| `DEFAULT_VIEW_TRANSFORM` | `{ exposure: 0.6, gamma: 1.0, look: "medium_high_contrast" }` | 默认色调映射 |
