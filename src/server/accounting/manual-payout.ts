/**
 * "Vad betalade Awish?": utbetalningar som ägaren skriver in för hand i stället för att
 * ladda upp en fil. Ren modul (ingen databas): vilken period frågan gäller, radens referens
 * och fingeravtryck.
 */

import {
  addDays,
  addMonths,
  daysBetween,
  monthEnd,
  monthOf,
  type IsoDate,
  type Period,
} from "@/domain";
import { sha256Hex } from "@/import/hash";

/**
 * Så stor skillnad räknas som avrundning när en utbetalning är inskriven för hand: den som
 * läser av kontot skriver ofta hela kronor.
 */
export const MANUAL_TOLERANCE_ORE = 500;

type Span = { readonly periodStart: IsoDate; readonly periodEnd: IsoDate };

function isFullMonth(p: Period): boolean {
  const month = monthOf(p.start);
  return p.start === `${month}-01` && p.end === monthEnd(month);
}

/**
 * Perioden som nästa fråga gäller, eller null när den inte är slut än.
 *
 * - Ingen utbetalning finns: förra kalendermånaden (en utbetalning i månaden antas, som i
 *   kassaflödet).
 * - Annars dagen efter den senaste utbetalningens period och lika långt fram: en hel månad
 *   följs av nästa hela månad, en vecka av nästa vecka.
 *
 * Perioden måste vara slut (sista dagen före i dag): pengarna för pågående dagar har inte
 * kommit.
 */
export function nextPayoutPeriod(payouts: readonly Span[], today: IsoDate): Period | null {
  let period: Period;
  if (payouts.length === 0) {
    const month = addMonths(monthOf(today), -1);
    period = { start: `${month}-01`, end: monthEnd(month) };
  } else {
    const last = payouts.reduce((a, b) => (b.periodEnd > a.periodEnd ? b : a));
    const start = addDays(last.periodEnd, 1);
    const monthly = isFullMonth({ start: last.periodStart, end: last.periodEnd });
    period = monthly
      ? { start, end: monthEnd(monthOf(start)) }
      : { start, end: addDays(start, daysBetween(last.periodStart, last.periodEnd)) };
  }
  return period.end < today ? period : null;
}

/** Utbetalningen (ej arkiverad) som redan täcker någon av periodens dagar, om någon. */
export function overlappingPayout<T extends Span>(payouts: readonly T[], period: Period): T | null {
  return payouts.find((p) => p.periodStart <= period.end && p.periodEnd >= period.start) ?? null;
}

/**
 * Radens referens: "Inskriven 2026-10" för en hel månad, annars "Inskriven 2026-10-14 till
 * 2026-10-31". Är den upptagen (t.ex. efter en arkiverad och rättad rad) läggs "(2)" till.
 */
export function manualReference(period: Period, taken: ReadonlySet<string>): string {
  const base = isFullMonth(period)
    ? `Inskriven ${monthOf(period.start)}`
    : period.start === period.end
      ? `Inskriven ${period.start}`
      : `Inskriven ${period.start} till ${period.end}`;
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Radens fingeravtryck (source_hash är obligatoriskt): innehållet som skrevs in. */
export function manualSourceHash(input: {
  readonly reference: string;
  readonly period: Period;
  readonly paidOn: IsoDate;
  readonly amountOre: number;
}): string {
  return sha256Hex(
    [
      "manual",
      input.reference,
      input.period.start,
      input.period.end,
      input.paidOn,
      input.amountOre,
    ].join("\u001f"),
  );
}
