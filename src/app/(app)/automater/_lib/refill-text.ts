/**
 * Raden bredvid "Lager · nu" på automatsidan: pack i automaten och senaste registrerade
 * påfyllning. En inventering (Awish-läsning eller räkning) är ingen påfyllning: finns ingen
 * registrerad påfyllning står det "ingen påfyllning registrerad än", så att det syns att
 * påfyllningarna behöver registreras i Fyll på (annars fungerar varken svinnkontrollen eller
 * besöksplanen). Ren funktion; testas i refill-text.test.ts.
 */

import { weekdayName } from "@/analytics/todos/text";
import { wallClockIn } from "@/components/shell/period-state";
import { addDays, dayOfWeek, type IsoDate } from "@/domain";
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
 * I dag eller redan passerat: "Fyll på i dag."; i morgon: "Fyll på senast i morgon.".
 * Planen går sju dagar framåt, så veckodagen är alltid den närmaste. Ren.
 */
export function refillByText(needBy: IsoDate, today: IsoDate): string {
  if (needBy <= today) return "Fyll på i dag.";
  if (needBy === addDays(today, 1)) return "Fyll på senast i morgon.";
  return `Fyll på senast ${weekdayName(dayOfWeek(needBy))}.`;
}
