# Reze Engine

A minimal-dependency WebGPU engine for real-time MMD/PMX rendering. Only external dependency is Ammo.js for physics.

![screenshot](./screenshot.png)

## Install

```bash
npm install reze-engine
```

## Features

- **Anime/MMD-style hybrid renderer** — toon-ramp NPR diffuse mixed with PBR GGX specular (multi-scatter + LTC energy compensation)
- **Per-material presets** — `face` / `hair` / `body` / `eye` / `stockings` / `metal` / `cloth_smooth` / `cloth_rough` / `default`, assigned by material name
- **HDR pipeline** with bloom mip pyramid, Filmic tone mapping, 4× MSAA, tile-memory-friendly on Apple Silicon
- **Alpha-hashed transparency** (Wyman & McGuire 2017) for self-overlapping transparent meshes like stockings
- **Screen-space outlines** on opaque + transparent materials
- **See-through hair over eyes** — stencil-gated MMD post-alpha-eye so eyes read at 50% through hair silhouettes
- **VMD animation** with IK solver and Bullet physics
- **Orbit camera** with bone-follow mode
- **GPU picking** (double-click/tap)
- **Ground plane** with PCF shadow mapping
- **Multi-model support**

## Usage

```javascript
import { Engine, Vec3 } from "reze-engine";

const engine = new Engine(canvas, {
  world: { color: new Vec3(0.4, 0.49, 0.65), strength: 1.0 },
  sun: {
    color: new Vec3(1, 1, 1),
    strength: 2.0,
    direction: new Vec3(0, -0.5, 1),
  },
  bloom: {
    color: new Vec3(0.9, 0.1, 0.8),
    intensity: 0.05,
    threshold: 0.5,
  }
  camera: { distance: 31.5, target: new Vec3(0, 11.5, 0) }, // MMD units (1 unit = 8 cm)
});
await engine.init();

const model = await engine.loadModel("hero", "/models/hero/hero.pmx");

// Map PMX material names to NPR presets (unlisted names fall back to `default`).
engine.setMaterialPresets("hero", {
  face: ["face01"],
  body: ["skin"],
  hair: ["hair_f"],
  eye: ["eye"],
  cloth_smooth: ["shirt", "shorts", "dress", "shoes"],
  cloth_rough: ["jacket", "pants"],
  stockings: ["stockings"],
  metal: ["metal01", "earring"],
});

await model.loadVmd("idle", "/animations/idle.vmd");
model.show("idle");
model.play();

engine.setCameraFollow(model, "センター", new Vec3(0, 3.5, 0));
engine.addGround({ width: 160, height: 160 });
engine.runRenderLoop();
```

## API

One WebGPU **Engine** per page (singleton after `init()`). Load models via URL **or** from a user-selected folder (see [Local folder uploads](#local-folder-uploads-browser)).

### Engine

```javascript
engine.init()
engine.loadModel(name, path)
engine.loadModel(name, { files, pmxFile? })  // folder upload — see below
engine.getModel(name)
engine.getModelNames()
engine.removeModel(name)

engine.setMaterialPresets(name, presetMap)   // assign NPR presets by material name
engine.setMaterialVisible(name, material, visible)
engine.toggleMaterialVisible(name, material)
engine.isMaterialVisible(name, material)

engine.setIKEnabled(enabled)
engine.setPhysicsEnabled(enabled)

engine.setCameraFollow(model, bone?, offset?)
engine.setCameraFollow(null)
engine.setCameraTarget(vec3)
engine.setCameraDistance(d)
engine.setCameraAlpha(a)
engine.setCameraBeta(b)

engine.addGround(options?)
engine.runRenderLoop(callback?)
engine.stopRenderLoop()
engine.getStats()
engine.dispose()
```

### Local folder uploads (browser)

Use a hidden `<input type="file" webkitdirectory multiple>` (or drag/drop) and pass the resulting `FileList` or `File[]` into the engine. Textures resolve relative to the chosen PMX file inside that tree.

**Important:** read `input.files` into a normal array **before** setting `input.value = ""`. The browser’s `FileList` is _live_ — clearing the input empties it.

1. **`parsePmxFolderInput(fileList)`** — returns a tagged result (`empty` | `not_directory` | `no_pmx` | `single` | `multiple`). For `single`, you already have `files` and `pmxFile`. For `multiple`, show a picker (dropdown) of `pmxRelativePaths`, then resolve with **`pmxFileAtRelativePath(files, path)`**.
2. **`engine.loadModel(name, { files, pmxFile })`** — `pmxFile` selects which `.pmx` when the folder contains several.

```javascript
import {
  Engine,
  parsePmxFolderInput,
  pmxFileAtRelativePath,
} from "reze-engine";

// In <input onChange>:
const picked = parsePmxFolderInput(e.target.files);
e.target.value = "";

if (picked.status === "single") {
  const model = await engine.loadModel("myModel", {
    files: picked.files,
    pmxFile: picked.pmxFile,
  });
}

if (picked.status === "multiple") {
  // Let the user choose `chosenPath` from picked.pmxRelativePaths, then:
  const pmxFile = pmxFileAtRelativePath(picked.files, chosenPath);
  const model = await engine.loadModel("myModel", {
    files: picked.files,
    pmxFile,
  });
}
```

VMD and other assets still load by URL when the path starts with `/` or `http(s):`; relative paths are resolved against the PMX directory inside the upload.

### Model

```javascript
await model.loadVmd(name, url)
model.loadClip(name, clip)
model.show(name)
model.play(name)
model.play(name, { priority: 8 }) // higher number = higher priority (0 default/lowest)
model.play(name, { loop: true }) // repeat until stop/pause or another play
model.pause()
model.stop()
model.seek(time)
model.getAnimationProgress()
model.getClip(name)
model.exportVmd(name)              // returns ArrayBuffer

model.rotateBones({ 首: quat, 頭: quat }, ms?)
model.moveBones({ センター: vec3 }, ms?)
model.setMorphWeight(name, weight, ms?)
model.resetAllBones()
model.resetAllMorphs()
model.getBoneWorldPosition(name)
```

#### Animation data

`AnimationClip` holds keyframes only: bone/morph tracks keyed by `frame`, and `frameCount` (last keyframe index). Time advances at fixed `FPS` (see package export `FPS`, default 30).

#### VMD Export

`model.exportVmd(name)` serialises a loaded clip back to the VMD binary format and returns an `ArrayBuffer`. Bone and morph names are Shift-JIS encoded for compatibility with standard MMD tools.

```javascript
const buffer = model.exportVmd("idle");
const blob = new Blob([buffer], { type: "application/octet-stream" });
const link = document.createElement("a");
link.href = URL.createObjectURL(blob);
link.download = "idle.vmd";
link.click();
```

#### Playback

Call `model.play(name, options?)` to start or switch motion. `loop: true` makes the playhead wrap at the end of the clip until you stop, pause, or call `play` with something else. `priority` chooses which request wins when several clips compete.

#### Progress

`getAnimationProgress()` reports `current` and `duration` in seconds, plus `playing`, `paused`, `looping`, and related fields.

### Engine Options

Blender-style scene config — `world` = environment lighting, `sun` = the directional lamp, `camera` = view framing.

```javascript
{
  world: {
    color: Vec3,       // World > Surface > Color (linear scene-referred)
    strength: number,  // World > Surface > Strength
  },
  sun: {
    color: Vec3,       // Light > Color
    strength: number,  // Light > Strength (Blender units)
    direction: Vec3,   // direction light travels (points from sun into the scene)
  },
  camera: {
    distance: number,
    target: Vec3,
    fov: number,       // radians
  },
  onRaycast: (modelName, material, screenX, screenY) => void,
  physicsOptions: {
    constraintSolverKeywords: string[],
  },
}
```

The shadow map is cast from `sun.direction` — same vector the shader lights with — so visible shading and cast shadows stay coupled.

`engine.setWorld({ color?, strength? })` and `engine.setSun({ color?, strength?, direction? })` update lighting at runtime; changing `sun.direction` refreshes the shadow VP on the next frame.

`constraintSolverKeywords` — joints whose name contains any keyword use the Bullet 2.75 constraint solver; all others keep the stable Ammo 2.82+ default. See [babylon-mmd: Fix Constraint Behavior](https://noname0310.github.io/babylon-mmd/docs/reference/runtime/apply-physics-to-mmd-models/#fix-constraint-behavior) for details.

## Rendering

Each surface combines an NPR stack with a Principled-style BSDF, mixed per material — so anime characters keep their flat illustrated look while highlights and reflections stay grounded. Every per-material shader is ~40–120 lines of distinctive code standing on a small set of shared WGSL primitives (`engine/src/shaders/materials/`).

### Anatomy of a material shader

Every material's fragment shader is the same 7-stage pipeline. The order is fixed; the content is per-material:

```
(A) Fragment setup      → n, v, l, sun, amb, shadow    ← shared
(B) Texture + alpha     → tex_rgb, discard             ← shared shape
(C) NPR stack           → toon + rim + warm + …        ← UNIQUE per material
(D) Optional bump       → noise → bump_lh              ← 3 presets
(E) Principled BSDF     → eval_principled(...)         ← shared helper
(F) NPR ↔ PBR mix       → mix(npr, principled, fac)    ← per-material fac
(G) FSOut               → color + bloom mask           ← shared
```

The simplest material (`default`) uses only A/B/E/G — no NPR stack at all:

```wgsl
let color = eval_principled(
  PrincipledIn(albedo, 0.0, 0.5, 0.5, 1e30, 0.0, 0.0), // metallic, spec, rough, clamp, sheen, sheen_tint
  n, l, v, sun, amb, shadow
);
```

NPR presets add stage C (and sometimes D) on top, and stage F chooses how NPR-leaning the surface is.

### Shared WGSL foundations

- **`nodes.ts`** — WGSL mirrors of the Blender shader nodes the presets use: `hue_sat`, `bright_contrast`, `ramp_constant/linear/cardinal`, `mix_overlay/lighten/linear_light`, `fresnel`, `layer_weight_fresnel/facing`, `tex_noise`, `tex_voronoi`, `mapping_point`, `bump_lh`, `normal_map`. Plus a combined DFG + LTC LUT, `eval_principled(PrincipledIn, N, L, V, sun, amb, shadow)`, and `principled_sheen`.
- **`common.ts`** — Uniform structs, bind-group layout (same for every material pipeline), PCF shadow sampler, skinning vertex shader, shared `FSOut`.
- **Per-material files** — constants + NPR stack + optional bump + `eval_principled` call + final mix.

### PBR specular core

Inside `eval_principled`:

- GGX microfacet specular with Schlick Fresnel and Walter–Smith G1
- **Multi-scatter compensation** (Fdez-Agüera 2019) — restores energy at high roughness so metals don't darken
- **Split-sum DFG LUT** (Karis 2013) — drives indirect specular
- **LTC direct-spec scale** (Heitz 2016) — keeps analytic-light specular in the same energy budget as image-based lighting
- **Sheen coarse curve** gated by the `sheen` field on `PrincipledIn`

### NPR toolbox

Every preset's stage C is built from these primitives:

- **Toon ramps** — quantised NdotL through constant or `ramp_constant_edge_aa` (fwidth-based step anti-alias) for cel-shaded shadow terminators
- **HSV remaps** — separate hue/sat/value tints for shadow vs lit zones, layered with mix-overlay against the lit texture for warm-shadow / cool-light shifts
- **Fresnel rim & layer-weight wrap** — `fresnel × layer_weight_facing` (or two stacked fresnels) feeds a MixShader against an emissive backdrop for anime back-light
- **Procedural micro-detail** — 3-octave value noise (PCG hash, fully unrolled) drives bump-from-height for skin and fabric; 3D Voronoi in reflection-coord space drives metallic sparkle
- **Selective emission** — BT.601-luminance-gated boosts (eye iris, face highlights, stockings pattern) that survive into bloom

### Per-material NPR stacks

Each PMX material is assigned to one of these shaders. The NPR stack column is what's actually in stage C of that file; the Principled column is what gets passed to `eval_principled`.

| Preset         | NPR stack (stage C)                                         | Principled (stage E)                                          |
| -------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| `default`      | —                                                           | metallic=0, spec=0.5, rough=0.5                               |
| `eye`          | — (emission = albedo × 1.5 added post-eval)                 | same as default                                               |
| `face`         | toon + warm rim + dual-fresnel rim + BT.601 bright-tex gate | spec=0.5, rough=0.3, noise bump, spec clamp=10                |
| `body`         | toon + warm rim + fresnel rim + facing rim                  | spec=0.5, rough=0.3, noise bump, spec clamp=10                |
| `hair`         | toon + fresnel rim + bevel (n.y) + bright-tex gate          | spec=1.0, rough=0.3, mixed at 20% PBR                         |
| `cloth_smooth` | toon + bevel + mix-overlay emission (×18)                   | spec=0.8, rough=0.5                                           |
| `cloth_rough`  | same NPR as `cloth_smooth`                                  | spec=0.8, rough=0.82, live noise bump, spec clamp=10          |
| `metal`        | toon + mix-overlay emission (×8)                            | metallic=1, voronoi-driven base (reflection-coord), rough=0.3 |
| `stockings`    | gradient × facing mask + HSV-boosted emission (×5)          | metallic=0.1, spec=1, rough=0.5, **sheen=0.7**, hashed alpha  |

Assign presets per-model with `engine.setMaterialPresets(name, map)` (see the [Usage](#usage) example). Material names not listed fall through to `default`.

### Shadows, post, output

- Directional shadow map (2048², depth32float, PCF, normal + depth bias)
- HDR main pass with 4× MSAA. Color is `rg11b10ufloat` paired with an `rg8unorm` aux MRT carrying bloom mask (`.r`) and accumulated alpha (`.g`). The combined footprint fits Apple Silicon TBDR tile memory, so the 4× MSAA buffer resolves in-tile rather than spilling to system memory every frame. Falls back to `rgba16float` when the device does not expose `rg11b10ufloat-renderable`.
- Bloom via threshold + downsample/upsample mip pyramid, gated by the aux bloom-mask channel
- Filmic tone mapping (LUT extracted from Blender 3.6 OCIO "Filmic / Medium High Contrast")
- Screen-space outline pass (inverted-hull) on opaque and transparent materials

### Alpha-hashed transparency

`stockings` uses the Wyman & McGuire 2017 derivative-aware stochastic discard so self-overlapping transparent meshes (e.g. the front and back of a stocking wrapped around a leg) resolve cleanly under MSAA with opaque-style depth writes. The hash is derived from world-space position, so the dither pattern does not swim when the camera moves.

### See-through hair over eyes (MMD post-alpha-eye)

The classic MMD effect where hair strands covering the eye are rendered at 50% so the iris stays readable — implemented as a single extra pass driven by the stencil buffer, not a two-texture composite.

- **Eye pipeline** stamps `stencil = EYE_VALUE` on every fragment it writes, with `cullMode: "front"` and a small negative `depthBias` so only the back half of the eye mesh renders (the MMD trick that keeps eyes from leaking through the back of the head).
- **Main hair pipeline** stencil-tests `not-equal EYE_VALUE` and skips those fragments.
- **Hair-over-eyes pipeline** re-issues the hair draws with `IS_OVER_EYES = true`, stencil-tests `equal EYE_VALUE`, disables depth writes, and alpha blends at 50% — eye-stamped pixels end up `0.5·hair + 0.5·eye` in linear HDR before tonemap.
- **Outline pipeline** stencil-tests `not-equal EYE_VALUE` so edge color does not overwrite the see-through region.

Draw order within a model: non-eye/non-hair opaque → eye (stamp) → hair (skip stamp) → outlines (skip stamp) → hair-over-eyes (match stamp).

## Projects Using This Engine

- **[Reze Studio](https://reze.studio)** - Web-native MMD animation editor
- **[MiKaPo](https://mikapo.vercel.app)** — Real-time motion capture for MMD
- **[Popo](https://popo.love)** — LLM-generated MMD poses
- **[MPL](https://mmd-mpl.vercel.app)** — Motion programming language for MMD
- **[Mixamo-MMD](https://mixamo-mmd.vercel.app)** — Retarget Mixamo FBX to VMD

## Tutorial

[How to Render an Anime Character with WebGPU](https://reze.one/tutorial)
