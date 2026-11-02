/**
 * Likhet mellan titelnamn, för att hitta felstavade eller dubbla titlar.
 *
 * Steg 1, normalisering (normalizeTitle): gemener, diakritiska tecken bort (utom å, ä, ö),
 * allt som inte är bokstav eller siffra blir mellanslag, flera mellanslag blir ett.
 *   "Black-Bolt " → "black bolt", "Pokémon 151" → "pokemon 151".
 *
 * Steg 2, regler (compareTitles). Två namn föreslås som dubbletter om något av följande gäller:
 *   1. 'same'       – lika efter normalisering (skiljer bara i versaler, accenter, skiljetecken).
 *   2. 'spacing'    – lika när mellanslagen tas bort ("Blackbolt" / "Black Bolt").
 *   3. 'word-order' – samma ord i annan ordning ("Bolt Black" / "Black Bolt").
 *   4. 'typo'       – samma antal ord, och orden skiljer sig med högst några tangenttryck
 *                     (Damerau–Levenshtein): högst 1 per ord på 4–7 tecken och högst 2 per ord
 *                     på 8+ tecken, högst 1 totalt om namnet är kortare än 12 tecken och högst 2
 *                     annars. Ord kortare än 4 tecken måste vara lika, och siffrorna i varje ord
 *                     måste vara exakt lika ("Series 1" / "Series 2" är olika produkter).
 *
 * Ett extra ord betyder en annan produkt: "Mystery Pack" / "Mystery pack premium" föreslås aldrig.
 */

import { roundHalfUp } from "@/domain";
import { normalize as normalizeChars } from "@/lib/fuzzy";

/** Varför två namn räknas som samma titel. */
export type DuplicateReason = "same" | "spacing" | "word-order" | "typo";

/** Resultatet av en jämförelse. */
export interface TitleComparison {
  readonly duplicate: boolean;
  readonly reason: DuplicateReason | null;
  /** Damerau–Levenshtein-avstånd mellan de normaliserade namnen utan mellanslag. */
  readonly distance: number;
  /** Likhet i bp: round((1 − avstånd / längsta längd) × 10 000). */
  readonly similarityBp: number;
}

/** Normaliserar ett titelnamn (se modulens beskrivning). */
export function normalizeTitle(name: string): string {
  return normalizeChars(name.normalize("NFC"))
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * Damerau–Levenshtein-avstånd (optimal string alignment): minsta antal infogningar,
 * borttag, utbyten och byten av två intilliggande tecken. "bolt" → "blot" = 1.
 */
export function damerauLevenshtein(a: string, b: string): number {
  const s = [...a];
  const t = [...b];
  const n = s.length;
  const m = t.length;
  if (n === 0) return m;
  if (m === 0) return n;
  // Tre rader räcker: föregående-föregående, föregående och aktuell.
  let prev2: number[] = new Array<number>(m + 1).fill(0);
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur: number[] = new Array<number>(m + 1).fill(0);
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      let v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      if (i > 1 && j > 1 && s[i - 1] === t[j - 2] && s[i - 2] === t[j - 1]) {
        v = Math.min(v, (prev2[j - 2] ?? 0) + 1);
      }
      cur[j] = v;
    }
    prev2 = prev;
    prev = cur;
  }
  return prev[m] ?? 0;
}

function digitsOf(token: string): string {
  return token.replace(/\D+/g, " ").trim();
}

/** Högsta tillåtna avstånd för ett ord av längden `len` (se regel 4). */
function tokenAllowance(len: number): number {
  if (len < 4) return 0;
  return len >= 8 ? 2 : 1;
}

/** Jämför två titelnamn enligt reglerna i modulens beskrivning. */
export function compareTitles(a: string, b: string): TitleComparison {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  const ca = na.replace(/ /g, "");
  const cb = nb.replace(/ /g, "");
  const distance = damerauLevenshtein(ca, cb);
  const longest = Math.max([...ca].length, [...cb].length);
  const similarityBp = longest === 0 ? 0 : roundHalfUp((longest - distance) * 10_000, longest);
  const result = (reason: DuplicateReason | null): TitleComparison => ({
    duplicate: reason !== null,
    reason,
    distance,
    similarityBp,
  });

  if (ca.length === 0 || cb.length === 0) return result(null);
  if (na === nb) return result("same");
  if (ca === cb) return result("spacing");

  const ta = na.split(" ");
  const tb = nb.split(" ");
  if (ta.length !== tb.length) return result(null);

  const sortedA = [...ta].sort().join(" ");
  const sortedB = [...tb].sort().join(" ");
  if (sortedA === sortedB) return result("word-order");

  const totalAllowance = Math.max([...ca].length, [...cb].length) >= 12 ? 2 : 1;
  let total = 0;
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i] ?? "";
    const y = tb[i] ?? "";
    if (x === y) continue;
    if (digitsOf(x) !== digitsOf(y)) return result(null);
    const d = damerauLevenshtein(x, y);
    const allowance = tokenAllowance(Math.min([...x].length, [...y].length));
    if (d > allowance) return result(null);
    total += d;
    if (total > totalAllowance) return result(null);
  }
  return result(total > 0 ? "typo" : null);
}
