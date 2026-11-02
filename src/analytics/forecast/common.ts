/**
 * Gemensam hjälp för prognos, förlorad försäljning och inköpsplanering: underlag med
 * tusendelar av pack, heltalsrot, kontroll av indata och texter.
 *
 * Konventioner som i src/domain: belopp i öre (heltal), andelar i bp (10 000 = 100 %),
 * affärsdatum 'ÅÅÅÅ-MM-DD' i Europe/Stockholm. Antal pack som inte är hela (en prognos,
 * en takt) anges i tusendelar ("milli": 1 500 = 1,5 pack), så att allt är heltal och
 * resultatet är exakt detsamma på varje dator och i varje tidszon.
 */

import { DomainError, roundHalfUp, type IsoDate, type Period } from "@/domain";
import { formatInt, MINUS, NBSP } from "@/lib/format";
import { evidence } from "../todos/common";
import type { Evidence, FigureUnit } from "../todos/types";

/** Tusendelar per pack. */
export const MILLI = 1_000;

// ---------------------------------------------------------------------------
// Underlag
// ---------------------------------------------------------------------------

/** Enhet för ett tal i underlaget: som i Att göra, plus 'milli' (tusendelar av pack). */
export type PlanFigureUnit = FigureUnit | "milli";

/** Ett namngivet tal som ett resultat bygger på. Heltal i angiven enhet. */
export interface PlanFigure {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit: PlanFigureUnit;
}

/** Underlag (som `Evidence` i Att göra, men talen kan anges i tusendelar av pack). */
export interface PlanEvidence extends Omit<Evidence, "figures"> {
  readonly figures: PlanFigure[];
}

/** Kortform för ett tal i underlaget. */
export function fig(key: string, label: string, value: number, unit: PlanFigureUnit): PlanFigure {
  return { key, label, value, unit };
}

/** Bygger ett underlag med sorterade, unika listor (samma regler som Att göra). */
export function planEvidence(e: {
  rule: string;
  period?: Period | null;
  orderIds?: Iterable<string>;
  dates?: Iterable<IsoDate>;
  titleIds?: Iterable<string>;
  machineIds?: Iterable<string>;
  storeIds?: Iterable<string>;
  figures?: PlanFigure[];
}): PlanEvidence {
  const base = evidence({ ...e, figures: [] });
  return { ...base, figures: e.figures ?? [] };
}

// ---------------------------------------------------------------------------
// Kontroll av indata
// ---------------------------------------------------------------------------

/** Kastar `DomainError('invalid_input')` om värdet inte är ett heltal ≥ `min`. */
export function assertIntAtLeast(value: unknown, min: number, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new DomainError(
      "invalid_input",
      `${label} måste vara ett heltal ≥ ${min}, fick ${String(value)}.`,
    );
  }
  return value;
}

/** Kastar `DomainError('invalid_amount')` om beloppet inte är ett heltal i öre ≥ 0. */
export function assertOre(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "invalid_amount",
      `${label} måste vara ett heltal i öre ≥ 0, fick ${String(value)}.`,
    );
  }
  return value;
}

/** Omvandlar ett `bigint` till ett säkert heltal, annars `DomainError('overflow')`. */
export function safeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError("overflow", `${what} är för stort för att räknas exakt.`);
  }
  return Number(value);
}

// ---------------------------------------------------------------------------
// Heltalsaritmetik
// ---------------------------------------------------------------------------

/**
 * Heltalsroten ur ett icke-negativt heltal, avrundad till närmaste heltal (halva uppåt).
 * Räknas med Newtons metod på `bigint`, så att svaret är exakt och lika överallt.
 * isqrtRound(10n) → 3n (√10 ≈ 3,16), isqrtRound(12n) → 3n (√12 ≈ 3,46), isqrtRound(13n) → 4n (√13 ≈ 3,61).
 */
export function isqrtRound(n: bigint): bigint {
  if (n < 0n) throw new DomainError("invalid_input", "Roten ur ett negativt tal.");
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  // x = golv(√n). Avrunda: (x + ½)² = x² + x + ¼ ≤ n ⇔ x² + x < n (heltal).
  return x * x + x < n ? x + 1n : x;
}

/** Summan av heltal med kontroll av att den ryms exakt. */
export function sumInts(values: Iterable<number>): number {
  let s = 0;
  for (const v of values) {
    s += v;
    if (!Number.isSafeInteger(s)) {
      throw new DomainError("overflow", "Summan är för stor för att räknas exakt.");
    }
  }
  return s;
}

/** Nyckel för en serie titel × automat. */
export function seriesKey(machineId: string, titleId: string): string {
  return `${machineId}\u0000${titleId}`;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Hela pack från tusendelar, avrundat: 41 600 → "42". */
export function packs(milli: number): string {
  return formatInt(roundHalfUp(milli, MILLI));
}

/** Pack med en decimal från tusendelar: 1 450 → "1,5", −250 → "−0,3". */
export function packsOneDecimal(milli: number): string {
  const tenths = roundHalfUp(milli, 100);
  const sign = tenths < 0 ? MINUS : "";
  const abs = Math.abs(tenths);
  const whole = Math.floor(abs / 10);
  return `${sign}${formatInt(whole)},${abs - whole * 10}`;
}

/** Med tecken: 120 → "+0,1", −1 450 → "−1,5", 0 → "0,0". */
export function signedPacksOneDecimal(milli: number): string {
  const s = packsOneDecimal(milli);
  return roundHalfUp(milli, 100) > 0 ? `+${s}` : s;
}

/** Faktor från bp med en decimal: 14 000 → "1,4". */
export function factorText(bp: number): string {
  return packsOneDecimal(roundHalfUp(bp, 10));
}

/**
 * Ungefärligt belopp för rubriker: hela kronor avrundade till 100 kr från 1 000 kr,
 * till 10 kr från 100 kr, annars till hela kronor. 318 740 öre → "ca 3 200 kr".
 */
export function approxKr(ore: number): string {
  const kronor = roundHalfUp(ore, 100);
  const abs = Math.abs(kronor);
  const step = abs >= 1_000 ? 100 : abs >= 100 ? 10 : 1;
  const rounded = roundHalfUp(kronor, step) * step;
  return `ca${NBSP}${formatInt(rounded)}${NBSP}kr`;
}
