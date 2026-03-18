# Reze Engine

A lightweight engine built with WebGPU and TypeScript for real-time 3D anime character MMD model rendering.

## Features

- Blinn-Phong lighting, alpha blending, rim lighting, outlines, MSAA 4x
- Post alpha eye rendering (see-through eyes)
- Bone and morph API, VMD animation (multiple named, non-interruptible), IK solver, Ammo/Bullet physics
- Multi-model (per-model materials, IK, physics)

## Usage

```javascript
import { Engine, Model } from "reze-engine"

const engine = new Engine(canvas, {})
await engine.init()
const model = await engine.loadModel("/models/reze/reze.pmx")
await model.loadAnimation("default", "/animations/dance.vmd")
model.show("default")
model.play()
engine.runRenderLoop(() => {})
```

## API (summary)

- **Multi-model:** `engine.loadModel(path)` / `engine.loadModel(name, path)`, `engine.addModel(model, pmxPath, name?)`, `getModel(name)`, `getModelNames()`, `removeModel(name)`, `setMaterialVisible(modelName, materialName, visible)`, `setIKEnabled(enabled)`, `setPhysicsEnabled(enabled)`, `getIKEnabled()`, `getPhysicsEnabled()`, `resetPhysics()`, `markVertexBufferDirty(modelName?)`
- **Animation:** `model.loadAnimation(name, vmdUrl)`; `model.show(name)`; `model.play()` / `model.play(name)`; `model.pause()`; `model.stop()`; `model.seek(t)`; `model.getAnimationProgress()`. Animations are non-interruptible (next is queued).
- **Bones / morphs:** `model.rotateBones()`, `model.moveBones()`, `model.setMorphWeight()`, `model.resetAllBones()`, `model.resetAllMorphs()`
- **Engine:** `runRenderLoop()`, `addGround({ mode: "reflection" | "shadow", ... })`, `onRaycast: (modelName, material, screenX, screenY) => {}`

## Projects Using This Engine

- **[MiKaPo](https://mikapo.vercel.app)** - Online real-time motion capture for MMD using webcam and MediaPipe
- **[Popo](https://popo.love)** - Fine-tuned LLM that generates MMD poses from natural language descriptions
- **[MPL](https://mmd-mpl.vercel.app)** - Semantic motion programming language for scripting MMD animations with intuitive syntax
- **[Mixamo-MMD](https://mixamo-mmd.vercel.app)** - Retarget Mixamo FBX animation to VMD in one click

## Tutorial

Learn WebGPU from scratch by building an anime character renderer in incremental steps. The tutorial covers the complete rendering pipeline from a simple triangle to fully textured, skeletal-animated characters.

[How to Render an Anime Character with WebGPU](https://reze.one/tutorial)
