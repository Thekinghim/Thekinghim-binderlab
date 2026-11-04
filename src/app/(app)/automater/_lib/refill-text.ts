/**
 * Raden bredvid "Lager · nu" på automatsidan: pack i automaten och senaste registrerade
 * påfyllning. En inventering (Awish-läsning eller räkning) är ingen påfyllning: finns ingen
 * registrerad påfyllning står det "ingen påfyllning registrerad än", så att det syns att
 * påfyllningarna behöver registreras i Fyll på (annars fungerar varken svinnkontrollen eller
 * besöksplanen). Ren funktion; testas i refill-text.test.ts.
 */

import { wallClockIn } from "@/components/shell/period-state";
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
