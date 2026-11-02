/**
 * Försäljningstakt och lagerprognos.
 *
 * Takten är antal sålda pack per dag under ett fönster av hela dagar som slutar
 * `asOf` (inklusive). Den uttrycks som bråket units/days så att prognoserna kan
 * räknas exakt med heltal; `perDay` är samma sak som decimaltal för visning
 * (det är ett antal pack, inte pengar).
 *
 *   dagar kvar   = golv(i lager × days / units)      (hela dagar som lagret räcker)
 *   tomt datum   = asOf + tak(i lager × days / units) (dagen då sista packet väntas säljas)
 */

import { addDays, assertIsoDate, daysBetween, maxDate } from "./dates";
import { DomainError } from "./errors";
import { assertSafeInteger, ceilDiv, floorDiv } from "./money";
import type { IsoDate } from "./types";

/** Sålda pack en viss dag. */
export interface DailyUnits {
  readonly date: IsoDate;
  readonly units: number;
}

/** Fönstret som takten räknas över. */
export interface VelocityWindow {
  /** Sista dagen i fönstret (oftast i går eller i dag). */
  readonly asOf: IsoDate;
  /** Fönstrets längd i dagar, t.ex. 7, 14 eller 28. */
  readonly days: number;
  /**
   * Första dag då försäljning var möjlig (t.ex. automatens eller titelns startdag).
   * Fönstret kortas så att dagar före detta inte späder ut takten.
   */
  readonly activeFrom?: IsoDate;
}

/** Försäljningstakt. */
export interface SalesVelocity {
  /** Sålda pack i fönstret. */
  readonly units: number;
  /** Antal dagar i fönstret (efter eventuell kortning). */
  readonly days: number;
  /** units / days, för visning. */
  readonly perDay: number;
  readonly start: IsoDate;
  readonly end: IsoDate;
}

/** Sålda pack per dag från order (varje order är ett pack), sorterat på datum. */
export function dailyUnits(orders: readonly { readonly businessDate: IsoDate }[]): DailyUnits[] {
  const map = new Map<IsoDate, number>();
  for (const o of orders) {
    assertIsoDate(o.businessDate);
    map.set(o.businessDate, (map.get(o.businessDate) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([date, units]) => ({ date, units }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

/**
 * Försäljningstakt (pack per dag) under fönstret som slutar `window.asOf`.
 * salesVelocity(dagar, { asOf: '2026-11-01', days: 7 }) → { units: 21, days: 7, perDay: 3, … }
 */
export function salesVelocity(sales: readonly DailyUnits[], window: VelocityWindow): SalesVelocity {
  assertIsoDate(window.asOf, "Fönstrets slutdag");
  if (!Number.isSafeInteger(window.days) || window.days < 1) {
    throw new DomainError("invalid_input", `Fönstret måste vara minst 1 dag, fick ${window.days}.`);
  }
  let start = addDays(window.asOf, -(window.days - 1));
  if (window.activeFrom !== undefined) {
    assertIsoDate(window.activeFrom, "Startdag");
    start = maxDate(start, window.activeFrom);
  }
  const end = window.asOf;
  if (start > end) {
    return { units: 0, days: 0, perDay: 0, start: end, end };
  }
  let units = 0;
  for (const s of sales) {
    assertIsoDate(s.date);
    assertSafeInteger(s.units, "Antal pack");
    if (s.date >= start && s.date <= end) units += s.units;
  }
  const days = daysBetween(start, end) + 1;
  return { units, days, perDay: units / days, start, end };
}

/**
 * Glidande takt: en takt per dag i `dates`, var och en över de `days` senaste dagarna.
 */
export function salesVelocitySeries(
  sales: readonly DailyUnits[],
  dates: readonly IsoDate[],
  days: number,
): Array<{ date: IsoDate; velocity: SalesVelocity }> {
  return dates.map((date) => ({ date, velocity: salesVelocity(sales, { asOf: date, days }) }));
}

function hasRate(v: SalesVelocity | null): v is SalesVelocity {
  return v !== null && v.units > 0 && v.days > 0;
}

/**
 * Hela dagar som lagret räcker: golv(i lager / takt). `null` när takten är 0
 * (lagret tar aldrig slut med nuvarande takt). 0 om lagret redan är tomt.
 */
export function daysOfStockLeft(onHand: number, velocity: SalesVelocity | null): number | null {
  assertSafeInteger(onHand, "Lagersaldot");
  if (!hasRate(velocity)) return null;
  if (onHand <= 0) return 0;
  return floorDiv(onHand * velocity.days, velocity.units);
}

/**
 * Beräknat datum då sista packet säljs: asOf + tak(i lager / takt).
 * `null` när takten är 0. `asOf` om lagret redan är tomt.
 */
export function stockoutDate(
  asOf: IsoDate,
  onHand: number,
  velocity: SalesVelocity | null,
): IsoDate | null {
  assertIsoDate(asOf);
  assertSafeInteger(onHand, "Lagersaldot");
  if (!hasRate(velocity)) return null;
  if (onHand <= 0) return asOf;
  return addDays(asOf, ceilDiv(onHand * velocity.days, velocity.units));
}
