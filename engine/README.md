# Reze Engine

A lightweight WebGPU engine for real-time 3D MMD/PMX model rendering, built with TypeScript.

## Install

```bash
npm install reze-engine
```

## Features

- Blinn-Phong lighting, alpha blending, rim lighting, outlines, MSAA 4x
- VMD animation (multiple named, non-interruptible), IK solver, Ammo/Bullet physics
- GPU picking (double-click/tap returns model + material name)
- Souls-style follow cam (orbit center bound to model bone)
- Optimized bind groups (per-frame / per-instance / per-material)
- Ground shadow mapping with PCF
- Multi-model (per-model materials, IK, physics)

## Quick Start

```javascript
import { Engine, Vec3 } from "reze-engine"

const engine = new Engine(canvas, {
  ambientColor: new Vec3(0.88, 0.92, 0.99),
  cameraDistance: 31.5,
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

## API

### Engine

| Method | Description |
|--------|-------------|
| `new Engine(canvas, options?)` | Create engine with optional config |
| `engine.init()` | Initialize WebGPU device and context |
| `engine.loadModel(path)` | Load PMX model (auto-named) |
| `engine.loadModel(name, path)` | Load PMX model with name |
| `engine.getModel(name)` | Get model by name |
| `engine.getModelNames()` | List all model names |
| `engine.removeModel(name)` | Remove model |
| `engine.setMaterialVisible(model, mat, visible)` | Show/hide material |
| `engine.toggleMaterialVisible(model, mat)` | Toggle material visibility |
| `engine.setIKEnabled(enabled)` | Enable/disable IK globally |
| `engine.setPhysicsEnabled(enabled)` | Enable/disable physics globally |
| `engine.resetPhysics()` | Reset physics to current pose |
| `engine.setCameraFollow(model, bone?, offset?)` | Follow cam bound to bone |
| `engine.setCameraTarget(vec3)` | Static camera target |
| `engine.setCameraDistance(d)` | Set orbit radius |
| `engine.setCameraAlpha(a)` | Set horizontal orbit angle |
| `engine.setCameraBeta(b)` | Set vertical orbit angle |
| `engine.addGround(options?)` | Add ground plane with shadows |
| `engine.runRenderLoop(callback?)` | Start render loop |
| `engine.stopRenderLoop()` | Stop render loop |
| `engine.getStats()` | Returns `{ fps, frameTime }` |
| `engine.dispose()` | Clean up all resources |

### Model

| Method | Description |
|--------|-------------|
| `model.loadAnimation(name, url)` | Load VMD animation |
| `model.show(name)` | Set pose at time 0 |
| `model.play(name?)` | Play animation (queued if busy) |
| `model.pause()` | Pause playback |
| `model.stop()` | Stop playback |
| `model.seek(time)` | Seek to time |
| `model.getAnimationProgress()` | `{ current, duration, percentage, animationName }` |
| `model.getAnimationState()` | Access animation controller |
| `model.rotateBones(rotations, ms?)` | Tween bone rotations |
| `model.moveBones(translations, ms?)` | Tween bone translations |
| `model.setMorphWeight(name, weight, ms?)` | Tween morph weight |
| `model.resetAllBones()` | Reset to bind pose |
| `model.resetAllMorphs()` | Reset all morph weights |
| `model.getBoneWorldPosition(name)` | World position of bone |

### Engine Options

```javascript
{
  ambientColor: Vec3,
  directionalLightIntensity: number,
  minSpecularIntensity: number,
  rimLightIntensity: number,
  cameraDistance: number,
  cameraTarget: Vec3,
  cameraFov: number,
  onRaycast: (modelName, material, screenX, screenY) => void,
}
```

## Projects Using This Engine

- **[MiKaPo](https://mikapo.vercel.app)** - Real-time motion capture for MMD
- **[Popo](https://popo.love)** - LLM-generated MMD poses
- **[MPL](https://mmd-mpl.vercel.app)** - Motion programming language for MMD
- **[Mixamo-MMD](https://mixamo-mmd.vercel.app)** - Retarget Mixamo FBX to VMD

## Tutorial

[How to Render an Anime Character with WebGPU](https://reze.one/tutorial)
