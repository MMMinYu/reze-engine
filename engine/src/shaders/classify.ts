// Auto-classify PMX materials into NPR preset categories by name heuristic.
// Covers Japanese (JP), Chinese (CN), and English naming conventions common in MMD models.
// Returns a best-guess — the studio UI provides a dropdown override.

export type MaterialPreset =
  | "face"
  | "hair"
  | "body"
  | "stockings"
  | "metal"
  | "smooth_cloth"
  | "rough_cloth"

type Rule = { preset: MaterialPreset; patterns: RegExp }

const RULES: Rule[] = [
  // Face/eyes/mouth region — match before body (肌 overlaps)
  {
    preset: "face",
    patterns:
      /顔|顏|脸|臉|フェイス|face|頬|ほほ|まつ[毛げ]|睫|眉|瞳|虹彩|iris|白目|目[^の]|eye|瞼|まぶた|歯|teeth|舌|tongue|口[内紅]|唇|lip|鼻|nose/i,
  },
  // Hair
  {
    preset: "hair",
    patterns:
      /髪|发|髮|ヘア|hair|前髪|後[ろ]?髪|横髪|もみあげ|ツインテ|ポニーテ|三つ編|ahoge|アホ毛/i,
  },
  // Stockings / tights — match before cloth
  {
    preset: "stockings",
    patterns:
      /ストッキング|タイツ|tights|stocking|ニーソ|靴下|ソックス|sock|丝袜|絲襪|袜|襪/i,
  },
  // Metal / accessories
  {
    preset: "metal",
    patterns:
      /金属|メタル|metal|アクセ|acces|バックル|buckle|ベルト|belt|ボタン|button|指輪|ring|鎖|chain|剣|sword|刀|blade|鉄|銀|ジッパー|zipper|钮|扣|饰|飾|甲冑|armor/i,
  },
  // Body / skin — broad match after face is excluded
  {
    preset: "body",
    patterns:
      /肌|skin|体|身体|ボディ|body|腕|arm|手[^袋]|hand|足[^首]|脚|leg|指|finger|首|neck|太もも|thigh|胸|chest|肩|shoulder|背中|back|皮[肤膚]/i,
  },
  // Rough cloth keywords (denim, wool, knit, leather)
  {
    preset: "rough_cloth",
    patterns:
      /デニム|denim|ウール|wool|ニット|knit|レザー|leather|革|麻|canvas|burlap|粗/i,
  },
]

export function classifyMaterial(name: string): MaterialPreset {
  const n = name.trim()
  for (const rule of RULES) {
    if (rule.patterns.test(n)) return rule.preset
  }
  // Default: anything unmatched is treated as smooth cloth (most common in MMD)
  return "smooth_cloth"
}
