/**
 * Veckomönster för en automat: hur många pack den brukar sälja varje veckodag och timme,
 * och hur många pack den därför väntas sälja under en given tid.
 *
 *   takt(veckotimme)  = sålda pack under veckotimmen i historiken / antal gånger veckotimmen
 *                       förekom i historiken (när automaten var i drift och inte känt offline)
 *   förväntat(tid)    = Σ över timmarna i tiden: (andel av timmen som ingår) × takt(veckotimmen)
 *
 * En veckotimme som aldrig förekommit i historiken bidrar med 0 (inget underlag). En timme där
 * automaten aldrig sålt (t.ex. natt eller stängt) bidrar också med 0, så att en tyst natt aldrig
 * ser avvikande ut.
 */

import { roundHalfUp } from "@/domain";
import { calendarHourAt, HOUR_MS, WEEK_SLOTS, type HourCalendar, type HourSlot } from "./calendar";
import type { SlotContribution } from "./types";

/** En försäljning med tidpunkt. */
export interface SaleInstant {
  readonly id: string;
  readonly ms: number;
}

/** Veckomönstret. Listorna har en plats per veckotimme (0–167). */
export interface WeeklyProfile {
  /** Sålda pack per veckotimme. */
  readonly counts: readonly number[];
  /** Antal gånger varje veckotimme förekom (hela timmar). */
  readonly exposure: readonly number[];
  /** Orderna bakom `counts`, per veckotimme. */
  readonly orderIds: readonly (readonly string[])[];
  readonly totalOrders: number;
  readonly totalHours: number;
  readonly fromMs: number;
  readonly toMs: number;
}

/**
 * Räknar veckomönstret över hela timmar i [fromMs, toMs). `include` avgör vilka timmar som
 * räknas (t.ex. bara när automaten var i drift och inte offline). Försäljning under timmar
 * som inte räknas ignoreras.
 */
export function buildWeeklyProfile(
  calendar: HourCalendar,
  sales: readonly SaleInstant[],
  fromMs: number,
  toMs: number,
  include: (hour: HourSlot) => boolean = () => true,
): WeeklyProfile {
  const counts = new Array<number>(WEEK_SLOTS).fill(0);
  const exposure = new Array<number>(WEEK_SLOTS).fill(0);
  const orderIds: string[][] = Array.from({ length: WEEK_SLOTS }, () => []);
  const included = new Set<number>();
  let totalHours = 0;
  for (const h of calendar.hours) {
    if (h.startMs < fromMs || h.startMs + HOUR_MS > toMs || !include(h)) continue;
    exposure[h.slot] = (exposure[h.slot] ?? 0) + 1;
    included.add(h.startMs);
    totalHours++;
  }
  let totalOrders = 0;
  for (const s of sales) {
    const h = calendarHourAt(calendar, s.ms);
    if (!h || !included.has(h.startMs)) continue;
    counts[h.slot] = (counts[h.slot] ?? 0) + 1;
    orderIds[h.slot]?.push(s.id);
    totalOrders++;
  }
  return { counts, exposure, orderIds, totalOrders, totalHours, fromMs, toMs };
}

/** Förväntat antal under en tid, med bidraget per veckotimme. */
export interface Expectation {
  /** Förväntat antal pack (λ). */
  readonly lambda: number;
  /** Bidrag per veckotimme som förekommer i tiden, störst först. */
  readonly contributions: SlotContribution[];
}

/**
 * Förväntat antal sålda pack under [fromMs, toMs) enligt veckomönstret.
 * Delar av timmar räknas med sin andel (en tystnad från 14:30 ger halva timmen 14–15).
 */
export function expectedSales(
  profile: WeeklyProfile,
  calendar: HourCalendar,
  fromMs: number,
  toMs: number,
): Expectation {
  const weight = new Map<number, number>(); // veckotimme → summa av andelar (i ms)
  let lambda = 0;
  for (const h of calendar.hours) {
    const start = Math.max(h.startMs, fromMs);
    const end = Math.min(h.startMs + HOUR_MS, toMs);
    if (end <= start) continue;
    weight.set(h.slot, (weight.get(h.slot) ?? 0) + (end - start));
  }
  const contributions: SlotContribution[] = [];
  for (const [slot, ms] of [...weight.entries()].sort((a, b) => a[0] - b[0])) {
    const exp = profile.exposure[slot] ?? 0;
    const count = profile.counts[slot] ?? 0;
    const value = exp === 0 ? 0 : (ms / HOUR_MS) * (count / exp);
    lambda += value;
    contributions.push({
      weekday: Math.floor(slot / 24) + 1,
      hour: slot % 24,
      expectedMilli: Math.round(value * 1000),
      historyOrders: count,
      historyHours: exp,
    });
  }
  contributions.sort(
    (a, b) => b.expectedMilli - a.expectedMilli || a.weekday - b.weekday || a.hour - b.hour,
  );
  return { lambda, contributions };
}

/** Förväntat antal i tusendelar → tiondelar för text: 6 249 → 62 (= 6,2). */
export function milliToTenths(milli: number): number {
  return roundHalfUp(milli, 100);
}
