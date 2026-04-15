 ---                               
  Reze Engine — Rendering Rewrite Prompt                                                 
                                                                                       
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
                                                                                         
  Lighting (linear, Y-up via (x_b, z_b, -y_b)):                                          
  ambient = (0.120, 0.148, 0.194)   // world (0.401,0.494,0.647) × 0.3
  sun.direction = (-0.087, -0.384, -0.919)                                               
  sun.color     = (1, 1, 1)                                                              
  sun.intensity = 2.0      
  sun.angle     ≈ 1° (hard shadow)                                                       
  Swap chain *-srgb; shader linear.                                                      
  
  Infrastructure (~1 week, before any preset work):                                      
  1. WGSL shader module composition (0.5d)                  
  2. Pipeline-per-preset registry (1d)                                                   
  3. Bind group expansion + dummy-texture fallback (1d)     
  4. Tangent attribute via MikkTSpace at PMX load (1–2d)                                 
  5. Per-preset material uniform layouts (1d)                                            
  6. Scene config ingestion, remove old light options (0.5d)
  7. AO texture loader path (0.5d)                                                       
                                                            
  Preset ports (~1.5 weeks):                                                             
  nodes.wgsl primitives → hair → face → skin → cloth_smooth → cloth_rough → stockings →
  metal                                                                                  
                                                            
  Studio integration (~3 days):                                                          
  Ship new renderer behind "Classic" vs "Game" toggle. Promote "Game" to default after
  feedback. Minimal UI: sun controls + per-material preset dropdown only.                
                                                            
  Accepted tradeoffs: AO baked not raycast; BEVEL faked; SHADERTORGB via BSDF→RGB        
  restructure; shadow map only; hard shadows only.          
                                                                                         
  Timeline total: ~2.5 weeks.                    