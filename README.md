# Reze Engine

A lightweight WebGPU engine for real-time 3D MMD/PMX model rendering, built with TypeScript.

![screenshot](./screenshot.png)

## Install

```bash
npm install reze-engine
```

## Features

- **Rendering:** Blinn-Phong lighting, alpha blending, rim lighting, outlines, MSAA 4x
- **Animation:** VMD animation (multiple named animations, non-interruptible playback), IK solver, Ammo/Bullet physics
- **Interaction:** GPU picking (double-click/tap returns model name, material name, screen coordinates)
- **Camera:** Orbit camera with Souls-style follow cam (bind orbit center to model bone)
- **Performance:** Optimized bind group layout (per-frame / per-instance / per-material), ground shadow mapping with PCF
- **Multi-model:** Per-model materials, IK, physics, vertex buffer management

## Usage

```javascript
import { Engine, Vec3 } from "reze-engine"

const engine = new Engine(canvas, {
  ambientColor: new Vec3(0.88, 0.92, 0.99),
  cameraDistance: 31.5,
  cameraTarget: new Vec3(0, 11.5, 0),
})
await engine.init()

const model = await engine.loadModel("hero", "/models/hero/hero.pmx")
await model.loadAnimation("idle", "/animations/idle.vmd")
model.show("idle")
model.play()

engine.setCameraFollow(model, "センター", new Vec3(0, 3.5, 0))
engine.addGround({ width: 160, height: 160 })
engine.runRenderLoop()
```

### Engine Options

```javascript
{
  ambientColor: new Vec3(0.88, 0.88, 0.88),
  directionalLightIntensity: 0.24,
  minSpecularIntensity: 0.3,
  rimLightIntensity: 0.4,
  cameraDistance: 26.6,
  cameraTarget: new Vec3(0, 12.5, 0),
  cameraFov: Math.PI / 4,
  onRaycast: (modelName, material, screenX, screenY) => {},
}
```

## API

One WebGPU **Engine** per page (singleton after `init()`). Load models via `engine.loadModel(path)` (auto-named) or `engine.loadModel(name, path)`; returns the **Model**.

### Multi-model

```javascript
const model = await engine.loadModel("hero", "/models/hero.pmx")
engine.getModelNames()           // ["hero"]
engine.getModel("hero")          // Model
engine.removeModel("hero")

engine.setMaterialVisible("hero", "body", false)
engine.toggleMaterialVisible("hero", "body")
engine.isMaterialVisible("hero", "body")

engine.setIKEnabled(true)
engine.setPhysicsEnabled(true)
engine.resetPhysics()
engine.markVertexBufferDirty("hero")
```

### Animation

Animations are non-interruptible: the next one starts only when the current one finishes (or is queued).

```javascript
await model.loadAnimation("idle", "/animations/idle.vmd")
await model.loadAnimation("walk", "/animations/walk.vmd")

model.show("idle")       // set pose at time 0, no playback
model.play("walk")       // play "walk"; queued if something is playing
model.play()             // resume current
model.pause()
model.stop()
model.seek(1.5)

model.getAnimationProgress()  // { current, duration, percentage, animationName }
model.getAnimationState().setOnEnd((name) => model.play("idle"))
```

### Bone and Morph Tweening

```javascript
model.rotateBones({ 首: neckQuat, 頭: headQuat }, 300)
model.moveBones({ センター: centerVec }, 300)
model.setMorphWeight("まばたき", 1.0, 300)
model.resetAllBones()
model.resetAllMorphs()
```

### Camera

```javascript
// Souls-style follow cam: orbit center tracks a model bone
engine.setCameraFollow(model, "センター", new Vec3(0, 3.5, 0))
engine.setCameraFollow(null)  // unbind

// Static target
engine.setCameraTarget(new Vec3(0, 12, 0))

// Read/write orbit parameters
engine.getCameraDistance()
engine.setCameraDistance(8)
engine.getCameraAlpha()
engine.setCameraAlpha(Math.PI)
engine.getCameraBeta()
engine.setCameraBeta(Math.PI / 2.5)
```

### Ground and Shadows

```javascript
engine.addGround({
  width: 160,
  height: 160,
  diffuseColor: new Vec3(1, 1, 1),
  fadeStart: 10.0,
  fadeEnd: 80.0,
  shadowMapSize: 4096,
  shadowStrength: 1.0,
})
```

### GPU Picking

```javascript
const engine = new Engine(canvas, {
  onRaycast: (modelName, material, screenX, screenY) => {
    console.log(`Clicked ${modelName} / ${material} at (${screenX}, ${screenY})`)
  },
})
```

Double-click (desktop) or double-tap (mobile) triggers a GPU pick pass that returns the model name and material name under the cursor.

### Render Loop and Lifecycle

```javascript
engine.runRenderLoop(() => {
  const stats = engine.getStats()  // { fps, frameTime }
})
engine.stopRenderLoop()
engine.dispose()
```

## Projects Using This Engine

- **[MiKaPo](https://mikapo.vercel.app)** - Online real-time motion capture for MMD using webcam and MediaPipe
- **[Popo](https://popo.love)** - Fine-tuned LLM that generates MMD poses from natural language descriptions
- **[MPL](https://mmd-mpl.vercel.app)** - Semantic motion programming language for scripting MMD animations with intuitive syntax
- **[Mixamo-MMD](https://mixamo-mmd.vercel.app)** - Retarget Mixamo FBX animation to VMD in one click

## Tutorial

Learn WebGPU from scratch by building an anime character renderer in incremental steps.

[How to Render an Anime Character with WebGPU](https://reze.one/tutorial)
