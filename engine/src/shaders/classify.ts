// Material preset types for NPR pipeline dispatch.
// Mapping is explicit — the consumer provides a MaterialPresetMap that assigns
// material names to presets. Unmapped materials fall back to "default" (Principled BSDF).

export type MaterialPreset =
  | "default"
  | "face"
  | "hair"
  | "body"
  | "stockings"
  | "metal"
  | "cloth_smooth"
  | "cloth_rough"

// Keys = preset name, values = array of material names that should use that preset.
export type MaterialPresetMap = Partial<Record<MaterialPreset, string[]>>

export function resolvePreset(materialName: string, map: MaterialPresetMap | undefined): MaterialPreset {
  if (!map) return "default"
  for (const [preset, names] of Object.entries(map)) {
    if (names && names.includes(materialName)) return preset as MaterialPreset
  }
  return "default"
}
