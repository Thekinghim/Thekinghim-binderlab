/**
 * Textformatering för Att göra och Värt att veta.
 *
 * Allt räknas med heltal (öre, bp, tiondelar) och formateras utan `Date`, så att texten
 * är densamma oavsett processens tidszon. Tal formateras med src/lib/format.ts
 * (hårt mellanslag, äkta minustecken).
 */

import {
  dayOfWeek,
  parseIsoDate,
  roundHalfUp,
  type IsoDate,
  type IsoMonth,
  type Period,
} from "@/domain";
import { EN_DASH, formatInt, MINUS, NBSP, SPACED_RANGE_DASH } from "@/lib/format";

const MONTHS_SHORT = [
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
] as const;

const MONTHS_LONG = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
] as const;

const WEEKDAYS_SHORT = ["mån", "tis", "ons", "tor", "fre", "lör", "sön"] as const;
const WEEKDAYS_LONG = [
  "måndag",
  "tisdag",
  "onsdag",
  "torsdag",
  "fredag",
  "lördag",
  "söndag",
] as const;
const WEEKDAYS_PLURAL = [
  "måndagar",
  "tisdagar",
  "onsdagar",
  "torsdagar",
  "fredagar",
  "lördagar",
  "söndagar",
] as const;

/** Hela kronor: 123 456 öre → "1 235 kr" (halva kronor avrundas uppåt). */
export function kr(ore: number): string {
  return `${formatInt(roundHalfUp(ore, 100))}${NBSP}kr`;
}

/** Kronor med ören: −350 öre → "−3,50 kr". */
export function krExact(ore: number): string {
  const sign = ore < 0 ? MINUS : "";
  const abs = Math.abs(ore);
  const whole = Math.floor(abs / 100);
  const cents = abs - whole * 100;
  return `${sign}${formatInt(whole)},${String(cents).padStart(2, "0")}${NBSP}kr`;
}

/** Procent från bp med en decimal, som andelen utan inköpspris på Lönsamhet: 352 bp → "3,5 %". */
export function pct1(bp: number): string {
  const tenths = roundHalfUp(bp, 10);
  return `${formatInt(Math.trunc(tenths / 10))},${Math.abs(tenths % 10)}${NBSP}%`;
}

/** Procent från bp, hela procent: 3 312 bp → "33 %". */
export function pct(bp: number): string {
  return `${formatInt(roundHalfUp(bp, 100))}${NBSP}%`;
}

/** Tiondelar som decimaltal med komma: 14 → "1,4", 30 → "3,0". */
export function tenths(value: number): string {
  const sign = value < 0 ? MINUS : "";
  const abs = Math.abs(value);
  const whole = Math.floor(abs / 10);
  return `${sign}${formatInt(whole)},${abs - whole * 10}`;
}

/** Kvoten a/b med en decimal, avrundad: (41, 14) → "2,9". */
export function ratioTenths(numerator: number, denominator: number): string {
  return tenths(roundHalfUp(numerator * 10, denominator));
}

/** Singular eller plural: plural(1, 'dag', 'dagar') → "1 dag". */
export function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

/** Kort datum: '2026-10-31' → "31 okt.". */
export function day(date: IsoDate): string {
  const p = parseIsoDate(date);
  return `${p.day}${NBSP}${MONTHS_SHORT[p.month - 1]}`;
}

/** Kort datum med veckodag: '2026-10-31' → "lör 31 okt.". */
export function weekdayDay(date: IsoDate): string {
  return `${WEEKDAYS_SHORT[dayOfWeek(date) - 1]} ${day(date)}`;
}

/** Veckodagens namn, 1 = måndag: 6 → "lördag". */
export function weekdayName(isoWeekday: number): string {
  return WEEKDAYS_LONG[isoWeekday - 1] ?? "";
}

/** Veckodagens namn i plural, 1 = måndag: 6 → "lördagar". */
export function weekdayPlural(isoWeekday: number): string {
  return WEEKDAYS_PLURAL[isoWeekday - 1] ?? "";
}

/** Månadens namn: '2026-10' → "oktober". */
export function monthName(month: IsoMonth): string {
  return MONTHS_LONG[Number(month.slice(5, 7)) - 1] ?? month;
}

/** Kort period: "1–30 nov." · "28 okt. – 3 nov." · "1 nov.". Året skrivs inte ut. */
export function periodText(period: Period): string {
  if (period.start === period.end) return day(period.start);
  const a = parseIsoDate(period.start);
  const b = parseIsoDate(period.end);
  if (a.year === b.year && a.month === b.month) {
    return `${a.day}${EN_DASH}${b.day}${NBSP}${MONTHS_SHORT[b.month - 1]}`;
  }
  return `${day(period.start)}${SPACED_RANGE_DASH}${day(period.end)}`;
}

/** Versal första bokstav: "lördagar" → "Lördagar". */
export function capitalize(text: string): string {
  return text.length === 0 ? text : text.charAt(0).toLocaleUpperCase("sv-SE") + text.slice(1);
}

/** Avslutar en mening med punkt, utan dubbel punkt efter förkortning: "slut 4 nov." → "slut 4 nov.". */
export function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}
