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
- Ground plane with PCF shadow mapping, grid lines, and frosted texture
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
| `model.loadAnimation(name, clip)` | Load/replace animation clip directly |
| `model.show(name)` | Set pose at time 0 (resets bones and morphs first) |
| `model.play(name?)` | Play animation (queued if busy; named play resets bones/morphs first) |
| `model.play(name, { priority?, loop? })` | Priority-aware play; `loop` wraps at end (`0` default/lowest priority) |
| `model.pause()` | Pause playback |
| `model.stop()` | Stop playback |
| `model.seek(time)` | Seek to time |
| `model.getAnimationProgress()` | `{ current, duration, percentage, animationName, looping, playing, paused }` — `current`/`duration` are seconds |
| `model.getAnimationClip(name)` | Get loaded clip by name |
| `model.rotateBones(rotations, ms?)` | Tween bone rotations |
| `model.moveBones(translations, ms?)` | Tween bone translations |
| `model.setMorphWeight(name, weight, ms?)` | Tween morph weight |
| `model.resetAllBones()` | Reset to bind pose |
| `model.resetAllMorphs()` | Reset all morph weights |
| `model.getBoneWorldPosition(name)` | World position of bone |

`AnimationClip` is frame-based: `frameCount` is the last keyframe frame index, keyframes store `frame`. Engine playback uses fixed 30 FPS. Looping is controlled via `play(name, { loop: true })`, not on the clip.

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
  shadowLightDirection: Vec3,
  physicsOptions: {
    constraintSolverKeywords: string[],
  },
}
```

`shadowLightDirection` — direction of the shadow-only light, independent of the visible directional light. Default `(0.12, -1, 0.16)` casts a near-top-down shadow with a slight offset so extended limbs still project visible shadows.

`constraintSolverKeywords` — joints whose name contains any keyword use the Bullet 2.75 constraint solver; all others keep the stable Ammo 2.82+ default. See [babylon-mmd: Fix Constraint Behavior](https://noname0310.github.io/babylon-mmd/docs/reference/runtime/apply-physics-to-mmd-models/#fix-constraint-behavior) for details.

### Ground Options

```javascript
engine.addGround({
  width: 100,            // ground plane width
  height: 100,           // ground plane depth
  diffuseColor: Vec3,    // base color (default: 0.8, 0.1, 1.0)
  fadeStart: 5.0,        // distance where edge fade begins
  fadeEnd: 60.0,         // distance where ground fully fades out
  shadowMapSize: 4096,   // shadow map resolution
  shadowStrength: 1.0,   // shadow darkness
  gridSpacing: 5.0,      // world-space distance between grid lines
  gridLineWidth: 0.012,  // thickness of grid lines
  gridLineOpacity: 0.4,  // grid line visibility (0–1)
  gridLineColor: Vec3,   // grid line color (default: 0.8, 0.8, 0.8)
  noiseStrength: 0.08,   // frosted/matte micro-texture intensity
})
```

## Projects Using This Engine

- **[MiKaPo](https://mikapo.vercel.app)** — Real-time motion capture for MMD
- **[Popo](https://popo.love)** — LLM-generated MMD poses
- **[MPL](https://mmd-mpl.vercel.app)** — Motion programming language for MMD
- **[Mixamo-MMD](https://mixamo-mmd.vercel.app)** — Retarget Mixamo FBX to VMD

## Tutorial

[How to Render an Anime Character with WebGPU](https://reze.one/tutorial)
