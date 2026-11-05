/**
 * Månadsvalet på sidan Värde: vilka månader som går att välja och vilken som visas.
 * Ren funktion.
 */

import { addMonths, monthOf, type IsoDate, type IsoMonth } from "@/domain";

/** Högst så många månader att välja bland. */
export const MAX_MONTHS = 24;

/** Månaden ur ?manad=, annars förra månaden (om den har data), annars innevarande. */
export function pickMonth(
  param: string | null | undefined,
  available: readonly IsoMonth[],
  today: IsoDate,
): IsoMonth {
  if (param && available.includes(param)) return param;
  const previous = addMonths(monthOf(today), -1);
  return available.includes(previous) ? previous : (available[0] ?? monthOf(today));
}

/** Månaderna från första ordern till i dag, nyast först (högst MAX_MONTHS). */
export function availableMonths(dataStart: IsoDate | null, today: IsoDate): IsoMonth[] {
  const last = monthOf(today);
  const first = dataStart ? monthOf(dataStart) : last;
  const out: IsoMonth[] = [];
  for (let m = last; m >= first && out.length < MAX_MONTHS; m = addMonths(m, -1)) out.push(m);
  return out;
}
