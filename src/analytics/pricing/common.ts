/**
 * Gemensam hjälp för marknadsanalyserna (releaser, marknadspriser, sortiment och
 * prissättning): underlag med inköps-id, bidrag per order och exakt avrundning av bråk.
 *
 * Konventioner som i src/domain: belopp i öre (heltal), andelar i bp, affärsdatum
 * 'ÅÅÅÅ-MM-DD'. Kvoter räknas som exakta bråk (`Ratio`, bigint) och avrundas en gång,
 * halva bort från noll (domänens `roundHalfUp`).
 */

import {
  BP_SCALE,
  createEconomicsContext,
  DomainError,
  orderEconomics,
  roundHalfUp,
  type EconomicsSources,
  type IsoDate,
  type OrderLine,
  type Period,
} from "@/domain";
import { formatInt, MINUS, NBSP } from "@/lib/format";
import {
  Ratio,
  scenarioEvidence,
  type ScenarioEvidence,
  type ScenarioFigure,
} from "../expansion/common";
import { uniqueSorted } from "../todos/common";

// ---------------------------------------------------------------------------
// Underlag
// ---------------------------------------------------------------------------

/**
 * Underlag för marknadsanalyserna. Som `ScenarioEvidence` (regel, period, order, dagar,
 * titlar, automater, butiker och tal) plus `purchaseIds`: de inköp (inköpsorderrader) som
 * resultatet bygger på, så att UI kan länka till dem. Listorna är sorterade och unika.
 */
export interface MarketEvidence extends ScenarioEvidence {
  readonly purchaseIds: string[];
}

/** Bygger ett underlag. Tomma listor om inget anges. */
export function marketEvidence(e: {
  rule: string;
  period?: Period | null;
  orderIds?: Iterable<string>;
  dates?: Iterable<IsoDate>;
  titleIds?: Iterable<string>;
  machineIds?: Iterable<string>;
  storeIds?: Iterable<string>;
  purchaseIds?: Iterable<string>;
  figures?: ScenarioFigure[];
}): MarketEvidence {
  return { ...scenarioEvidence(e), purchaseIds: uniqueSorted(e.purchaseIds ?? []) };
}

// ---------------------------------------------------------------------------
// Bråk
// ---------------------------------------------------------------------------

/** Bråket avrundat nedåt till heltal (golv). floorRatio(7/2) → 3, floorRatio(−7/2) → −4. */
export function floorRatio(r: Ratio): number {
  let q = r.num / r.den;
  if (r.num % r.den !== 0n && r.num < 0n) q -= 1n;
  return safe(q);
}

/** Bråket avrundat uppåt till heltal (tak). ceilRatio(7/2) → 4, ceilRatio(3/1) → 3. */
export function ceilRatio(r: Ratio): number {
  let q = r.num / r.den;
  if (r.num % r.den !== 0n && r.num > 0n) q += 1n;
  return safe(q);
}

/** Bråket i bp (× 10 000), avrundat. bpOf(1/3) → 3 333. */
export function bpOf(r: Ratio): number {
  return roundHalfUp(r.num * BigInt(BP_SCALE), r.den);
}

/** Bråket i tiondelar (× 10), avrundat. Används för pack per vecka: 25/2 → 125 (= 12,5). */
export function tenthsOf(r: Ratio): number {
  return roundHalfUp(r.num * 10n, r.den);
}

/** Bråket i hundradelar (× 100), avrundat. Används för elasticitet och robust z. */
export function hundredthsOf(r: Ratio): number {
  return roundHalfUp(r.num * 100n, r.den);
}

/**
 * Relativ förändring (nu − före) / före i bp, avrundad. `null` när före är 0.
 * relativeChangeBp(110, 100) → 1 000 (+10 %). Tar heltal eller bråk.
 */
export function relativeChangeBp(now: Ratio | number, before: Ratio | number): number | null {
  const a = now instanceof Ratio ? now : new Ratio(now);
  const b = before instanceof Ratio ? before : new Ratio(before);
  if (b.sign() === 0) return null;
  const diff = a.sub(b).div(b.sign() < 0 ? b.mul(-1) : b);
  return bpOf(diff);
}

function safe(v: bigint): number {
  if (v > BigInt(Number.MAX_SAFE_INTEGER) || v < -BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new DomainError("overflow", "Talet är för stort för att räknas exakt.");
  }
  return Number(v);
}

// ---------------------------------------------------------------------------
// Bidrag per order
// ---------------------------------------------------------------------------

/**
 * Täckningsbidrag per order (rörligt bidrag):
 *
 *   bidrag = nettointäkt − inköp − kortavgift − provision
 *
 * med domänens regler (`orderEconomics`): moms ur beloppet, kortavgift på belopp inkl. moms,
 * provision på belopp exkl. moms enligt avtalet i butiken där automaten stod orderns dag,
 * och inköpspriset som gällde orderns dag. Hyran ingår inte: den är en fast kostnad som inte
 * ändras av sortiment eller pris. `null` när ordern saknar inköpspris.
 */
export function orderContributions(
  orders: readonly OrderLine[],
  sources: EconomicsSources,
): Map<string, number | null> {
  const ctx = createEconomicsContext(sources);
  const out = new Map<string, number | null>();
  for (const o of orders) {
    const e = orderEconomics(o, ctx);
    out.set(
      o.id,
      e.costOre === null ? null : e.netRevenueOre - e.costOre - e.cardFeeOre - e.commissionOre,
    );
  }
  return out;
}

/**
 * Det vanligaste beloppet bland orderna (typvärdet), det pris kunderna oftast betalade.
 * Lika många → det lägsta beloppet. `null` utan order.
 * modalAmount([4900, 4900, 5900]) → 4 900.
 */
export function modalAmount(orders: readonly { readonly amountOre: number }[]): number | null {
  const counts = new Map<number, number>();
  for (const o of orders) counts.set(o.amountOre, (counts.get(o.amountOre) ?? 0) + 1);
  let best: number | null = null;
  let bestCount = 0;
  for (const [amount, count] of counts) {
    if (count > bestCount || (count === bestCount && best !== null && amount < best)) {
      best = amount;
      bestCount = count;
    }
  }
  return best;
}

/** Sorterar på datum och sedan id (deterministisk ordning oavsett indata). */
export function byDateThenId<T extends { readonly id: string; readonly businessDate: IsoDate }>(
  a: T,
  b: T,
): number {
  if (a.businessDate !== b.businessDate) return a.businessDate < b.businessDate ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Jämför strängar för sortering (ingen lokal, så ordningen är densamma överallt). */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** Tiondelar som text, decimal bara när den behövs: 125 → "12,5", 120 → "12", −5 → "−0,5". */
export function tenthsText(t: number): string {
  const sign = t < 0 ? MINUS : "";
  const abs = Math.abs(t);
  const whole = Math.floor(abs / 10);
  const frac = abs - whole * 10;
  return frac === 0 ? `${sign}${formatInt(whole)}` : `${sign}${formatInt(whole)},${frac}`;
}

/** Tiondelar med tecken: 125 → "+12,5", −30 → "−3", 0 → "±0". */
export function signedTenths(t: number): string {
  if (t === 0) return "±0";
  return t > 0 ? `+${tenthsText(t)}` : tenthsText(t);
}

/** Absolut procent från bp, hela procent: −2 140 → "21 %". */
export function pctAbs(bp: number): string {
  return `${formatInt(Math.abs(roundHalfUp(bp, 100)))}${NBSP}%`;
}

/** Hundradelar med två decimaler: 472 → "4,72", −350 → "−3,50". */
export function hundredthsFixed(value: number): string {
  const sign = value < 0 ? MINUS : "";
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 100);
  return `${sign}${whole},${String(abs - whole * 100).padStart(2, "0")}`;
}

/** Lista med "och" före sista: ["A", "B", "C"] → "A, B och C". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} och ${items[items.length - 1]}`;
}
