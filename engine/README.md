# Reze Engine

A minimal-dependency WebGPU engine for real-time MMD/PMX rendering. Only external dependency is Ammo.js for physics.

## Install

```bash
npm install reze-engine
```

## Features

- Blinn-Phong shading, alpha blending, rim lighting, outlines, MSAA 4x
- VMD animation with IK solver and Bullet physics
- Orbit camera with bone-follow mode
- GPU picking (double-click/tap)
- Ground plane with PCF shadow mapping
- Multi-model support

## Quick Start

```javascript
import { Engine, Vec3 } from "reze-engine"

const engine = new Engine(canvas, {
  ambientColor: new Vec3(0.88, 0.92, 0.99),
  cameraDistance: 31.5, // MMD units (1 unit = 8 cm)
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
| `engine.setCameraFollow(model, bone?, offset?)` | Orbit center tracks a bone |
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
  physicsOptions: {
    constraintSolverKeywords: string[],
  },
}
```

`constraintSolverKeywords` — joints whose name contains any keyword use the Bullet 2.75 constraint solver; all others keep the stable Ammo 2.82+ default. See [babylon-mmd: Fix Constraint Behavior](https://noname0310.github.io/babylon-mmd/docs/reference/runtime/apply-physics-to-mmd-models/#fix-constraint-behavior) for details.

## Projects Using This Engine

- **[MiKaPo](https://mikapo.vercel.app)** — Real-time motion capture for MMD
- **[Popo](https://popo.love)** — LLM-generated MMD poses
- **[MPL](https://mmd-mpl.vercel.app)** — Motion programming language for MMD
- **[Mixamo-MMD](https://mixamo-mmd.vercel.app)** — Retarget Mixamo FBX to VMD

## Tutorial

[How to Render an Anime Character with WebGPU](https://reze.one/tutorial)
