# 动画系统文档

## 概述

Reze Engine 的动画系统围绕 VMD (Vocaloid Motion Data) 格式设计，支持骨骼旋转/平移关键帧、变形权重关键帧、贝塞尔插值曲线、IK 求解和优先级播放。

## 模块结构

| 文件 | 职责 |
|------|------|
| `animation.ts` | AnimationClip 数据结构、AnimationState 播放器、插值函数 |
| `vmd-loader.ts` | VMD 二进制解析 → VMDKeyFrame[] |
| `vmd-writer.ts` | AnimationClip → VMD 二进制导出 |
| `model.ts` | 骨骼姿势应用、变形应用、补间系统、IK 桥接 |
| `ik-solver.ts` | CCD 式 IK 求解器 |

## 数据流

```
VMD 文件
  │
  ├─ VMDLoader.load() / loadFromBuffer()
  │    └─ 解析 Shift-JIS 编码的骨骼名/变形名
  │    └─ 读取关键帧（旋转 + 平移 + 64字节插值参数）
  │    └─ 输出 VMDKeyFrame[]
  │
  ├─ Model.loadVmd(name, url)
  │    └─ VMDKeyFrame[] → AnimationClip
  │         ├─ boneTracks: Map<string, BoneKeyframe[]>  (骨骼名 → 关键帧数组)
  │         └─ morphTracks: Map<string, MorphKeyframe[]> (变形名 → 关键帧数组)
  │
  ├─ AnimationState.loadAnimation(name, clip)
  │    └─ 存入内部 Map
  │
  └─ Model.play(name, options?)
       └─ AnimationState 切换到指定动画
```

## AnimationClip

```typescript
interface AnimationClip {
  boneTracks: Map<string, BoneKeyframe[]>   // 骨骼名 → 关键帧数组
  morphTracks: Map<string, MorphKeyframe[]> // 变形名 → 关键帧数组
  frameCount: number                         // 最后一帧的帧索引
}
```

帧率固定 30 FPS（`FPS` 常量），时间 = frame / 30。

### BoneKeyframe

```typescript
interface BoneKeyframe {
  boneName: string
  frame: number
  rotation: Quat
  translation: Vec3
  interpolation: BoneInterpolation
}
```

### MorphKeyframe

```typescript
interface MorphKeyframe {
  morphName: string
  frame: number
  weight: number  // 0.0 ~ 1.0
}
```

### BoneInterpolation

VMD 中每帧有 64 字节的插值参数，分为 4 组贝塞尔控制点：

```typescript
interface BoneInterpolation {
  rotation: ControlPoint[]       // 4 个控制点
  translationX: ControlPoint[]
  translationY: ControlPoint[]
  translationZ: ControlPoint[]
}
```

每组控制点定义一条贝塞尔曲线，用于在该帧和下一帧之间插值。

## 插值

### 贝塞尔插值

`interpolateControlPoints()` 将 VMD 的 4 字节控制点对 (ax, ay, bx, by) 转换为标准贝塞尔曲线，然后通过二分搜索求 t 使得 B(t) = 当前进度。

### 旋转插值

骨骼旋转使用球面线性插值 (Slerp)，由 `Quat.slerp()` 实现。

### 平移插值

骨骼平移使用分量线性插值，每个分量 (X/Y/Z) 有独立的贝塞尔曲线。

### 变形插值

变形权重使用线性插值。

## AnimationState 播放器

### 优先级系统

```typescript
interface QueuedAnimationRequest {
  name: string
  priority: number  // 越高越优先，默认 0
  loop: boolean
}
```

- 高优先级请求抢占当前播放
- 同优先级时最新请求胜出
- 低优先级请求排队，当前动画结束后播放

### 播放控制

| 方法 | 行为 |
|------|------|
| `loadAnimation(name, clip)` | 注册动画 |
| `play(name, priority, loop)` | 请求播放（优先级竞争） |
| `pause()` | 暂停时间线 |
| `stop()` | 停止并重置 |
| `seek(frame)` | 跳转到指定帧 |

### 循环

`loop: true` 时，播放头在 clip 末尾回绕到开头，直到 stop/pause 或另一个 play。

## 骨骼姿势应用

在 `Model.applyAnimationClip()` 中：

1. 从 AnimationState 获取当前帧索引
2. 对每个骨骼轨道：
   - 找到前后两个关键帧
   - 用贝塞尔曲线计算插值因子
   - Slerp 旋转，lerp 平移
   - 写入 `runtimeSkeleton.localRotations[i]` / `localTranslations[i]`
3. 对每个变形轨道：
   - 线性插值权重
   - 写入 `runtimeMorph.weights[i]`

## 补间系统 (Tween)

Model 内部的 `TweenState` 允许外部代码平滑地覆盖骨骼姿势：

```typescript
// 旋转补间
model.rotateBones({ 首: quat }, 300)  // 300ms 补间到目标旋转

// 平移补间
model.moveBones({ センター: vec3 }, 300)  // 300ms 补间到目标平移

// 变形补间
model.setMorphWeight("微笑", 0.8, 200)  // 200ms 补间到目标权重
```

补间与动画采样共存：补间激活时覆盖动画值，补间结束后恢复动画值。

### TweenState 内部

```typescript
interface TweenState {
  // 旋转
  rotActive: Uint8Array       // 0/1 per bone
  rotStartQuat: Quat[]        // 起始旋转
  rotTargetQuat: Quat[]       // 目标旋转
  rotStartTimeMs: Float32Array
  rotDurationMs: Float32Array

  // 平移 (同构)
  transActive: Uint8Array
  transStartVec: Vec3[]
  transTargetVec: Vec3[]
  transStartTimeMs: Float32Array
  transDurationMs: Float32Array

  // 变形 (同构)
  morphActive: Uint8Array
  morphStartWeight: Float32Array
  morphTargetWeight: Float32Array
  morphStartTimeMs: Float32Array
  morphDurationMs: Float32Array
}
```

补间使用 ease-in-out 二次缓动（`easeInOut()` in `math.ts`）。

## IK 求解器

### 概述

CCD (Cyclic Coordinate Descent) 式 IK，参考 Saba MMDIkSolver。在 `Model.getSkinMatrices()` 中，骨骼世界矩阵计算后执行。

### IKChain

每个 IK 链从末端效应器 (effector) 到根骨骼：

```typescript
interface IKSolver {
  ikBoneIndex: number      // IK 目标骨骼
  targetBoneIndex: number  // 目标位置骨骼
  iterationCount: number   // 迭代次数
  limitAngle: number       // 每次迭代最大旋转
  links: IKLink[]          // 链中骨骼
}

interface IKLink {
  boneIndex: number
  hasLimit: boolean
  minAngle?: Vec3  // Euler 角限制 (弧度)
  maxAngle?: Vec3
}
```

### 求解过程

1. 对每个 IK solver：
   - 计算目标位置（target bone 的世界位置）
   - 对每个链中骨骼（从末端到根）：
     - 计算当前末端到目标的旋转
     - 应用角度限制
     - 更新骨骼的 localRotation
     - 重新计算世界矩阵
   - 重复 `iterationCount` 次

### 角度限制优化

根据限制范围自动选择 Euler 旋转顺序：
- X 轴限制在 ±π/2 内 → YXZ
- Y 轴限制在 ±π/2 内 → ZYX
- 其他 → XZY

单轴限制时只求解该轴（`solveAxis` 优化），跳过无关计算。

## 变形系统 (Morph)

### 变形类型

| 类型 | 值 | 用途 |
|------|---|------|
| Group | 0 | 组合多个变形 |
| Vertex | 1 | 顶点偏移 |
| Bone | 2 | 骨骼变形 |
| UV | 3 | UV 偏移 |
| Material | 8 | 材质参数修改 |

### 顶点变形应用

`Model.applyMorphs()` 在每帧执行：

1. 遍历所有变形，按权重累积偏移
2. Group 变形递归展开（按 ratio 加权）
3. 写入 `vertexData`（从 `baseVertexData` + 偏移）
4. 设置 `morphsDirty = true`，触发 GPU 顶点缓冲区重新上传

### 变形权重

```typescript
model.setMorphWeight(name, weight, ms?)  // 设置权重 (0~1)，可选补间
model.resetAllMorphs()                    // 重置所有权重为 0
```

## VMD 导出

`Model.exportVmd(name)` 将已加载的 clip 序列化回 VMD 二进制格式：

1. 骨骼/变形名用 Shift-JIS 编码（兼容标准 MMD 工具）
2. 插值参数从 `BoneInterpolation` 转换回 64 字节格式
3. 返回 `ArrayBuffer`，可创建 Blob 下载

### Shift-JIS 编码

`vmd-writer.ts` 在首次调用时构建 Unicode → Shift-JIS 查找表（单字节 + 双字节范围），缓存为模块级变量。

## Clip Apply Suspend

`model.setClipApplySuspended(true)` 冻结动画重采样，使直接骨骼写入跨帧持久。用于交互式姿势编辑：

- `play()` / `seek()` 自动清除 suspend 标志
- 编辑模式下暂停 + suspend，拖拽 Gizmo 直接写骨骼
- 恢复播放时动画覆盖编辑

## 动画进度查询

```typescript
const prog = model.getAnimationProgress()
// {
//   animationName: string | null,
//   current: number,      // 秒
//   duration: number,     // 秒
//   percentage: number,   // 0~100
//   looping: boolean,
//   playing: boolean,
//   paused: boolean
// }
```
