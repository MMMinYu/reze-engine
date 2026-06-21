# 物理系统文档

## 概述

Reze Engine 内置了一套完整的刚体物理引擎，约 1500 行 TypeScript，无外部依赖。专为 PMX 骨骼驱动设计，支持球/盒/胶囊碰撞体和 6DOF 弹簧约束，质量接近 Bullet 引擎默认配置。

## 模块结构

```
physics/
├── index.ts       # 公共导出
├── types.ts       # Rigidbody / Joint 接口 + 枚举
├── body.ts        # RigidBodyStore — SoA 数据存储
├── world.ts       # World — 步进管线
├── solver.ts      # solveConstraints — 投影 Gauss-Seidel
├── constraint.ts  # SixDofSpringConstraint — 6DOF 弹簧约束构建
├── contact.ts     # ContactPool / findContacts — 窄相碰撞
└── physics.ts     # RezePhysics — 顶层协调器
```

## 数据布局：RigidBodyStore (SoA)

所有刚体数据存储在平行的类型化数组中，避免 AoS 的缓存不友好：

```typescript
class RigidBodyStore {
  readonly count: number
  // 状态
  readonly positions: Float32Array        // 3*N
  readonly orientations: Float32Array     // 4*N (xyzw 四元数)
  readonly linearVelocities: Float32Array // 3*N
  readonly angularVelocities: Float32Array // 3*N
  // 常量
  readonly invMass: Float32Array          // N (static/kinematic = 0)
  readonly invInertia: Float32Array       // N (标量各向同性)
  readonly linearDamping: Float32Array    // N
  readonly angularDamping: Float32Array   // N
  readonly type: Uint8Array               // N (Static=0, Dynamic=1, Kinematic=2)
  readonly boneIndex: Int32Array          // N (-1 = 无骨骼绑定)
  readonly friction: Float32Array         // N
  readonly restitution: Float32Array      // N
  // 碰撞
  readonly collisionGroup: Uint16Array    // N (单 bit)
  readonly willCollideMask: Uint16Array   // N (16-bit 掩码)
  readonly shape: Uint8Array              // N (Sphere=0, Box=1, Capsule=2)
  readonly size: Float32Array             // 3*N (语义取决于形状)
  readonly aabbMin: Float32Array          // 3*N
  readonly aabbMax: Float32Array          // 3*N
  // 骨骼耦合
  readonly bodyOffsetMatrix: Float32Array      // 16*N column-major
  readonly bodyOffsetInverse: Float32Array     // 16*N column-major
}
```

### 碰撞对预过滤

`buildCollisionPairs()` 在构造时一次性计算所有可能碰撞的 (i, j) 对：
- 跳过 static-static 对（不会移动，不会碰撞）
- 跳过 group/mask 不匹配的对（PMX 16 组碰撞过滤）
- 结果存为 `Uint16Array`，每帧直接遍历，无需重新过滤

## 刚体类型

| 类型 | 值 | 行为 |
|------|---|------|
| Static | 0 | 不移动，跟随骨骼 bind pose，invMass = 0 |
| Dynamic | 1 | 受重力/约束驱动，写回骨骼 |
| Kinematic | 2 | 跟随骨骼动画 pose，invMass = 0，但参与约束（作为锚点） |

## 骨骼-刚体同步

### 骨骼 → 刚体（Kinematic/Static）

每帧从骨骼世界矩阵推导 kinematic 体的速度和位置：

```
bodyWorld = boneWorld × bodyOffsetMatrix
```

速度从帧间位置差推导（而非位置传送），使连接到快速运动肢体的关节感受到实际运动。

### 刚体 → 骨骼（Dynamic）

物理步进后，动态体的世界变换写回骨骼：

```
boneWorld = bodyWorld × bodyOffsetInverse
```

这覆盖了动画驱动的姿势，实现物理驱动的次级动画（头发、裙子等）。

## 步进管线

### 固定时间步

```typescript
private readonly fixedTimeStep = 1 / 60  // 60 Hz
private readonly maxSubSteps = 6
```

使用时间累加器，无论渲染帧率如何，物理始终以 60 Hz 步进。每渲染帧最多 6 个子步。固定 dt 保证弹簧冲量、阻尼和积分的确定性。

### 子步流程

```
predict velocities (重力 + 阻尼)
  → broadphase (AABB overlap + group/mask filter)
    → narrowphase (findContacts — 按形状分派)
      → solve constraints (10 iterations SI)
        → split-impulse position correction
          → integrate transforms
```

## 碰撞检测

### 窄相 (contact.ts)

`findContacts()` 对每个碰撞对按形状分派：

| 对 | 实现 |
|----|------|
| Sphere-Sphere | 距离 < 半径和 |
| Sphere-Capsule | 点-线段距离 |
| Sphere-Box | 最近点 + 半径 |
| Capsule-Capsule | 线段-线段最近点，近平行时生成多个接触点 |
| Capsule-Box | 线段-Box 最近点 |

**未实现**: Box-Box（PMX 模型极少使用）

### 接触约定

- `normal` 从 body A 指向 body B
- `depth` 正值 = 重叠，≤ 0 = 预测接触
- `rA` / `rB` = 从各质心到接触点的世界空间杠杆臂

### 预测接触 (Speculative Contacts)

`CONTACT_MARGIN = 0.04`：在近接触但未重叠时即生成接触。推力冲量钳位保持其惰性直到实际重叠，但防止快速物体在一个子步内穿过薄表面。

### 胶囊-胶囊多接触点

近平行的胶囊-胶囊碰撞生成多个沿轴的接触点，提供旋转稳定性。单点接触会让布料自由绕接触线旋转。

## 约束求解器 (solver.ts)

### 算法

投影 Gauss-Seidel 顺序冲量法，10 次迭代。

### 两阶段设计

1. **SETUP 阶段** — 计算不依赖速度的量（世界轴、杠杆臂、Jacobian 分母、目标速度、摩擦切线基）。这些在 pos/ori/inertia 不变时恒定。
2. **ITERATE 阶段** — `iterations` 次迭代，读取缓存并应用冲量。比重算快约 2×。

### 6DOF 弹簧约束

每个约束 6 个自由度：
- 线性 3 轴 (TA 基下的位置差)
- 角度 3 轴 (TA/TB 基间的 Euler-XYZ 差)

每轴行为：
- `min > max` → 自由轴
- `min === max` → 锁定轴
- 否则 → 限位轴，stop ERP = 0.475

弹簧驱动：`stiffness × (equilibriumPoint - currentPosition)` 产生目标速度。

### 分裂冲量位置修正

穿透通过沿接触法线的直接质量加权平移解决，**在速度求解器之外**。这样 SI 循环中的约束拉力不会对抗接触分离。

### 摩擦

每个接触 2 行 Coulomb 摩擦（切线基的两个方向），法向冲量钳位为推力（正值）。

## RezePhysics 顶层协调

```typescript
class RezePhysics {
  constructor(rigidbodies: Rigidbody[], joints: Joint[])
  step(dt, boneWorldMatrices, boneInverseBindMatrices): void
  reset(boneWorldMatrices): void  // 重新对齐到骨骼姿势，清零速度
}
```

### 首帧特殊处理

`firstFrame = true` 时：
1. `computeBoneOffsets()` — 计算 bodyOffsetMatrix
2. `snapBodiesToBones()` — 从当前骨骼姿势（非 bind pose）初始化体位置
3. 设置 `firstFrame = false`

这确保跳过 frame 0 的动画不会导致体位置弹出。

### 重置

`reset()` 调用 `snapBodiesToBones()` 将所有动态体重新对齐到骨骼姿势并清零速度。用于：
- 物理发散时
- 用户拖动时间线后

## 性能特征

- 349 个刚体的 PMX 模型：原始碰撞对 ~60k，过滤后几千
- 10 次 SI 迭代 + 分裂冲量位置修正
- 无休眠（布料必须始终响应骨骼运动）
- 静止体依赖 PMX 阻尼参数消除微速度
