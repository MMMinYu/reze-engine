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

## Projects Using This Engine

- **[MiKaPo](https://mikapo.vercel.app)** - Online real-time motion capture for MMD using webcam and MediaPipe
- **[Popo](https://popo.love)** - Fine-tuned LLM that generates MMD poses from natural language descriptions
- **[MPL](https://mmd-mpl.vercel.app)** - Semantic motion programming language for scripting MMD animations with intuitive syntax

## Tutorial

Learn WebGPU from scratch by building an anime character renderer in incremental steps. The tutorial covers the complete rendering pipeline from a simple triangle to fully textured, skeletal-animated characters.

[How to Render an Anime Character with WebGPU](https://reze.one/tutorial)
