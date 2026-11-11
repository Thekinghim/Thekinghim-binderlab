/**
 * Raden under rubriken på ett förslagskort: uppskattad effekt, säkerhet och dagen
 * siffrorna kommer från. Egen rad under rubriken, så att rubriken får hela bredden på
 * mobilen (den bröts annars mitt i ord bredvid effekten). Ren funktion.
 */

import { day } from "@/analytics/todos/text";
import { formatInt, NBSP } from "@/lib/format";

/** Hur säkert förslaget är, i vanliga ord (aldrig "test": det lät som att appen provkörde). */
export const CONFIDENCE_TEXT = {
  high: "säkert",
  medium: "troligt",
  low: "värt att prova",
} as const;

export function suggestionMeta(s: {
  readonly effectSekMonth: number;
  readonly confidence: keyof typeof CONFIDENCE_TEXT;
  /** Affärsdagen siffrorna kommer från ('ÅÅÅÅ-MM-DD'), om den är känd. */
  readonly dataDate?: string | null;
}): string {
  const effect =
    s.effectSekMonth > 0 ? `≈${NBSP}${formatInt(s.effectSekMonth)}${NBSP}kr/mån` : "effekt okänd";
  const parts = [effect, CONFIDENCE_TEXT[s.confidence]];
  if (s.dataDate && /^\d{4}-\d{2}-\d{2}$/.test(s.dataDate)) {
    parts.push(`siffror från ${day(s.dataDate)}`);
  }
  return parts.join(" · ");
}
