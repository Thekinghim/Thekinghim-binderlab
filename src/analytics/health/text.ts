/**
 * Texthjälp för maskinhälsa, larm och besöksplan. Bygger på src/analytics/todos/text
 * (heltal in, svensk text ut, utan `Date`).
 */

import { floorDiv } from "@/domain";
import { formatInt, NBSP } from "@/lib/format";
import { localParts } from "@/analytics/todos/time";
import { plural, weekdayDay, weekdayName } from "@/analytics/todos/text";

/** Sannolikhet i bp som procent med högst två decimaler: 23 → "0,23 %", 150 → "1,5 %", 0 → "under 0,01 %". */
export function probabilityText(bp: number): string {
  if (bp <= 0) return `under 0,01${NBSP}%`;
  const whole = floorDiv(bp, 100);
  const rest = bp - whole * 100;
  if (rest === 0) return `${formatInt(whole)}${NBSP}%`;
  const decimals = rest % 10 === 0 ? String(rest / 10) : String(rest).padStart(2, "0");
  return `${formatInt(whole)},${decimals}${NBSP}%`;
}

/** Varaktighet: "45 min" under en timme, "5 timmar" under 72 timmar, annars "3 dygn". */
export function durationText(minutes: number): string {
  if (minutes < 60) return `${formatInt(Math.max(0, minutes))}${NBSP}min`;
  const hours = floorDiv(minutes, 60);
  return hours < 72
    ? plural(hours, "timme", "timmar")
    : plural(floorDiv(hours, 24), "dygn", "dygn");
}

/** Tidpunkt som "mån 2 nov. 14:37" i tidszonen. */
export function whenText(ms: number, timeZone: string): string {
  const p = localParts(ms, timeZone);
  return `${weekdayDay(p.date)} ${p.time}`;
}

/** Timintervall: 14 → "14–15". */
export function hourRangeText(hour: number): string {
  return `${String(hour).padStart(2, "0")}–${String((hour + 1) % 24).padStart(2, "0")}`;
}

/**
 * Veckotimmar som text, sammanslagna när de följer på varandra samma veckodag:
 * [{mån, 14}, {mån, 15}, {tis, 9}] → "måndag 14–16, tisdag 09–10".
 */
export function slotsText(slots: readonly { weekday: number; hour: number }[]): string {
  const sorted = [...slots].sort((a, b) => a.weekday - b.weekday || a.hour - b.hour);
  const ranges: { weekday: number; from: number; to: number }[] = [];
  for (const s of sorted) {
    const last = ranges[ranges.length - 1];
    if (last && last.weekday === s.weekday && last.to === s.hour) last.to = s.hour + 1;
    else ranges.push({ weekday: s.weekday, from: s.hour, to: s.hour + 1 });
  }
  const pad = (h: number) => String(h % 24).padStart(2, "0");
  return ranges.map((r) => `${weekdayName(r.weekday)} ${pad(r.from)}–${pad(r.to)}`).join(", ");
}
