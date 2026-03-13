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
- VMD animation
- IK solver
- Ammo/Bullet physics

## Usage

```javascript
import { Engine, Model } from "reze-engine"

export default function Scene() {
  const canvasRef = useRef < HTMLCanvasElement > null
  const engineRef = useRef < Engine > null

  const initEngine = useCallback(async () => {
    if (canvasRef.current) {
      try {
        const engine = new Engine(canvasRef.current, {})
        engineRef.current = engine
        await engine.init()
        // Registers with the engine automatically (one scene / one active model)
        const model = await Model.loadPmx("/models/reze/reze.pmx")

        engine.runRenderLoop(() => {})
      } catch (error) {
        console.error(error)
      }
    }
  }, [])

  useEffect(() => {
    void (async () => {
      initEngine()
    })()

    return () => {
      if (engineRef.current) {
        engineRef.current.dispose()
      }
    }
  }, [initEngine])

  return <canvas ref={canvasRef} className="w-full h-full" />
}
```

Engine options

```javascript
const DEFAULT_ENGINE_OPTIONS: RequiredEngineOptions = {
  ambientColor: new Vec3(0.82, 0.82, 0.82),
  directionalLightIntensity: 0.2,
  minSpecularIntensity: 0.3,
  rimLightIntensity: 0.4,
  cameraDistance: 26.6,
  cameraTarget: new Vec3(0, 12.5, 0),
  cameraFov: Math.PI / 4,
  onRaycast: undefined,
}
```

## API

One WebGPU **Engine** per page (set as singleton when `init()` finishes). Load PMX via **`Model.loadPmx(url)`**—that parses the file and registers the model for rendering.

### Animation Playback

On the **model** instance returned from `Model.loadPmx`:

```javascript
const model = await Model.loadPmx("/models/char.pmx")
await model.loadVmd("/animations/dance.vmd")
model.playAnimation()
model.pauseAnimation()
model.stopAnimation()
model.seekAnimation(2.5) // seconds

const { current, duration, percentage } = model.getAnimationProgress()
```

### Bone and Morph Tweening

```javascript
model.rotateBones({ 首: neckQuat, 頭: headQuat }, 300)
model.moveBones({ センター: centerVec }, 300)
model.setMorphWeight("まばたき", 1.0, 300)

model.resetAllBones()
model.resetAllMorphs()
```

### Engine (scene / render loop)

```javascript
engine.runRenderLoop(() => {})
engine.setMaterialVisible("材質1", false)
engine.addGround({ mode: "reflection", ... })  // mirror + reflection pass
engine.addGround({ mode: "shadow", ... })      // floor + character shadow (no mirror)
```

## Projects Using This Engine

- **[MiKaPo](https://mikapo.vercel.app)** - Online real-time motion capture for MMD using webcam and MediaPipe
- **[Popo](https://popo.love)** - Fine-tuned LLM that generates MMD poses from natural language descriptions
- **[MPL](https://mmd-mpl.vercel.app)** - Semantic motion programming language for scripting MMD animations with intuitive syntax
- **[Mixamo-MMD](https://mixamo-mmd.vercel.app)** - Retarget Mixamo FBX animation to VMD in one click

## Tutorial

Learn WebGPU from scratch by building an anime character renderer in incremental steps. The tutorial covers the complete rendering pipeline from a simple triangle to fully textured, skeletal-animated characters.

[How to Render an Anime Character with WebGPU](https://reze.one/tutorial)
