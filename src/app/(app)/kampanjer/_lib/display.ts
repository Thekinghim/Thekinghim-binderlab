/**
 * Datum för Kampanjer och Gratis-pack: affärsdatum ("ÅÅÅÅ-MM-DD") som korta svenska
 * etiketter. Rena funktioner (används både på servern och i webbläsaren).
 */

import { addDays } from "@/domain/dates";
import type { IsoDate } from "@/domain/types";

const MONTHS = [
  "jan.",
  "feb.",
  "mars",
  "apr.",
  "maj",
  "juni",
  "juli",
  "aug.",
  "sep.",
  "okt.",
  "nov.",
  "dec.",
];

export function addDaysIso(day: string, days: number): string {
  return addDays(day as IsoDate, days);
}

/** "i dag", "i morgon", "i går", "17 nov." eller "17 nov. 2027" (annat år), som resten av sajten. */
export function dayLabel(day: string, today: string): string {
  if (day === today) return "i dag";
  if (day === addDaysIso(today, 1)) return "i morgon";
  if (day === addDaysIso(today, -1)) return "i går";
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const base = `${d} ${MONTHS[m - 1] ?? ""}`;
  return String(y) === today.slice(0, 4) ? base : `${base} ${y}`;
}
