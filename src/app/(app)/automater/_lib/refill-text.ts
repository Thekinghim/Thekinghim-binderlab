/**
 * Raden bredvid "Lager · nu" på automatsidan: pack i automaten och senaste registrerade
 * påfyllning. En inventering (Awish-läsning eller räkning) är ingen påfyllning: finns ingen
 * registrerad påfyllning står det "ingen påfyllning registrerad än", så att det syns att
 * påfyllningarna behöver registreras i Fyll på (annars fungerar varken svinnkontrollen eller
 * besöksplanen). Ren funktion; testas i refill-text.test.ts.
 */

import { day, weekdayName } from "@/analytics/todos/text";
import { wallClockIn } from "@/components/shell/period-state";
import { addDays, dayOfWeek, daysBetween, type IsoDate } from "@/domain";
import { formatDateTime, formatInt, NBSP } from "@/lib/format";

export const NO_REFILL_TEXT = "ingen påfyllning registrerad än";

export function stockAsideText(args: {
  readonly packs: number;
  /** Senaste påfyllning eller flytt in (ISO 8601), eller null. */
  readonly lastRefilledAt: string | null;
  readonly timeZone: string;
  /** Nu (ISO 8601). */
  readonly now: string;
}): string {
  const packs = `${formatInt(args.packs)}${NBSP}pack i automaten`;
  if (!args.lastRefilledAt) return `${packs}, ${NO_REFILL_TEXT}.`;
  const at = formatDateTime(wallClockIn(new Date(args.lastRefilledAt), args.timeZone), {
    now: wallClockIn(new Date(args.now), args.timeZone),
  });
  return `${packs}, senast påfylld ${at}.`;
}

/**
 * "Fyll på senast torsdag." ur besöksplanens senaste dag (samma dag som Drift → Besök).
 * Redan passerat: "Fyll på i dag."; i dag: "Fyll på senast i dag." (raden kan heta "Fyll på
 * snart", och då ska meningen inte säga emot den); i morgon: "Fyll på senast i morgon.".
 * Samma dag och samma ord som "Åk till BL-003 senast torsdag" i Att göra och på Hem
 * (visitWhen i @/analytics/todos/visits): veckodagen inom en vecka, annars datumet ("senast
 * 19 nov."), så att "onsdag" aldrig kan betyda nästa veckas onsdag. Ren.
 */
export function refillByText(needBy: IsoDate, today: IsoDate): string {
  if (needBy < today) return "Fyll på i dag.";
  if (needBy === today) return "Fyll på senast i dag.";
  if (needBy === addDays(today, 1)) return "Fyll på senast i morgon.";
  if (daysBetween(today, needBy) < 7) return `Fyll på senast ${weekdayName(dayOfWeek(needBy))}.`;
  return `Fyll på senast ${day(needBy)}.`;
}
