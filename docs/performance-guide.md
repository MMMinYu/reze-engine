# Reze Engine 性能性价比优化指南

> 本文档按 ROI（投入产出比）从高到低排列所有优化项，帮助开发者以最小改动获得最大收益。
> 如果代码更新导致文档描述和代码不一致，必须更新文档。

## 现状概览

### 资源消耗分布（典型 PMX 场景，1 角色 ~50k 三角）

| 模块 | CPU 占比 | GPU 占比 | 视觉贡献 |
|------|---------|---------|---------|
| 渲染管线 + 着色器 | ~10% | ~90% | 90% |
| 物理引擎 | ~30-50% | 0% | 10% |
| 动画 / IK | ~20-30% | 0% | 5% |
| 骨骼矩阵上传 | ~5-10% | 0% | 间接（蒙皮依赖） |
| 其他（相机、拾取等） | ~5% | 0% | 5% |

### 核心矛盾

**物理引擎消耗 30-50% CPU 时间，但视觉贡献仅 10%。GPU 利用率仅 5-15%，大量算力闲置。**

---

## 第一梯队：零成本 / 极低成本改动

### 1.1 减少物理求解器迭代次数

- **文件**: `engine/src/physics/world.ts`
- **改动**: `solverIterations = 10` → `solverIterations = 5`
- **CPU 节省**: ~40-50% 物理时间
- **视觉影响**: 几乎不可见（MMD 物理是装饰性的，5 次迭代对裙摆/头发摆动无感知差异）
- **风险**: 极低。如需更高精度，可对特定场景动态调整

```typescript
// world.ts — 改动前
solverIterations = 10

// world.ts — 改动后
solverIterations = 5
```

### 1.2 减少物理子步上限

- **文件**: `engine/src/physics/physics.ts`
- **改动**: `maxSubSteps = 6` → `maxSubSteps = 3`
- **CPU 节省**: 静止场景 0%，剧烈运动场景 ~50% 物理时间
- **视觉影响**: 仅在极端运动（快速拖拽骨骼）时可能略有穿模
- **风险**: 低。`timeAccum` 机制保证时间累积正确

```typescript
// physics.ts — 改动前
private readonly maxSubSteps = 6

// physics.ts — 改动后
private readonly maxSubSteps = 3
```

### 1.3 线性阻尼替代指数阻尼

- **文件**: `engine/src/physics/world.ts`，`step()` 方法
- **改动**: `Math.pow(1 - damping, dt)` → `1 - damping * dt`
- **CPU 节省**: ~10-15% 物理时间（`Math.pow` 是昂贵的超越函数）
- **视觉影响**: 不可见（PMX 阻尼值通常 0.01-0.99，两种近似在 dt=1/60 下差异 <0.5%）
- **风险**: 低。高阻尼值（>0.99）时线性近似可能略欠阻尼，但 PMX 实际很少使用

```typescript
// world.ts step() — 改动前
const ld = Math.pow(Math.max(0, 1 - ldamp[i]), dt)
const ad = Math.pow(Math.max(0, 1 - adamp[i]), dt)

// world.ts step() — 改动后
const ld = Math.max(0, 1 - ldamp[i] * dt)
const ad = Math.max(0, 1 - adamp[i] * dt)
```

### ~~1.4 碰撞对静态体跳过~~（已实现）

> 此优化已在代码中实现。`RigidBodyStore.getCollisionPairs()`（`body.ts`）在构建候选对时已过滤掉双静态体对（`invMass` 均为 0），`findContacts()` 拿到的 pairs 中不包含静态-静态对。

### 第一梯队预期收益

| 指标 | 改动前 | 改动后 | 提升 |
|------|--------|--------|------|
| 物理迭代次数/子步 | 10 | 5 | 50% |
| 最大子步数 | 6 | 3 | 50%（运动场景） |
| 阻尼计算 | Math.pow | 线性 | 10-15% 物理 |
| **物理总 CPU 时间** | **基线** | **约 30-40% 基线** | **60-70% 降低** |
| **整体帧时间** | **基线** | **约 75-85% 基线** | **15-25% 提升** |

---

## 第二梯队：低成本改动（< 200 行）

### 2.1 空间哈希宽相碰撞

- **文件**: 新建 `engine/src/physics/broadphase.ts`，修改 `contact.ts` 的 `findContacts()`
- **问题**: 当前 `getCollisionPairs()` 预过滤后仍有数千对，每子步全部做 AABB overlap 测试
- **方案**: 基于空间哈希的宽相，只检测相邻格子中的 body 对
- **CPU 节省**: 20-30% 物理时间（碰撞对从数千降至数百）
- **视觉影响**: 无
- **风险**: 低。空间哈希对均匀分布的 body 效果最好，PMX 角色恰好满足

**实现要点**:
- 格子大小 = 最大 body 尺寸 + CONTACT_MARGIN
- 每帧重建哈希表（body 数量少，重建成本可忽略）
- 替换 `findContacts()` 中的线性遍历

### 2.2 骨骼矩阵 CPU 端优化

- **文件**: `engine/src/model.ts`，`getSkinMatrices()`
- **问题**: 每帧可能创建新的 Float32Array 或做不必要的矩阵计算
- **方案**: 确保 skin matrix buffer 是预分配的，每帧原地更新
- **CPU 节省**: 5-10%（减少 GC 压力和分配开销）
- **视觉影响**: 无

### 2.3 动画采样避免对象分配

- **文件**: `engine/src/model.ts`，`applyAnimationClip()`
- **问题**: 插值采样可能每帧创建临时 Vec3/Quat 对象
- **方案**: 使用预分配的 scratch 对象（与物理/IK 的 scratch pool 模式一致）
- **CPU 节省**: 5-10%（减少 GC 暂停）
- **视觉影响**: 无

### 2.4 纹理上传优化

- **文件**: `engine/src/engine.ts`，`createTextureFromLogicalPath()`
- **问题**: 纹理逐个上传，无 mipmap 预生成
- **方案**: 使用 `GPUQueue.copyExternalImageToTexture()` 批量上传 + compute shader mipmap 生成（已有 `mipmap.ts`）
- **CPU 节省**: 仅初始化时，但减少首帧卡顿
- **视觉影响**: mipmap 改善远距离纹理质量

### 第二梯队预期收益

| 改动 | CPU 节省 | 开发量 |
|------|---------|--------|
| 空间哈希宽相 | 20-30% 物理 | ~200 行 |
| 骨骼矩阵预分配 | 5-10% | ~30 行 |
| 动画 scratch pool | 5-10% | ~50 行 |
| 纹理上传优化 | 初始化 | ~50 行 |

---

## 第三梯队：中等成本改动（200-500 行）

### 3.1 Compute Shader 蒙皮矩阵计算

- **文件**: 新建 `engine/src/shaders/passes/skin_compute.ts`，修改 `engine.ts`
- **问题**: 当前 CPU 计算骨骼世界矩阵 → `writeBuffer` 上传 → GPU 读取。每帧 ~0.5-1ms
- **方案**: GPU Compute Shader 直接计算骨骼矩阵，零上传
- **CPU 节省**: 消除 `updateSkinMatrices()` 的 CPU 时间 + writeBuffer 带宽
- **GPU 开销**: ~0.01ms（200 骨骼 × 矩阵乘法对 GPU 微不足道）
- **视觉影响**: 无
- **风险**: 中。需要重构骨骼数据流

**实现要点**:
1. 将骨骼层级关系（parentIndex、localTransform）打包为 GPU buffer
2. Compute Shader 按 parent 深度分层计算世界矩阵（确保 parent 先于 child）
3. 动画采样仍在 CPU（VMD 帧数据不适合 GPU 解析），只上传 local rotation/translation
4. 物理驱动的骨骼变换：CPU 上传物理结果到 GPU buffer，Compute Shader 合并

**数据流变化**:
```
改动前: CPU 动画采样 → CPU 矩阵计算 → writeBuffer → GPU 蒙皮
改动后: CPU 动画采样 → writeBuffer(localRot/localTrans) → GPU Compute 矩阵 → GPU 蒙皮
```

### 3.2 SSAO / GTAO

- **文件**: 新建 `engine/src/shaders/passes/ssao.ts`，修改 `engine.ts`
- **问题**: 当前无环境光遮蔽，角色看起来"飘"在地面上
- **方案**: 基于深度 buffer 的 GTAO（Ground Truth Ambient Occlusion），1 个 Compute Pass
- **CPU 节省**: 0
- **视觉提升**: 显著（角色与地面/自身的接触阴影）
- **GPU 开销**: ~0.2-0.5ms（半分辨率计算 + 双边滤波）

**实现要点**:
1. 主渲染 pass 需输出深度 buffer（当前已有）
2. 可选：输出法线 buffer（从深度 buffer 重建也可，但精度略低）
3. GTAO 采样 3-5 个方向 × 2-4 步，半分辨率
4. 双边滤波去噪后叠加到最终颜色

### 3.3 IBL 环境光照

- **文件**: 新建 `engine/src/shaders/passes/ibl.ts`，修改材质着色器
- **问题**: 当前只有 1 个方向光 + 世界环境色，金属/光滑材质缺乏环境反射
- **方案**: 预过滤环境贴图 + irradiance map（已有 BRDF LUT）
- **CPU 节省**: 0
- **视觉提升**: 巨大（金属、眼睛、头发的高光反射质变）
- **GPU 开销**: 每像素 1 次 irradiance 采样 + 1 次 prefiltered 采样

**实现要点**:
1. 引擎提供默认 HDR 环境贴图（或从 World color 生成）
2. 初始化时用 Compute Shader 生成 irradiance map + prefiltered mip chain
3. 材质着色器中替换 `worldColor * worldStrength` 为 IBL 采样
4. 已有 `ltc_mag_lut.ts` 和 `dfg_lut.ts`，只需补环境贴图部分

### 3.4 Draw Call 合并

- **文件**: 修改 `engine.ts` 的 `createDrawCalls()` 和 `renderOneModel()`
- **问题**: 每个材质 1 个 draw call，30 个材质 = 30+ draw calls + 管线状态切换
- **方案**: 相同 preset 的 submesh 合并为 1 个 draw call（使用 indirect draw 或统一 vertex buffer）
- **CPU 节省**: 减少 50-70% draw calls
- **视觉影响**: 无
- **风险**: 中。需要重构 draw call 创建逻辑

### 第三梯队预期收益

| 改动 | CPU 节省 | 视觉提升 | 开发量 |
|------|---------|---------|--------|
| Compute 蒙皮 | 消除 writeBuffer | 无 | ~300 行 |
| SSAO | 0 | 显著 | ~300 行 |
| IBL | 0 | 巨大 | ~400 行 |
| Draw call 合并 | 50-70% draw calls | 间接 | ~300 行 |

---

## 第四梯队：高成本改动（500+ 行）

### 4.1 级联阴影（CSM）

- **问题**: 单层 shadow map 在近距离锯齿严重、远距离分辨率不足
- **方案**: 3-4 级 CSM + PCF 软阴影
- **视觉提升**: 大（阴影质量质变）
- **GPU 开销**: ~0.5-1ms（3-4 次 shadow pass）
- **开发量**: ~500 行

### 4.2 屏幕空间反射（SSR）

- **问题**: 金属材质无环境反射，看起来不真实
- **方案**: 基于深度 buffer 的光线步进 SSR
- **视觉提升**: 大（金属/地板反射）
- **GPU 开销**: ~1-2ms
- **开发量**: ~500 行

### 4.3 TAA（时域抗锯齿）

- **问题**: 4x MSAA 带宽开销大（4 倍颜色 + 深度），且无法处理着色锯齿
- **方案**: TAA 替代 MSAA，带宽减半 + 着色抗锯齿
- **视觉提升**: 中（更稳定的画面）
- **GPU 开销**: 减少（无需 4x MSAA）
- **开发量**: ~400 行（需要运动 vector pass + 历史帧管理）

### 4.4 Order-Independent Transparency

- **问题**: 透明物体需要 CPU 排序，且排序不完美（交叉透明体）
- **方案**: Weighted Blended OIT 或 Per-Pixel Linked List
- **视觉提升**: 中（消除透明排序错误）
- **CPU 节省**: 消除 drawCalls 排序
- **开发量**: ~400 行

### 4.5 GPU 物理求解

- **问题**: CPU 物理占 30-50% 帧时间
- **方案**: 将约束求解搬到 Compute Shader（需 Jacobi 迭代替代 Gauss-Seidel）
- **CPU 节省**: 消除物理 CPU 时间
- **视觉影响**: Jacobi 收敛更慢，可能需要更多迭代
- **风险**: 高。回读 stall 可能抵消收益，需全 GPU 管线（物理→骨骼→蒙皮→渲染零 CPU 介入）
- **开发量**: ~1500 行

**警告**: 单独做 GPU 物理大概率更慢（dispatch 开销 + 回读 stall）。只有配合 Compute Shader 蒙皮 + GPU 骨骼更新形成全 GPU 管线时才有收益。

---

## 优化路线图

### 阶段一：立即执行（1 小时内）

1. `solverIterations` 10 → 5
2. `maxSubSteps` 6 → 3
3. `Math.pow` 阻尼 → 线性近似（⚠️ 仅低阻尼场景）
4. ~~碰撞对静态体跳过~~（已实现）

**预期**: 物理 CPU 时间降低 50-60%，整体帧时间提升 10-20%

### 阶段二：短期优化（1-3 天）

1. 空间哈希宽相
2. ~~骨骼矩阵预分配~~（已实现）
3. 动画 scratch pool

**预期**: 再降低 5-10% CPU 时间，减少 GC 暂停

### 阶段三：视觉提升（1-2 周）

1. Compute Shader 蒙皮
2. SSAO
3. IBL 环境光

**预期**: 视觉质量显著提升，GPU 利用率从 5-15% 提升到 20-30%

### 阶段四：进阶渲染（2-4 周）

1. CSM + PCF
2. Draw call 合并
3. TAA
4. SSR

**预期**: 接近 Blender EEVEE 的视觉水平，GPU 利用率 30-50%

### 阶段五：全 GPU 管线（1-2 月，可选）

1. GPU 物理求解
2. GPU 骨骼更新
3. OIT

**预期**: GPU 利用率 50-70%，CPU 几乎空闲

---

## 性能测量方法

### CPU 瓶颈定位

```typescript
// 在 render() 中插入计时
const t0 = performance.now()
this.updateInstances(deltaTime)        // 动画 + 物理
const t1 = performance.now()
this.updateSkinMatrices()              // 骨骼上传
const t2 = performance.now()
// ... 渲染 ...
const t3 = performance.now()
console.log(`anim+phys: ${t1-t0}ms, skin: ${t2-t1}ms, gpu submit: ${t3-t2}ms`)
```

### GPU 瓶颈定位

使用 WebGPU timestamp query：
```typescript
const querySet = device.createQuerySet({ type: "timestamp", count: 2 })
// 在 pass 开始/结束写入 timestamp
pass.writeTimestamp(querySet, 0)  // 开始
// ... 渲染 ...
pass.writeTimestamp(querySet, 1)  // 结束
```

### 关键指标

| 指标 | 目标值 | 当前估计 |
|------|--------|---------|
| 物理时间/帧 | < 1ms | 2-5ms |
| 骨骼上传/帧 | 0ms（Compute） | 0.5-1ms |
| Draw calls/帧 | < 15 | 30+ |
| GPU 利用率 | > 30% | 5-15% |
| GC 暂停/秒 | 0 | 1-3 次 |

---

## 反模式警告

### 不要做的事

1. **不要盲目增加物理精度** — MMD 物理是装饰性的，更高精度不等于更好看
2. **不要单独做 GPU 物理** — 没有全 GPU 管线，回读 stall 会让性能更差
3. **不要用 WASM 重写整个引擎** — 瓶颈在 GPU 端和 CPU 物理分配，WASM 整体提升 < 15%
4. **不要用 C++/Rust 重写** — 同上，且丧失零依赖和浏览器部署优势
5. **不要过早优化着色器** — 当前着色器不是瓶颈，GPU 闲着不是着色器慢
6. **不要增加 MSAA 采样数** — 4x 已足够，更高倍数带宽开销指数增长，应改 TAA

### 要做的事

1. **先测量再优化** — 用 `performance.now()` 和 timestamp query 定位真实瓶颈
2. **优先降低物理开销** — 这是当前最大的 CPU 浪费
3. **优先增加 GPU 工作量** — GPU 闲着 = 硬件投资浪费
4. **保持 SoA 数据布局** — 这是当前代码最正确的架构决策之一
5. **保持零依赖** — 这是项目最大的部署优势
