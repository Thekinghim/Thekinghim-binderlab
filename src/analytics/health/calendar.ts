/**
 * Timkalender i organisationens tidszon.
 *
 * Varje timme (räknad i UTC från hel timme) får sitt affärsdatum, sin veckodag och sitt
 * klockslag i tidszonen. Tidszonen anges alltid uttryckligen till Intl (via
 * src/analytics/todos/time), så resultatet beror aldrig på processens tidszon. Sommartid
 * hanteras automatiskt: natten till sista söndagen i mars har 23 timmar, i oktober 25.
 *
 * Veckotimme ("slot") = (veckodag − 1) × 24 + timme, 0 = måndag 00–01 … 167 = söndag 23–24.
 *
 * Begränsning: för tidszoner med halvtimmesförskjutning hamnar en UTC-timme i den lokala
 * timme där den börjar. För Europe/Stockholm är UTC-timmar och lokala timmar desamma.
 */

import { dayOfWeek, DomainError, type IsoDate } from "@/domain";
import { HOUR_MS, localParts } from "@/analytics/todos/time";

export { HOUR_MS };

/** Minuter per timme. */
export const MINUTE_MS = 60_000;

/** Antal timmar i en vecka. */
export const WEEK_SLOTS = 168;

/** En timme i kalendern. */
export interface HourSlot {
  /** Timmens början, ms sedan 1970 (UTC, alltid hel timme). */
  readonly startMs: number;
  /** Affärsdatum i tidszonen. */
  readonly date: IsoDate;
  /** 1 = måndag … 7 = söndag. */
  readonly weekday: number;
  /** Lokal timme 0–23. */
  readonly hour: number;
  /** Veckotimme 0–167. */
  readonly slot: number;
}

/** Kalender över timmarna från `startMs` (hel timme) till `endMs` (exklusive). */
export interface HourCalendar {
  readonly startMs: number;
  readonly endMs: number;
  readonly timeZone: string;
  readonly hours: readonly HourSlot[];
}

/** Hel UTC-timme som `ms` ligger i (golv). */
export function floorHour(ms: number): number {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/** Veckotimme 0–167 för veckodag (1–7) och timme (0–23). */
export function slotOf(weekday: number, hour: number): number {
  return (weekday - 1) * 24 + hour;
}

/** Lokal timme, datum och veckodag för en tidpunkt. */
export function hourSlotAt(ms: number, timeZone: string): HourSlot {
  const start = floorHour(ms);
  const p = localParts(start, timeZone);
  const hour = Number(p.time.slice(0, 2));
  const weekday = dayOfWeek(p.date);
  return { startMs: start, date: p.date, weekday, hour, slot: slotOf(weekday, hour) };
}

/**
 * Bygger kalendern för [fromMs, toMs). `fromMs` avrundas nedåt till hel timme.
 * Kastar om intervallet är längre än `maxHours` (skydd mot orimliga indata, standard 2 år).
 */
export function buildHourCalendar(
  fromMs: number,
  toMs: number,
  timeZone: string,
  maxHours = 2 * 366 * 24,
): HourCalendar {
  const startMs = floorHour(fromMs);
  const count = Math.max(0, Math.ceil((toMs - startMs) / HOUR_MS));
  if (count > maxHours) {
    throw new DomainError(
      "invalid_input",
      `Kalendern skulle bli ${count} timmar, högst ${maxHours} tillåts.`,
    );
  }
  const hours: HourSlot[] = [];
  for (let i = 0; i < count; i++) hours.push(hourSlotAt(startMs + i * HOUR_MS, timeZone));
  return { startMs, endMs: startMs + count * HOUR_MS, timeZone, hours };
}

/** Timmen som `ms` ligger i, eller `undefined` utanför kalendern. */
export function calendarHourAt(calendar: HourCalendar, ms: number): HourSlot | undefined {
  if (ms < calendar.startMs || ms >= calendar.endMs) return undefined;
  return calendar.hours[Math.floor((ms - calendar.startMs) / HOUR_MS)];
}

/**
 * Första tidpunkten (i steg om 15 minuter) som hör till affärsdatumet `date` i tidszonen,
 * dvs. lokal midnatt. Söker från UTC-midnatt − 14 timmar, vilket täcker alla tidszoner.
 * localDayStartMs('2026-11-02', 'Europe/Stockholm') → 2026-11-01T23:00:00Z.
 */
export function localDayStartMs(date: IsoDate, timeZone: string): number {
  const utcMidnight = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  );
  const step = 15 * MINUTE_MS;
  for (let ms = utcMidnight - 14 * HOUR_MS; ms <= utcMidnight + 14 * HOUR_MS; ms += step) {
    if (localParts(ms, timeZone).date >= date) return ms;
  }
  throw new DomainError("invalid_input", `Hittade ingen midnatt för ${date} i ${timeZone}.`);
}
