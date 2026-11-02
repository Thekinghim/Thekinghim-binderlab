/**
 * Kontroll av talen i assistentens svar: varje tal i svaret ska finnas i något
 * verktygsresultat (eller i frågan). En enkel kontroll, inte ett bevis: den fångar
 * egna uppskattningar, avrundningar ("ca 12 tkr") och felskrivna tal, men inte ett
 * tal som råkar finnas någon annanstans i underlaget.
 *
 * Regler:
 * - Tal skrivs med svensk formatering: "12 480 kr", "23,7 %", "−1 240 kr", "1,5".
 *   Tecken och enhet räknas inte; 12 480 kr och 12480 är samma tal.
 * - Datum, årtal, klockslag, veckonummer och id (BL‑002) räknas inte som tal i svaret.
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

/**
 * Ett tal: tusentalsgrupper med mellanslag (12 480), eller siffror i följd, med
 * eventuell decimaldel. Föregås inte av bokstav, siffra eller bindestreck (id som
 * BL-002, v44, Q3) och följs inte av en bokstav direkt (4x).
 */
const NUMBER_RE = new RegExp(
  `(?<![\\p{L}\\d_\\-\\u2011/.,])(?:\\d{1,3}(?:${SPACE}\\d{3})+(?!\\d)|\\d+)(?:,\\d+)?(?![\\p{L}\\d])`,
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
  // Årtal: 1990–2100 som eget ord
  new RegExp(`(?<![\\d,])\\b(?:199\\d|20\\d{2}|2100)\\b(?!,\\d|${SPACE}\\d{3}(?!\\d))`, "g"),
  // Numrerade listor i början av en rad: "1. ", "2) "
  /^\s*\d{1,2}[.)]\s/gm,
];

/** Kanoniskt värde för jämförelse: absolutvärdet med två decimaler. */
export function canonical(value: number): string | null {
  if (!Number.isFinite(value)) return null;
  return Math.abs(value).toFixed(2);
}

/** "12 480,5" → 12480.5. null om det inte är ett tal. */
export function parseSwedishNumber(token: string): number | null {
  const cleaned = token.replace(/[   ]/g, "").replace(",", ".");
  if (!/^\d+(?:\.\d+)?$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/** Alla tal i en text (utan undantagen ovan), som de står i texten. */
export function extractNumbers(text: string, options: { skipDates?: boolean } = {}): string[] {
  let scrubbed = text;
  if (options.skipDates !== false) {
    for (const re of NOT_NUMBERS) {
      scrubbed = scrubbed.replace(re, (m) => " ".repeat(m.length));
    }
  }
  return [...scrubbed.matchAll(NUMBER_RE)].map((m) => m[0]);
}

/** Lägger till ett tal i mängden (kanoniskt). */
function add(set: Set<string>, value: number): void {
  const key = canonical(value);
  if (key !== null) set.add(key);
}

/** Lägger till varianter som ett belopp/en andel kan skrivas som i svaret. */
function addDerived(set: Set<string>, key: string, value: number): void {
  add(set, value);
  if (/ore$/i.test(key)) {
    add(set, value / 100);
    add(set, Math.round(value / 100));
    add(set, Math.round(value / 100_000) / 10); // tkr med en decimal
    add(set, Math.round(value / 100_000)); // tkr
  } else if (/bp$/i.test(key)) {
    add(set, value / 100);
    add(set, Math.round(value / 10) / 10);
    add(set, Math.round(value / 100));
  } else if (/milli$/i.test(key)) {
    add(set, value / 1000);
    add(set, Math.round(value / 100) / 10);
    add(set, Math.round(value / 1000));
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
