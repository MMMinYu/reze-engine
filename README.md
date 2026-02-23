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
export default function Scene() {
  const canvasRef = useRef < HTMLCanvasElement > null
  const engineRef = useRef < Engine > null

  const initEngine = useCallback(async () => {
    if (canvasRef.current) {
      try {
        const engine = new Engine(canvasRef.current, {})
        engineRef.current = engine
        await engine.init()
        await engine.loadModel("/models/reze/reze.pmx")

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

### Animation Playback

Load and play VMD animation files.

```javascript
await engine.loadAnimation("/animations/dance.vmd")
engine.playAnimation()
engine.pauseAnimation()
engine.stopAnimation()
engine.seekAnimation(2.5) // seek to 2.5 seconds

const { current, duration, percentage } = engine.getAnimationProgress()
```

### Bone and Morph Tweening

Rotate and move bones with optional tween duration. Translations are VMD-style (relative to bind pose world position).

```javascript
engine.rotateBones({ "首": neckQuat, "頭": headQuat }, 300)
engine.moveBones({ "センター": centerVec }, 300)
engine.setMorphWeight("まばたき", 1.0, 300)

engine.resetAllBones()
engine.resetAllMorphs()
```

### Atomic Pose Setting

Set rotations, translations, and morphs in a single atomic pass — for animation editors, motion capture, or any use case that needs precise, immediate pose updates matching the quality of internal VMD playback.

```javascript
engine.setPose(
  { "首": neckQuat, "頭": headQuat, "左腕": leftArmQuat },
  { "センター": centerVec },
  { "まばたき": 0.5, "あ": 0.3 }
)
```

All three parameters are optional. Pass only what you need:

```javascript
engine.setPose(rotations)                      // rotations only
engine.setPose(undefined, translations)        // translations only
engine.setPose(undefined, undefined, morphs)   // morphs only
```

## Projects Using This Engine

- **[MiKaPo](https://mikapo.vercel.app)** - Online real-time motion capture for MMD using webcam and MediaPipe
- **[Popo](https://popo.love)** - Fine-tuned LLM that generates MMD poses from natural language descriptions
- **[MPL](https://mmd-mpl.vercel.app)** - Semantic motion programming language for scripting MMD animations with intuitive syntax
- **[Mixamo-MMD](https://mixamo-mmd.vercel.app)** - Retarget Mixamo FBX animation to VMD in one click

## Tutorial

Learn WebGPU from scratch by building an anime character renderer in incremental steps. The tutorial covers the complete rendering pipeline from a simple triangle to fully textured, skeletal-animated characters.

[How to Render an Anime Character with WebGPU](https://reze.one/tutorial)
