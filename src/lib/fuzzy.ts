/**
 * Fuzzy-matchning för kommandopaletten och andra snabbsökningar.
 *
 * Rangordning (tier, högst först):
 *   4  prefix       "för"  → "Försäljning"
 *   3  ordstart     "scan" → "Mall of Scandinavia"
 *   2  delsträng    "älj"  → "Försäljning"
 *   1  subsekvens   "fsg"  → "Försäljning"
 *
 * Skiftlägesokänslig. Å, Ä och Ö är egna bokstäver (a matchar inte å),
 * medan övriga diakritiska tecken tas bort (é → e, ü → u). Varje tecken
 * normaliseras för sig, så index i resultatet pekar rakt in i originalet.
 */

export const TIER = { prefix: 4, wordStart: 3, substring: 2, subsequence: 1 } as const;
export type Tier = (typeof TIER)[keyof typeof TIER];

export type FuzzyMatch = {
  tier: Tier;
  /** Högre är bättre. Tier väger tyngst, därefter position och täthet. */
  score: number;
  /** Index i originalsträngen för matchade tecken, stigande. */
  indices: number[];
};

const KEEP = new Set(["å", "ä", "ö"]);
const charCache = new Map<string, string>();

/** Normaliserar ett enskilt tecken till gemen, utan diakritik utom å ä ö. */
export function normalizeChar(ch: string): string {
  const cached = charCache.get(ch);
  if (cached !== undefined) return cached;
  const lower = ch.toLocaleLowerCase("sv-SE");
  let out = lower;
  if (!KEEP.has(lower)) {
    const base = lower.normalize("NFD").replace(/[̀-ͯ]/g, "");
    // Behåll 1:1-längd så att index stämmer; annars originalet.
    out = base.length === 1 ? base : lower.length === 1 ? lower : ch;
  }
  charCache.set(ch, out);
  return out;
}

/** Normaliserar en hel sträng tecken för tecken (samma längd som indata). */
export function normalize(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += normalizeChar(text.charAt(i));
  return out;
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/** Sant om index i är början på ett ord (först, eller efter mellanslag, -, /, . osv.). */
function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text.charAt(i - 1);
  const cur = text.charAt(i);
  if (!isWordChar(prev)) return true;
  // Siffra efter bokstav räknas som ny början: "BL001" → "001"
  return /\p{N}/u.test(cur) && /\p{L}/u.test(prev);
}

function range(start: number, length: number): number[] {
  return Array.from({ length }, (_, k) => start + k);
}

/** Matchar en (normaliserad, icke-tom) fråga mot en (normaliserad) text. */
function matchNormalized(q: string, t: string): FuzzyMatch | null {
  if (q.length === 0 || q.length > t.length) return null;
  const lengthPenalty = Math.min(t.length, 60) / 100;

  if (t.startsWith(q)) {
    return {
      tier: TIER.prefix,
      score: TIER.prefix * 100 - lengthPenalty,
      indices: range(0, q.length),
    };
  }

  // Delsträng: föredra en förekomst på ordstart, annars den första.
  let first = -1;
  for (let at = t.indexOf(q); at !== -1; at = t.indexOf(q, at + 1)) {
    if (first === -1) first = at;
    if (isWordStart(t, at)) {
      return {
        tier: TIER.wordStart,
        score: TIER.wordStart * 100 - at / 10 - lengthPenalty,
        indices: range(at, q.length),
      };
    }
  }
  if (first !== -1) {
    return {
      tier: TIER.substring,
      score: TIER.substring * 100 - first / 10 - lengthPenalty,
      indices: range(first, q.length),
    };
  }

  // Subsekvens: girig, men hoppar fram till nästa ordstart om tecknet finns där
  // och resten av frågan fortfarande ryms efter den positionen.
  const query = q.replace(/\s+/g, "");
  if (query.length === 0) return null;
  // latest[qi] = senaste position där query[qi] kan stå och resten ändå matcha.
  const latest: number[] = new Array<number>(query.length);
  let bound = t.length;
  for (let qi = query.length - 1; qi >= 0; qi--) {
    const at = t.lastIndexOf(query.charAt(qi), bound - 1);
    if (at === -1) return null;
    latest[qi] = at;
    bound = at;
  }
  const indices: number[] = [];
  let ti = 0;
  let bonus = 0;
  for (let qi = 0; qi < query.length; qi++) {
    const ch = query.charAt(qi);
    const next = t.indexOf(ch, ti);
    if (next === -1) return null;
    let pick = next;
    const prevIdx = indices[indices.length - 1];
    const consecutive = prevIdx !== undefined && next === prevIdx + 1;
    if (!consecutive && !isWordStart(t, next)) {
      const limit = latest[qi] ?? next;
      for (let k = next + 1; k <= limit; k++) {
        if (t.charAt(k) === ch && isWordStart(t, k)) {
          pick = k;
          break;
        }
      }
    }
    if (prevIdx !== undefined && pick === prevIdx + 1) bonus += 2;
    if (isWordStart(t, pick)) bonus += 3;
    indices.push(pick);
    ti = pick + 1;
  }
  const firstIdx = indices[0] ?? 0;
  const lastIdx = indices[indices.length - 1] ?? 0;
  const spread = lastIdx - firstIdx + 1 - query.length;
  const score =
    TIER.subsequence * 100 + Math.min(bonus, 60) - spread - firstIdx / 10 - lengthPenalty;
  return { tier: TIER.subsequence, score, indices };
}

/**
 * Matchar fråga mot text. Fråga med flera ord matchas först som helhet;
 * om det misslyckas måste varje ord träffa för sig (tier = sämsta ordets).
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const q = normalize(query.trim());
  if (q.length === 0) return null;
  const t = normalize(text);
  const whole = matchNormalized(q, t);
  const tokens = q.split(/\s+/).filter(Boolean);
  if (whole && (whole.tier > TIER.subsequence || tokens.length < 2)) return whole;
  if (tokens.length < 2) return null;

  let tier: Tier = TIER.prefix;
  let score = 0;
  const all = new Set<number>();
  for (const token of tokens) {
    const m = matchNormalized(token, t);
    if (!m) return whole;
    if (m.tier < tier) tier = m.tier;
    // Bara bonusdelen (utan tier) räknas; tier sätts av det sämsta ordet.
    score += m.score - m.tier * 100;
    for (const i of m.indices) all.add(i);
  }
  const tokenMatch: FuzzyMatch = {
    tier,
    score: tier * 100 + score / tokens.length,
    indices: [...all].sort((a, b) => a - b),
  };
  if (!whole || tokenMatch.tier > whole.tier) return tokenMatch;
  return whole.score >= tokenMatch.score ? whole : tokenMatch;
}

export type SearchFields = {
  label: string;
  /** Visas bredvid etiketten och markeras vid träff, t.ex. "BL-010" */
  hint?: string;
  /** Söks men visas inte */
  keywords?: readonly string[];
};

export type FieldMatch = FuzzyMatch & {
  field: "label" | "hint" | "keyword";
  /** Texten som träffades (etiketten, hinten eller nyckelordet). */
  value: string;
};

/**
 * Matchar mot etikett, hint och nyckelord. Etiketten kan matcha i alla
 * tiers; hint och nyckelord kräver minst delsträng (subsekvens i korta id:n
 * ger brus) och rankas strax under en etikettträff i samma tier.
 */
export function matchFields(query: string, fields: SearchFields): FieldMatch | null {
  let best: FieldMatch | null = null;
  const consider = (
    m: FuzzyMatch | null,
    field: FieldMatch["field"],
    value: string,
    penalty: number,
  ) => {
    if (!m) return;
    if (field !== "label" && m.tier < TIER.substring) return;
    const candidate: FieldMatch = { ...m, score: m.score - penalty, field, value };
    if (!best || candidate.score > best.score) best = candidate;
  };
  consider(fuzzyMatch(query, fields.label), "label", fields.label, 0);
  if (fields.hint) consider(fuzzyMatch(query, fields.hint), "hint", fields.hint, 30);
  for (const kw of fields.keywords ?? []) consider(fuzzyMatch(query, kw), "keyword", kw, 40);
  return best;
}

export type Ranked<T> = { item: T; match: FieldMatch };

/** Filtrerar och sorterar poster efter träff; stabil vid lika poäng. */
export function fuzzyRank<T>(
  items: readonly T[],
  query: string,
  fields: (item: T) => SearchFields,
): Ranked<T>[] {
  const out: Array<Ranked<T> & { order: number }> = [];
  items.forEach((item, order) => {
    const match = matchFields(query, fields(item));
    if (match) out.push({ item, match, order });
  });
  out.sort((a, b) => b.match.score - a.match.score || a.order - b.order);
  return out.map(({ item, match }) => ({ item, match }));
}

/** Delar upp text i segment för markering av matchade tecken. */
export function highlightSegments(
  text: string,
  indices: readonly number[],
): Array<{ text: string; match: boolean }> {
  if (indices.length === 0) return [{ text, match: false }];
  const set = new Set(indices);
  const segments: Array<{ text: string; match: boolean }> = [];
  for (let i = 0; i < text.length; i++) {
    const match = set.has(i);
    const last = segments[segments.length - 1];
    if (last && last.match === match) last.text += text.charAt(i);
    else segments.push({ text: text.charAt(i), match });
  }
  return segments;
}
