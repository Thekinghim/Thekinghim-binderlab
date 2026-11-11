/**
 * Slutdagen som en mening: "Tar slut på lördag – fyll på senast fredag".
 *
 * En dag är lättare att handla efter än "räcker ca 2,3 dagar". Samma mening i Att göra och
 * överallt där slutdagen från sellOut() visas.
 */

import { addDays, dayOfWeek, type IsoDate } from "@/domain";
import { weekdayDay, weekdayName } from "@/analytics/todos/text";

/** Fyll på senast så här många dagar före slutdagen (som besöksplanens marginal). */
export const FILL_BUFFER_DAYS = 1;

/** "i dag", "i morgon", "på lördag" (inom en vecka) eller "lör 21 nov.". */
export function dayPhrase(date: IsoDate, today: IsoDate): string {
  if (date <= today) return "i dag";
  if (date === addDays(today, 1)) return "i morgon";
  if (date <= addDays(today, 6)) return `på ${weekdayName(dayOfWeek(date))}`;
  return weekdayDay(date);
}

/**
 * sellOutPhrase("2026-11-14", "2026-11-12") → "Tar slut på lördag – fyll på senast i morgon"
 * sellOutPhrase("2026-11-14", "2026-11-11") → "Tar slut på lördag – fyll på senast fredag"
 * sellOutPhrase("2026-11-13", "2026-11-12") → "Tar slut i morgon – fyll på i dag"
 * sellOutPhrase("2026-11-12", "2026-11-12") → "Tar slut i dag – fyll på nu"
 */
export function sellOutPhrase(
  date: IsoDate,
  today: IsoDate,
  bufferDays: number = FILL_BUFFER_DAYS,
): string {
  if (date <= today) return "Tar slut i dag – fyll på nu";
  const by = addDays(date, -bufferDays);
  const out = `Tar slut ${dayPhrase(date, today)}`;
  if (by <= today) return `${out} – fyll på i dag`;
  if (by === addDays(today, 1)) return `${out} – fyll på senast i morgon`;
  // "senast fredag", inte "senast på fredag".
  const when = by <= addDays(today, 6) ? weekdayName(dayOfWeek(by)) : weekdayDay(by);
  return `${out} – fyll på senast ${when}`;
}
