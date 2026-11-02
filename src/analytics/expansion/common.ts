/**
 * Gemensam hjälp för expansion, scenarier, mål och effekt: underlag med fler enheter,
 * exakta bråk (bigint) och texthjälp.
 *
 * Konventioner som i src/domain: belopp i öre (heltal), andelar i bp, affärsdatum
 * 'ÅÅÅÅ-MM-DD'. Inga flyttal för pengar: kvoter räknas som bråk med `bigint` och avrundas
 * en gång med domänens `roundHalfUp` (halva bort från noll).
 */

import {
  daysInMonth,
  DomainError,
  eachDay,
  MONTH_LCM,
  roundHalfUp,
  type IsoDate,
  type LedgerEntry,
  type Period,
} from "@/domain";
import { evidence } from "../todos/common";
import { kr } from "../todos/text";
import type { Evidence, FigureUnit } from "../todos/types";
import { MINUS, NBSP } from "@/lib/format";

// ---------------------------------------------------------------------------
// Underlag
// ---------------------------------------------------------------------------

/**
 * Enhet för ett tal i underlaget. Utökar `FigureUnit` från Att göra med
 * 'minutes' (tid för påfyllning) och 'hundredths' (elasticitet, −150 = −1,5).
 */
export type ScenarioFigureUnit = FigureUnit | "minutes" | "hundredths";

/** Ett namngivet tal som ett resultat bygger på. Heltal i angiven enhet. */
export interface ScenarioFigure {
  readonly key: string;
  readonly label: string;
  readonly value: number;
  readonly unit: ScenarioFigureUnit;
}

/** Underlag (som `Evidence` i Att göra, men talen kan ha fler enheter). */
export interface ScenarioEvidence extends Omit<Evidence, "figures"> {
  readonly figures: ScenarioFigure[];
}

/** Bygger ett underlag med sorterade, unika listor (samma regler som Att göra). */
export function scenarioEvidence(e: {
  rule: string;
  period?: Period | null;
  orderIds?: Iterable<string>;
  dates?: Iterable<IsoDate>;
  titleIds?: Iterable<string>;
  machineIds?: Iterable<string>;
  storeIds?: Iterable<string>;
  figures?: ScenarioFigure[];
}): ScenarioEvidence {
  const base = evidence({ ...e, figures: [] });
  return { ...base, figures: e.figures ?? [] };
}

/** Kortform för ett tal i underlaget. */
export function fig(
  key: string,
  label: string,
  value: number,
  unit: ScenarioFigureUnit,
): ScenarioFigure {
  return { key, label, value, unit };
}

// ---------------------------------------------------------------------------
// Kontroll av indata
// ---------------------------------------------------------------------------

/**
 * Kastar `DomainError('invalid_amount')` om värdet inte är ett heltal ≥ 0.
 * (Domänens motsvarighet exporteras inte från '@/domain'.)
 */
export function assertNonNegative(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "invalid_amount",
      `${label} måste vara ett heltal ≥ 0, fick ${String(value)}.`,
    );
  }
}

/** Kastar `DomainError('invalid_rate')` om värdet inte är ett heltal i bp mellan 0 och 10 000. */
export function assertRateBp(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > 10_000) {
    throw new DomainError(
      "invalid_rate",
      `${label} måste vara ett heltal i baspunkter mellan 0 och 10000, fick ${String(value)}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Exakta bråk
// ---------------------------------------------------------------------------

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
}

function big(v: number | bigint, label: string): bigint {
  if (typeof v === "bigint") return v;
  if (!Number.isSafeInteger(v)) {
    throw new DomainError("invalid_amount", `${label} måste vara ett heltal, fick ${String(v)}.`);
  }
  return BigInt(v);
}

/**
 * Exakt bråk täljare/nämnare med `bigint`. Används för takter (öre per dag) och viktade
 * snitt, så att inget avrundas förrän resultatet visas. Nämnaren är alltid positiv och
 * bråket är förkortat.
 */
export class Ratio {
  readonly num: bigint;
  readonly den: bigint;

  constructor(num: number | bigint, den: number | bigint = 1n) {
    let n = big(num, "Täljaren");
    let d = big(den, "Nämnaren");
    if (d === 0n) throw new DomainError("division_by_zero", "Division med noll.");
    if (d < 0n) {
      n = -n;
      d = -d;
    }
    const g = gcd(n, d);
    this.num = g > 1n ? n / g : n;
    this.den = g > 1n ? d / g : d;
  }

  static readonly ZERO = new Ratio(0n);

  add(o: Ratio): Ratio {
    return new Ratio(this.num * o.den + o.num * this.den, this.den * o.den);
  }

  sub(o: Ratio): Ratio {
    return new Ratio(this.num * o.den - o.num * this.den, this.den * o.den);
  }

  mul(o: Ratio | number | bigint): Ratio {
    const r = o instanceof Ratio ? o : new Ratio(o);
    return new Ratio(this.num * r.num, this.den * r.den);
  }

  div(o: Ratio | number | bigint): Ratio {
    const r = o instanceof Ratio ? o : new Ratio(o);
    if (r.num === 0n) throw new DomainError("division_by_zero", "Division med noll.");
    return new Ratio(this.num * r.den, this.den * r.num);
  }

  /** −1, 0 eller 1. */
  sign(): -1 | 0 | 1 {
    return this.num < 0n ? -1 : this.num > 0n ? 1 : 0;
  }

  compare(o: Ratio): -1 | 0 | 1 {
    return this.sub(o).sign();
  }

  /** Avrundat till heltal, halva bort från noll (domänens regel). */
  round(): number {
    return roundHalfUp(this.num, this.den);
  }
}

/** Viktat snitt Σ(vikt × värde) / Σ vikt. Kastar om summan av vikterna är 0. */
export function weightedMean(items: readonly { value: Ratio; weight: number }[]): Ratio {
  let sum = Ratio.ZERO;
  let weights = 0n;
  for (const it of items) {
    sum = sum.add(it.value.mul(it.weight));
    weights += big(it.weight, "Vikten");
  }
  if (weights === 0n) throw new DomainError("division_by_zero", "Summan av vikterna är 0.");
  return sum.div(weights);
}

/**
 * Automatmånader som heltal i 1/`MONTH_LCM`: Σ över dagarna i perioden av
 * `MONTH_LCM / dagar i dagens kalendermånad`. Samma regel som domänens "aktiva månader"
 * i enhetsekonomin (`unitEconomics`), så en hel kalendermånad är exakt 1 automatmånad och
 * 15 av 30 dagar exakt 0,5, oavsett hur lång månaden är.
 */
export function monthUnits(period: Period): number {
  let units = 0;
  for (const d of eachDay(period.start, period.end)) units += MONTH_LCM / daysInMonth(d);
  return units;
}

/**
 * Takt per automatmånad: belopp / (enheter / `MONTH_LCM`), exakt. Det är domänens regel
 * för "vinst per månad" (vinst / aktiva månader), så jämförelse, scenario, pipeline och
 * enhetsekonomi visar samma månadstal för samma automat och period.
 * Kastar `DomainError('division_by_zero')` när `units` är 0.
 */
export function perMachineMonth(amount: Ratio | number, units: number): Ratio {
  const a = amount instanceof Ratio ? amount : new Ratio(amount);
  return a.mul(MONTH_LCM).div(units);
}

/** Månader per år i omräkningen till avkastning per år (per år = per månad × 12). */
export const MONTHS_PER_YEAR = 12;

/** Spåret till orderna: order-id och försäljningsdagar, sorterade och unika. */
export interface OrderTrail {
  readonly orderIds: string[];
  readonly dates: IsoDate[];
}

/**
 * Order-id och dagar för liggarens poster som uppfyller filtret (butik, automat, bara
 * prissatta). Används i underlaget så att UI kan länka till exakt de order ett tal bygger på.
 */
export function orderTrail(
  entries: readonly LedgerEntry[],
  filter: { storeId?: string | null; machineId?: string | null; pricedOnly?: boolean } = {},
): OrderTrail {
  const ids = new Set<string>();
  const dates = new Set<IsoDate>();
  for (const e of entries) {
    if (filter.storeId != null && e.storeId !== filter.storeId) continue;
    if (filter.machineId != null && e.order.machineId !== filter.machineId) continue;
    if (filter.pricedOnly && !e.priced) continue;
    ids.add(e.order.id);
    dates.add(e.order.businessDate);
  }
  return {
    orderIds: [...ids].sort(),
    dates: [...dates].sort(),
  };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Kronor med tecken: +1 240 kr · −350 kr · ±0 kr (hela kronor). */
export function signedKr(ore: number): string {
  const rounded = roundHalfUp(ore, 100);
  if (rounded === 0) return `±0${NBSP}kr`;
  return rounded > 0 ? `+${kr(ore)}` : kr(ore);
}

/** Procent med tecken från bp, hela procent: 2 312 → "+23 %", −500 → "−5 %". */
export function signedPct(bp: number): string {
  const whole = roundHalfUp(bp, 100);
  if (whole === 0) return `±0${NBSP}%`;
  const abs = Math.abs(whole);
  return `${whole > 0 ? "+" : MINUS}${abs}${NBSP}%`;
}

/**
 * Hundradelar som decimaltal: −150 → "−1,5", −125 → "−1,25", 0 → "0".
 * Används för elasticitet.
 */
export function hundredths(value: number): string {
  if (value === 0) return "0";
  const sign = value < 0 ? MINUS : "";
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  const frac = abs - whole * 100;
  if (frac === 0) return `${sign}${whole}`;
  const digits = String(frac).padStart(2, "0").replace(/0$/, "");
  return `${sign}${whole},${digits}`;
}
