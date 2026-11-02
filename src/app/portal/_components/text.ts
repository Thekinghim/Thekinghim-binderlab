/**
 * Formatering för portalen. Allt går via src/lib/format.ts; här finns bara
 * omvandlingen från portalens enheter (öre, bp, 'ÅÅÅÅ-MM') till dess indata.
 */

import {
  NBSP,
  formatDate,
  formatDateTime,
  formatDelta,
  formatInt,
  formatKronor,
  formatMonth,
  formatPercent,
  formatSek,
} from "@/lib/format";
import { utcToZoned } from "@/import/zoned";

/** 'ÅÅÅÅ-MM' → Date mitt i månaden (samma månad i alla tidszoner). */
export function monthDate(month: string): Date {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(y, m - 1, 15, 12);
}

/** 'ÅÅÅÅ-MM-DD' → Date mitt på dagen. */
export function dayDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

/** "oktober 2026" */
export function monthText(month: string): string {
  return formatMonth(monthDate(month));
}

/** "oktober" (utan år), för löptext inom samma år. */
export function monthNameText(month: string): string {
  return formatMonth(monthDate(month)).replace(/\s\d{4}$/, "");
}

/** Kort månad för axlar: "okt." */
export function monthShortText(month: string): string {
  const name = monthNameText(month);
  return name.length <= 4 ? name : `${name.slice(0, 3)}.`;
}

/** Hela kronor: "12 480 kr" */
export function kr(ore: number): string {
  return formatSek(ore / 100);
}

/** Kronor med ören: "12 480,50 kr" */
export function krExact(ore: number): string {
  return formatKronor(ore / 100);
}

/** bp → "10,0 %" */
export function pct(bp: number, digits = 1): string {
  return formatPercent(bp / 10_000, digits);
}

/** Förändring i bp → "+8 %" */
export function deltaText(bp: number): string {
  return formatDelta(bp / 10_000, Math.abs(bp) < 1000 ? 1 : 0);
}

export function packs(n: number): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? "pack" : "pack"}`;
}

/** En tidpunkt (ISO, UTC) → väggklocka i en tidszon som en lokal Date. */
function zonedWallClock(at: Date, timeZone: string): Date {
  const p = utcToZoned(at, timeZone);
  return new Date(p.year, p.month - 1, p.day, p.hour, p.minute);
}

/**
 * "2 nov. 11:35" i organisationens tidszon (som Inkorgen), oavsett serverns zon.
 * Året skrivs ut när det inte är innevarande år i samma zon.
 */
export function dateTimeText(iso: string, timeZone: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return formatDateTime(at);
  return formatDateTime(zonedWallClock(at, timeZone), { now: zonedWallClock(now, timeZone) });
}

export function dateText(date: string): string {
  return formatDate(dayDate(date));
}

/** Ett tal i ett underlag (Evidence.figures). */
export function figureText(value: number, unit: "ore" | "bp" | "count" | "days"): string {
  switch (unit) {
    case "ore":
      return krExact(value);
    case "bp":
      return pct(value, 2);
    case "count":
      return `${formatInt(value)}${NBSP}st`;
    case "days":
      return `${formatInt(value)}${NBSP}${value === 1 ? "dag" : "dagar"}`;
  }
}
