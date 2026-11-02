/**
 * Kontroll av talen i assistentens svar: varje tal i svaret ska finnas i något
 * verktygsresultat (eller i frågan). En enkel kontroll, inte ett bevis: den fångar
 * egna uppskattningar, avrundningar ("ca 12 tkr") och felskrivna tal, men inte ett
 * tal som råkar finnas någon annanstans i underlaget.
 *
 * Regler:
 * - Tal skrivs med svensk formatering: "12 480 kr", "23,7 %", "−1 240 kr", "1,5".
 *   Enheten räknas inte (12 480 kr, 12480kr och 12480 är samma tal), men TECKNET gör det:
 *   "1 240" godtas inte när underlaget säger −1 240 (en förlust skriven som vinst), och
 *   "−12 %" godtas inte när underlaget säger 12. Minus skrivs − (U+2212) eller -; ett
 *   bindestreck direkt efter en bokstav eller siffra (BL-002, 2026-10) är inget tecken.
 * - Datum, årtal, klockslag, veckonummer och id (BL‑002) räknas inte som tal i svaret.
 *   Ett årtal följt av en enhet ("2050 kr", "2050 pack") är däremot ett tal.
 * - I underlaget räknas alla tal i resultatet: JSON-tal, tal i texter ("12 480 kr"),
 *   antal rader i listor och belopp i öre (…Ore) omräknade till kronor, baspunkter
 *   (…Bp) till procent och tusendelar (…Milli) till hela enheter.
 * - 0 och 1 godtas alltid ("1 automat").
 *
 * Ren modul utan databas och utan "server-only" (testas i verify.test.ts).
 */

export interface NumberVerification {
  /** Antal tal i svaret som kontrollerades. */
  readonly checked: number;
  /** Talen (som de stod i svaret) som inte fanns i underlaget, utan dubbletter. */
  readonly unverified: string[];
}

const SPACE = "[ \\u00A0\\u202F]";
const MONTH =
  "(?:januari|februari|mars|april|maj|juni|juli|augusti|september|oktober|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|okt|nov|dec)";

/** Enheter som får stå direkt efter talet ("12480kr", "15st", "23,7%"). */
const UNIT_SUFFIX = "(?:tkr|mkr|kr|sek|öre|st|pack|%)";
/** Enheter som gör ett årtalsliknande tal till ett belopp eller antal ("2050 kr"). */
const UNIT_WORD =
  "(?:tkr|mkr|kr|kronor|sek|öre|st|styck|stycken|pack|paket|order|köp|enheter|procent|%)";
/** Tecken före ett tal: bindestreck, minus (U+2212) och plus. */
const SIGN_CHARS = new Set(["-", "\u2212", "+"]);

/**
 * Ett tal: tusentalsgrupper med mellanslag (12 480), eller siffror i följd, med
 * eventuell decimaldel. Föregås inte av bokstav, siffra, punkt eller komma (v44, Q3)
 * och följs inte av en bokstav direkt (4x), utom en enhet (12480kr). Tecknet framför
 * läses i extractNumbers.
 */
const NUMBER_RE = new RegExp(
  `(?<![\\p{L}\\d_\\u2011/.,])(?:\\d{1,3}(?:${SPACE}\\d{3})+(?!\\d)|\\d+)(?:,\\d+)?(?=$|[^\\p{L}\\d]|${UNIT_SUFFIX}(?![\\p{L}\\d]))`,
  "gu",
);

/** Sådant som innehåller siffror men inte är tal att kontrollera. */
const NOT_NUMBERS: RegExp[] = [
  // ISO-datum och -månader: 2026-10-01, 2026-10
  /\b\d{4}-\d{2}(?:-\d{2})?\b/g,
  // Klockslag: 09:05
  /\b\d{1,2}:\d{2}\b/g,
  // Dagar och intervall före en månad: "1 okt.", "1–30 nov.", "3 okt. – 1 nov."
  new RegExp(
    `\\b\\d{1,2}(?:${SPACE}?[–-]${SPACE}?\\d{1,2})?${SPACE}?${MONTH}(?!\\p{L})\\.?`,
    "giu",
  ),
  // Veckonummer: vecka 44, v. 44, v44
  /\b(?:vecka|veckorna|v\.?)\s?\d{1,2}(?:\s?[–-]\s?\d{1,2})?\b/giu,
  // Årtal: 1990–2100 som eget ord, utom när en enhet följer ("2050 kr" är ett belopp)
  new RegExp(
    `(?<![\\d,])\\b(?:199\\d|20\\d{2}|2100)\\b(?!,\\d|${SPACE}\\d{3}(?!\\d)|${SPACE}?${UNIT_WORD}(?!\\p{L}))`,
    "gu",
  ),
  // Numrerade listor i början av en rad: "1. ", "2) "
  /^\s*\d{1,2}[.)]\s/gm,
];

/** Kanoniskt värde för jämförelse: talet MED tecken, två decimaler (−0 blir 0). */
export function canonical(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  const fixed = value.toFixed(2);
  return fixed === "-0.00" ? "0.00" : fixed;
}

/** "12 480,5" → 12480.5, "−1 240" → −1240. null om det inte är ett tal. */
export function parseSwedishNumber(token: string): number | null {
  const cleaned = token.replace(/[   ]/g, "").replace(",", ".").replace(/^−/, "-");
  if (!/^[-+]?\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Alla tal i en text (utan undantagen ovan), som de står i texten, med tecknet framför
 * ("−1 240"). Ett bindestreck direkt efter en bokstav eller siffra är en kod eller ett
 * intervall (BL-002, 2026-10): då räknas talet inte alls.
 */
export function extractNumbers(text: string, options: { skipDates?: boolean } = {}): string[] {
  let scrubbed = text;
  if (options.skipDates !== false) {
    for (const re of NOT_NUMBERS) {
      scrubbed = scrubbed.replace(re, (m) => " ".repeat(m.length));
    }
  }
  const tokens: string[] = [];
  for (const m of scrubbed.matchAll(NUMBER_RE)) {
    const index = m.index ?? 0;
    const prev = index > 0 ? scrubbed[index - 1]! : "";
    if (SIGN_CHARS.has(prev)) {
      const before = index > 1 ? scrubbed[index - 2]! : "";
      if (/[\p{L}\d_‑]/u.test(before)) continue; // BL-002, 2026-10
      tokens.push(prev + m[0]);
    } else {
      tokens.push(m[0]);
    }
  }
  return tokens;
}

/** Lägger till ett tal i mängden (kanoniskt). */
function add(set: Set<string>, value: number): void {
  const key = canonical(value);
  if (key !== null) set.add(key);
}

/** Avrundning till heltal, symmetrisk kring 0 (−12,5 → −13 som 12,5 → 13). */
function round(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** Lägger till varianter som ett belopp/en andel kan skrivas som i svaret (med tecken). */
function addDerived(set: Set<string>, key: string, value: number): void {
  add(set, value);
  if (/ore$/i.test(key)) {
    add(set, value / 100);
    add(set, round(value / 100));
    add(set, round(value / 10_000) / 10); // tkr med en decimal
    add(set, round(value / 100_000)); // tkr
  } else if (/bp$/i.test(key)) {
    add(set, value / 100);
    add(set, round(value / 10) / 10);
    add(set, round(value / 100));
  } else if (/milli$/i.test(key)) {
    add(set, value / 1000);
    add(set, round(value / 100) / 10);
    add(set, round(value / 1000));
  }
}

/** Alla tal i ett verktygsresultat (JSON) och i fritexter, som kanoniska värden. */
export function collectNumbers(sources: readonly unknown[]): Set<string> {
  const set = new Set<string>(["0.00", "1.00"]);
  const visit = (value: unknown, key: string): void => {
    if (typeof value === "number") {
      addDerived(set, key, value);
    } else if (typeof value === "string") {
      for (const token of extractNumbers(value, { skipDates: false })) {
        const n = parseSwedishNumber(token);
        if (n !== null) add(set, n);
      }
      // Datumdelar, så att "13 okt." i svaret inte behövs men ändå godtas om de räknas.
      for (const m of value.matchAll(/\b(\d{4})-(\d{2})(?:-(\d{2}))?\b/g)) {
        for (const part of m.slice(1)) if (part) add(set, Number(part));
      }
    } else if (Array.isArray(value)) {
      add(set, value.length);
      value.forEach((item) => visit(item, key));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) visit(v, k);
    }
  };
  sources.forEach((s) => visit(s, ""));
  return set;
}

/**
 * Kontrollerar att varje tal i `answer` finns i `sources` (verktygsresultat, frågan).
 */
export function verifyNumbers(answer: string, sources: readonly unknown[]): NumberVerification {
  const allowed = collectNumbers(sources);
  const tokens = extractNumbers(answer);
  const unverified: string[] = [];
  let checked = 0;
  for (const token of tokens) {
    const value = parseSwedishNumber(token);
    if (value === null) continue;
    checked += 1;
    const key = canonical(value);
    if (key !== null && !allowed.has(key) && !unverified.includes(token)) {
      unverified.push(token);
    }
  }
  return { checked, unverified };
}
