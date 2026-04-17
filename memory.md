---
  Reze Engine — Rendering Rewrite Progress

  Context: Reze engine is a WebGPU-based MMD (PMX/VMD) renderer. Its companion tool
  reze-studio (animation curve editor) went viral on r/MMD (top-of-all-time post, 120+
  upvotes) — market for modern web-based MMD tooling is validated. Rendering is the
  visible weak link. Goal: replace it with a game-like anime aesthetic
  (Honkai/HSR/Genshin style) by porting 7 curated Blender NPR material presets to WGSL.

  Aesthetic spec: 7 Blender preset JSONs at repo root: M_Face, M_Body, M_Hair, M_Metal,
  M_Smooth_Cloth, M_Rough_Cloth, M_Stockings_Textured. Each is a hybrid Principled-BSDF +
  stacked-EMISSION NPR graph. When a preset is applied, PMX native toon/sphere textures
  are ignored — presets own the look.

  Scope (v0, opinionated, resist expansion):
  - Single model, one sun + ambient, 7 hand-ported presets
  - 3 global knobs: sun dir, sun intensity, ambient color
  - Auto-categorize PMX materials by name heuristic; studio dropdown override
  - PMX + VMD only (MMD-authentic, no glTF)

  Non-goals for v0: post-processing, node editor, per-preset sliders, multi-model, MME
  extensions, Blender add-on, runtime transpilation.

  ── CURRENT STATE (blender branch) ──────────────────────────────────

  Baseline Blender 3.6 matching is LIVE. Default Principled-BSDF + Filmic output
  visually matches Blender's Eevee "Medium High Contrast" on stock PMX models — colors
  preserved, blacks stay black, highlights don't wash to white.

  Lighting (Blender-style nested config, runtime-mutable via setWorld / setSun):
    world:  { color, strength }               → ambient = color × strength
                                                (no /π — hemisphere E=π·L cancels with
                                                 Lambertian albedo/π)
    sun:    { color, strength, direction }    → shadow VP reads the same direction
    camera: { distance, target, fov }

  Tone mapping: Blender Filmic Medium High Contrast, exposure -0.3. 14-entry LUT
  extracted from the live Blender OCIO pipeline via scripts/extract_filmic_lut.py
  (renders a known-linear probe image through scene color-management, reads back).
  Ambient math verified via scripts/extract_ambient.py.

  Shader organisation (engine/src/shaders/):
    default.ts  — Principled BSDF. GGX specular + Lambertian diffuse + 3×3 PCF shadow
                  + per-channel Filmic tonemap. This is the baseline/fallback.
    face.ts     — M_Face NPR graph, fully hand-ported: toon shadow, hue/sat tinting,
                  brightness/contrast, fresnel rim layers, AO-gated warm emission,
                  principled+noise-bump, 50/50 final mix. Reference implementation
                  for the remaining preset ports.
    nodes.ts    — Shared Blender node primitives (fresnel, layer_weight, hue_sat,
                  mix_blend, ramp_constant, ramp_linear, math_power, ao_fake, etc.).
                  Every preset shader imports this.
    classify.ts — Name-based PMX material → preset heuristic (JP/CN/EN regex).
                  Presets: face | body | hair | metal | smooth_cloth | rough_cloth |
                  stockings.

  MaterialUniforms is unified across ALL preset shaders:
    struct MaterialUniforms { diffuseColor: vec3f, alpha: f32 }   // 16 bytes
  One material bind-group layout serves every preset → pipeline swap is just
  setPipeline(); no bind-group juggling.

  Outline: screen-space NDC extrusion. Thickness is pixel-stable under depth /
  zoom / aspect changes. PMX edgeFlag (0x10) / edgeSize / edgeColor fully respected.
  Global tuning knob = edgeScale (currently 0.006 NDC-y per PMX unit ≈ 3.2 px at
  1080p for edgeSize=1).

  Render loop (engine.ts):
    render() → shadow pass → main pass → pick pass (on demand)
    renderOneModel(inst)
      → drawMaterials(inst, "opaque")         binds per-frame + per-inst once
      → drawOutlines (inst, "opaque-outline") binds outline layout once
      → drawMaterials(inst, "transparent")    rebinds per-frame + per-inst
      → drawOutlines (inst, "transparent-outline")

    pipelineForPreset(preset) is the SINGLE dispatch hook for per-preset shaders.
    Currently returns modelPipeline unconditionally (baseline-matching mode); flip
    here to wire up face / hair / body / etc.

  ── INFRASTRUCTURE PROGRESS ─────────────────────────────────────────

  [done] 1. WGSL shader module composition          → shaders/*.ts per-preset
  [done] 2. Pipeline-per-preset registry scaffolded → pipelineForPreset(preset)
                                                      facePipeline built + ready
  [done] 3. Shared material bind-group layout       → one layout, any preset
  [todo] 4. Tangent attribute via MikkTSpace        → needed before metal/hair
  [done] 5. Per-preset material uniform layout      → unified (diffuseColor, alpha)
                                                      expand only if a preset demands
  [done] 6. Scene config ingestion                  → Blender-style world/sun/camera
  [todo] 7. AO texture loader path                  → needed before body (skin SSS)

  ── NEXT: PER-PRESET DISPATCH ───────────────────────────────────────

  We are READY to implement per-material preset shaders. Plan:

    1. Flip dispatch for face first (smallest risk, already ported):
         pipelineForPreset(preset) { if (preset === "face") return facePipeline; ... }
       Verify face materials auto-classify correctly for current test model.

    2. Port remaining presets using face.ts as the structural reference.
       Order matches infra dependencies:
         hair         (needs nothing extra)
         body / skin  (after AO loader)
         cloth_smooth (needs nothing extra)
         cloth_rough  (needs nothing extra)
         stockings    (after AO loader; uses texture bump)
         metal        (after MikkTSpace tangents)

    3. Land MikkTSpace tangent generation in pmx-loader before metal.
    4. Land AO texture loader path before body/stockings.

  Studio integration (~3 days):
    Ship behind "Classic" vs "Game" toggle. Promote "Game" to default after feedback.
    Minimal UI: sun controls + per-material preset dropdown (override classifier).

  Accepted tradeoffs: AO baked not raycast; BEVEL faked; SHADERTORGB via BSDF→RGB
  restructure; shadow map only; hard shadows only.
