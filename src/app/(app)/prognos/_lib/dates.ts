/**
 * Affärsdatum ('ÅÅÅÅ-MM-DD') till text via src/lib/format. Datumen tolkas som lokal
 * midnatt (samma som skalet), så att dagen aldrig flyttas av tidszonen.
 */

import { parseIsoDate } from "@/components/shell/period-state";
import type { IsoDate, Period } from "@/domain";
import {
  formatDate,
  formatPeriod,
  formatPeriodShort,
  formatWeekdayDay,
  MISSING,
} from "@/lib/format";

export function toDate(d: IsoDate): Date {
  return parseIsoDate(d) ?? new Date(Number.NaN);
}

/** 1 nov. (innevarande år utelämnas). */
export function dateText(d: IsoDate | null | undefined, now?: Date): string {
  if (!d) return MISSING;
  return formatDate(toDate(d), { year: "auto", now });
}

/**
 * "26 okt." på axeln och i tabellhuvuden: som i löptexten och som de delade diagrammen
 * (design.md §4, Siffror). Året skrivs aldrig.
 */
export function dayText(d: IsoDate): string {
  return formatDate(toDate(d), { year: "never" });
}

/** tis 26 okt */
export function weekdayDayText(d: IsoDate): string {
  return formatWeekdayDay(toDate(d));
}

/** 3 okt. – 1 nov. */
export function periodShort(p: Period, now?: Date): string {
  return formatPeriodShort({ start: toDate(p.start), end: toDate(p.end) }, now);
}

/** 3 okt. – 1 nov. 2026 */
export function periodLong(p: Period): string {
  return formatPeriod({ start: toDate(p.start), end: toDate(p.end) });
}
