/**
 * Svensk text för rapporterna: belopp, procent, datum och perioder.
 *
 * Allt räknas med heltal (öre, baspunkter, affärsdatum som strängar) och utan `Date`,
 * så att texten blir densamma oavsett processens tidszon. Tusentalsavgränsning sker
 * via `formatInt` i src/lib/format.ts (hårt mellanslag), och minus skrivs med äkta
 * minustecken (U+2212), som i resten av gränssnittet.
 */

import { parseIsoDate, parseIsoMonth, roundHalfUp, weekOf, type IsoDate, type IsoMonth, type Period } from "@/domain";
import { MINUS, NBSP, formatInt } from "@/lib/format";

const MONTHS = [
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

/** Hur öre visas: `auto` visar öre bara när beloppet inte är jämna kronor. */
export type OreDisplay = "auto" | "always" | "never";

/**
 * Belopp i öre som kronor: 490 000 → "4 900 kr", 490 050 → "4 900,50 kr",
 * −12 000 → "−120 kr". Med `always` visas alltid två decimaler ("4 900,00 kr");
 * med `never` avrundas till hela kronor (halva kronor uppåt, bort från noll).
 */
export function krText(ore: number, display: OreDisplay = "auto"): string {
  const negative = ore < 0;
  const abs = Math.abs(ore);
  let body: string;
  if (display === "never" || (display === "auto" && abs % 100 === 0)) {
    body = formatInt(roundHalfUp(abs, 100));
  } else {
    const kr = (abs - (abs % 100)) / 100;
    const rest = abs % 100;
    body = `${formatInt(kr)},${rest < 10 ? "0" : ""}${rest}`;
  }
  const isZero = body === "0" || body === "0,00";
  return `${negative && !isZero ? MINUS : ""}${body}${NBSP}kr`;
}

/** Förändring i kronor med tecken: "+1 200 kr", "−80 kr", "±0 kr". */
export function signedKrText(ore: number, display: OreDisplay = "auto"): string {
  if (ore === 0) return `±${krText(0, display)}`;
  return ore > 0 ? `+${krText(ore, display)}` : krText(ore, display);
}

/**
 * Baspunkter som procent: 3 300 → "33 %", 2 520 med en decimal → "25,2 %".
 * Avrundning: halva bort från noll.
 */
export function pctText(bp: number, digits: 0 | 1 = 0): string {
  const negative = bp < 0;
  const abs = Math.abs(bp);
  let body: string;
  if (digits === 0) {
    body = formatInt(roundHalfUp(abs, 100));
  } else {
    const tenths = roundHalfUp(abs, 10);
    body = `${formatInt((tenths - (tenths % 10)) / 10)},${tenths % 10}`;
  }
  const isZero = body === "0" || body === "0,0";
  return `${negative && !isZero ? MINUS : ""}${body}${NBSP}%`;
}

/** Förändring i procent med tecken: "+12 %", "−8 %", "±0 %". */
export function signedPctText(bp: number, digits: 0 | 1 = 0): string {
  const text = pctText(bp, digits);
  if (text.startsWith(MINUS)) return text;
  return /^0(,0)? %$/.test(text) ? `±${text}` : `+${text}`;
}

/** Förändring i procentenheter: 120 bp → "+1,2 procentenheter". */
export function pointsText(bpDiff: number): string {
  const text = signedPctText(bpDiff, 1).replace(`${NBSP}%`, "");
  return `${text}${NBSP}procentenheter`;
}

/** Månadens namn: '2026-11' → "november 2026". */
export function monthText(month: IsoMonth): string {
  const { year, month: m } = parseIsoMonth(month);
  return `${MONTHS[m - 1]} ${year}`;
}

/** Bara månadens namn: '2026-11' → "november". */
export function monthNameText(month: IsoMonth): string {
  return MONTHS[parseIsoMonth(month).month - 1]!;
}

/** Datum: '2026-11-16' → "16 november 2026". */
export function dateText(date: IsoDate): string {
  const { year, month, day } = parseIsoDate(date);
  return `${day} ${MONTHS[month - 1]} ${year}`;
}

/** Kort datum utan år: '2026-11-16' → "16 nov.". */
export function shortDateText(date: IsoDate): string {
  const { month, day } = parseIsoDate(date);
  return `${day} ${MONTHS_SHORT[month - 1]}`;
}

/**
 * Period som text. Hel kalendermånad → "november 2026"; inom en månad → "1–15 nov. 2026";
 * över månadsskifte → "20 okt.–10 nov. 2026"; över årsskifte → "20 dec. 2025–10 jan. 2026";
 * en dag → "16 nov. 2026".
 */
export function periodText(period: Period): string {
  const s = parseIsoDate(period.start);
  const e = parseIsoDate(period.end);
  if (period.start === period.end) return `${shortDateText(period.start)} ${s.year}`;
  const lastDay = parseIsoDate(period.end).day;
  const isFullMonth =
    s.year === e.year &&
    s.month === e.month &&
    s.day === 1 &&
    lastDay === daysOf(e.year, e.month);
  if (isFullMonth) return `${MONTHS[s.month - 1]} ${s.year}`;
  if (s.year === e.year && s.month === e.month) {
    return `${s.day}–${e.day} ${MONTHS_SHORT[s.month - 1]} ${s.year}`;
  }
  if (s.year === e.year) {
    return `${shortDateText(period.start)}–${shortDateText(period.end)} ${s.year}`;
  }
  return `${shortDateText(period.start)} ${s.year}–${shortDateText(period.end)} ${e.year}`;
}

function daysOf(year: number, month: number): number {
  if (month === 2) return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** ISO-vecka som text: '2026-11-04' → "v. 45". */
export function weekText(date: IsoDate): string {
  return `v.${NBSP}${weekOf(date).week}`;
}

/** Antal med rätt böjning: (1, "dag", "dagar") → "1 dag", (3, …) → "3 dagar". */
export function countText(n: number, singular: string, plural: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? singular : plural}`;
}

/** Antal order (samma ord i singular och plural): 7 → "7 order". */
export function ordersText(n: number): string {
  return countText(n, "order", "order");
}

/** Lista som text: ["A"] → "A", ["A", "B", "C"] → "A, B och C". */
export function listText(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} och ${items[items.length - 1]}`;
}
