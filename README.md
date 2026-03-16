# Reze Engine

A lightweight engine built with WebGPU and TypeScript for real-time 3D anime character MMD model rendering.

![screenshot](./screenshot.png)

## Features

- Blinn-Phong lighting
- Alpha blending
- Post alpha eye rendering (the see-through eyes)
- Rim lighting
- Outlines
- MSAA 4x anti-aliasing
- Bone and morph API
- VMD animation (multiple named animations, non-interruptible playback)
- IK solver
- Ammo/Bullet physics
- Multi-model support (per-model materials, IK, physics)

## Usage

```javascript
import { Engine, Model } from "reze-engine"

export default function Scene() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine>(null)

  const initEngine = useCallback(async () => {
    if (canvasRef.current) {
      try {
        const engine = new Engine(canvasRef.current, {})
        engineRef.current = engine
        await engine.init()
        // Loads PMX and registers with the engine (returns model; engine assigns a name)
        const model = await Model.loadPmx("/models/reze/reze.pmx")
        await model.loadVmd("/animations/dance.vmd")  // loads "default", does not auto-play
        model.play()  // start when ready

        engine.runRenderLoop(() => {})
      } catch (error) {
        console.error(error)
      }
    }
  }, [])

  useEffect(() => {
    void initEngine()
    return () => engineRef.current?.dispose()
  }, [initEngine])

  return <canvas ref={canvasRef} className="w-full h-full" />
}
```

### Engine options

```javascript
{
  ambientColor: new Vec3(0.88, 0.88, 0.88),
  directionalLightIntensity: 0.24,
  minSpecularIntensity: 0.3,
  rimLightIntensity: 0.4,
  cameraDistance: 26.6,
  cameraTarget: new Vec3(0, 12.5, 0),
  cameraFov: Math.PI / 4,
  onRaycast: (modelName, material, screenX, screenY) => { /* tap/click on model */ },
  multisampleCount: 4,  // 1 | 4
}
```

## API

One WebGPU **Engine** per page (singleton after `init()`). Load PMX with **`Model.loadPmx(path, name?)`**; the model is registered on the engine. Use **`engine.addModel(model, pmxPath, name?)`** for additional models (returns the instance name used).

### Multi-model

```javascript
const name = await engine.addModel(model, "/path/to/model.pmx", "hero")
engine.getModelNames()        // ["model_0", "hero", ...]
engine.getModel("hero")       // Model | null
engine.removeModel("hero")

engine.setMaterialVisible("hero", "材質1", false)
engine.setModelIKEnabled("hero", true)
engine.setModelPhysicsEnabled("hero", true)
engine.resetPhysics()         // resets physics for all instances
engine.markVertexBufferDirty("hero")  // or pass Model
```

### Animation

Animations are **non-interruptible**: the next one starts only when the current one finishes (or is queued).

```javascript
const model = engine.getModel("hero")  // or the model from loadPmx

// Single animation (e.g. dance): load, then play when needed
await model.loadVmd("/animations/dance.vmd")   // loads as "default", shows first frame, does not play
model.play()                                    // start playback
const { current, duration, percentage } = model.getAnimationProgress()

// Multiple named animations
await model.loadAnimation("idle", "/animations/idle.vmd")
await model.loadAnimation("walk", "/animations/walk.vmd")
model.show("idle")         // show "idle" at time 0, no playback
model.play("walk")          // play "walk"; if something is playing, "walk" is queued for when it ends
model.play()                 // resume current
model.pause()
model.stop()
model.seek(1.5)
model.getAnimationProgress()  // { current, duration, percentage, animationName }
model.getAnimationState().setOnEnd((name) => model.play("idle"))
```

### Bone and morph tweening

```javascript
model.rotateBones({ 首: neckQuat, 頭: headQuat }, 300)
model.moveBones({ センター: centerVec }, 300)
model.setMorphWeight("まばたき", 1.0, 300)
model.resetAllBones()
model.resetAllMorphs()
```

### Engine (render loop, ground, raycast)

```javascript
engine.runRenderLoop(() => {})

engine.addGround({ width: 160, height: 160, mode: "reflection", ... })  // mirror + reflection
engine.addGround({ width: 160, height: 160, mode: "shadow", ... })      // floor + character shadow

// Raycast: tap/click on model (callback receives model name and material name)
new Engine(canvas, {
  onRaycast: (modelName, material, screenX, screenY) => { ... }
})
```

## Projects Using This Engine

- **[MiKaPo](https://mikapo.vercel.app)** - Online real-time motion capture for MMD using webcam and MediaPipe
- **[Popo](https://popo.love)** - Fine-tuned LLM that generates MMD poses from natural language descriptions
- **[MPL](https://mmd-mpl.vercel.app)** - Semantic motion programming language for scripting MMD animations with intuitive syntax
- **[Mixamo-MMD](https://mixamo-mmd.vercel.app)** - Retarget Mixamo FBX animation to VMD in one click

## Tutorial

Learn WebGPU from scratch by building an anime character renderer in incremental steps. The tutorial covers the complete rendering pipeline from a simple triangle to fully textured, skeletal-animated characters.

[How to Render an Anime Character with WebGPU](https://reze.one/tutorial)
