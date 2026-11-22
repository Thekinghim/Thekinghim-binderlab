/**
 * Packbilder (V2): titel → bild i public/packs/. Port av prototypens BL.pkKey
 * (docs/design/v2/prototyp.html). Ingen träff = en neutral platta med initialer i samma
 * format (PackImage), så att rutnäten inte hoppar; titeln står alltid bredvid.
 *
 * Bilderna är 240 px höga: 2× största visade storlek (xl, 120 px), alltså skarpa på 2×-skärm.
 */

/** Nycklarna som har en bild i public/packs/<nyckel>.webp, med bildens mått (px). */
export const PACK_IMAGES = {
  "151c-surprise-cn": [128, 240],
  "30th-celebration": [131, 240],
  "ascended-heroes": [131, 240],
  "black-bolt": [131, 240],
  "delta-reign": [132, 240],
  "destined-rivals": [131, 240],
  "fusion-strike": [131, 240],
  "journey-together": [132, 240],
  "mega-dream-ex-jp": [130, 240],
  "mega-evolution": [131, 240],
  "mega-inferno-jp": [119, 240],
  "mega-storm-emeralda-jp": [119, 240],
  "mystery-pack-premium": [129, 240],
  "mystery-pack": [129, 240],
  "obsidian-flames": [131, 240],
  "op13-en": [145, 240],
  "op13-jp": [119, 240],
  "paldea-evolved": [131, 240],
  "paradox-rift": [136, 240],
  "perfect-order": [132, 240],
  "phantasmal-flames": [132, 240],
  "prismatic-evolutions": [131, 240],
  "scarlet-violet-151": [177, 240],
  "surging-sparks": [131, 240],
  "temporal-forces": [133, 240],
  "white-flare": [131, 240],
} as const satisfies Record<string, readonly [number, number]>;

export type PackKey = keyof typeof PACK_IMAGES;

/** Ordningen spelar roll: första träffen vinner (som i prototypen). */
const RULES: ReadonlyArray<readonly [string, PackKey]> = [
  ["prismatic", "prismatic-evolutions"],
  ["black bolt", "black-bolt"],
  ["30th", "30th-celebration"],
  ["ascended", "ascended-heroes"],
  // "Destin Rivals" och andra stavningar i Awish.
  ["destin", "destined-rivals"],
  ["phantasmal", "phantasmal-flames"],
  ["surging", "surging-sparks"],
  ["mega dream", "mega-dream-ex-jp"],
  ["emeralda", "mega-storm-emeralda-jp"],
  ["inferno", "mega-inferno-jp"],
  ["fusion", "fusion-strike"],
  // "White Flair" (stavning i Awish).
  ["white fla", "white-flare"],
  ["delta", "delta-reign"],
  ["perfect order", "perfect-order"],
  ["mega evolution", "mega-evolution"],
  ["journey together", "journey-together"],
  ["obsidian", "obsidian-flames"],
  ["paldea evolved", "paldea-evolved"],
  ["paradox", "paradox-rift"],
  ["temporal", "temporal-forces"],
];

/** Titelns bildnyckel, eller null när det inte finns någon bild. */
export function packKey(title: string | null | undefined): PackKey | null {
  const t = (title ?? "").toLowerCase();
  if (!t.trim()) return null;
  const jp = /jap|jp\b/.test(t);
  if (/mystery/.test(t)) return /premium/.test(t) ? "mystery-pack-premium" : "mystery-pack";
  if (/151c|surprise|kines|\bcn\b/.test(t)) return "151c-surprise-cn";
  if (/151/.test(t)) return "scarlet-violet-151";
  if (/op[\s-]?13/.test(t)) return jp ? "op13-jp" : "op13-en";
  return RULES.find(([needle]) => t.includes(needle))?.[1] ?? null;
}

/** Bildens adress, eller null. */
export function packImageSrc(title: string | null | undefined): string | null {
  const key = packKey(title);
  return key ? `/packs/${key}.webp` : null;
}

/** Bredd ÷ höjd för bilden (för fasta mått utan hopp). */
export function packAspect(key: PackKey): number {
  const [w, h] = PACK_IMAGES[key];
  return w / h;
}

/** Två bokstäver för plattan utan bild: "Journey Together" → "JT", "Lorcana: Ink" → "LI". */
export function packInitials(title: string | null | undefined): string {
  const words = (title ?? "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}
