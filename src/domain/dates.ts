/**
 * Datumhjälp för affärsdatum utan tidszon.
 *
 * Ett affärsdatum är en kalenderdag 'ÅÅÅÅ-MM-DD'. All aritmetik görs med heltal
 * (dagnummer sedan 1970-01-01 i den proleptiska gregorianska kalendern), aldrig
 * med `Date`. Därför påverkas resultatet varken av processens tidszon eller av
 * sommartid: ett dygn är alltid exakt en dag.
 *
 * Giltiga datum har år 0001–9999. Ogiltiga datum ("2026-02-30", "2026-1-5")
 * ger `DomainError("invalid_date")`.
 */

import { DomainError } from "./errors";
import type { IsoDate, IsoMonth, Period } from "./types";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_PATTERN = /^(\d{4})-(\d{2})$/;

/** År, månad (1–12) och dag (1–31). */
export interface DateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** ISO 8601-vecka. Veckan börjar på måndag; vecka 1 är veckan med årets första torsdag. */
export interface IsoWeek {
  /** ISO-veckoår (kan skilja sig från kalenderåret runt nyår). */
  readonly year: number;
  /** Veckonummer 1–53. */
  readonly week: number;
  /** Nyckel 'ÅÅÅÅ-Www', t.ex. '2026-W45'. */
  readonly key: string;
  /** Måndagen. */
  readonly start: IsoDate;
  /** Söndagen. */
  readonly end: IsoDate;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function pad4(n: number): string {
  return String(n).padStart(4, "0");
}

/** Skottår enligt den gregorianska kalendern (2024 ja, 2100 nej, 2000 ja). */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function monthLength(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Delar upp ett affärsdatum. Kastar `DomainError` om datumet inte finns. */
/**
 * Tolkade datum. Samma sträng ger alltid samma delar, och beräkningarna tolkar samma
 * datum många gånger (varje order kontrolleras i varje vy). Töms när den blir stor.
 */
const PARSED_DATES = new Map<string, DateParts>();
const PARSED_DATES_MAX = 20_000;

export function parseIsoDate(date: string): DateParts {
  const cached = typeof date === "string" ? PARSED_DATES.get(date) : undefined;
  if (cached) return cached;
  const m = typeof date === "string" ? DATE_PATTERN.exec(date) : null;
  if (!m) {
    throw new DomainError(
      "invalid_date",
      `Ogiltigt datum: ${JSON.stringify(date)}. Väntat format är ÅÅÅÅ-MM-DD.`,
    );
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > monthLength(year, month)) {
    throw new DomainError("invalid_date", `Datumet ${date} finns inte i kalendern.`);
  }
  const parts: DateParts = Object.freeze({ year, month, day });
  if (PARSED_DATES.size >= PARSED_DATES_MAX) PARSED_DATES.clear();
  PARSED_DATES.set(date, parts);
  return parts;
}

/** Sant om värdet är ett giltigt affärsdatum 'ÅÅÅÅ-MM-DD'. */
export function isIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  try {
    parseIsoDate(value);
    return true;
  } catch {
    return false;
  }
}

/** Kastar `DomainError` om värdet inte är ett giltigt affärsdatum. */
export function assertIsoDate(value: unknown, label = "datum"): asserts value is IsoDate {
  if (typeof value !== "string") {
    throw new DomainError("invalid_date", `${label} saknas eller är inte ett datum.`);
  }
  parseIsoDate(value);
}

/** Bygger 'ÅÅÅÅ-MM-DD' av år, månad och dag (kontrolleras). */
export function formatIsoDate(parts: DateParts): IsoDate {
  const s = `${pad4(parts.year)}-${pad2(parts.month)}-${pad2(parts.day)}`;
  parseIsoDate(s);
  return s;
}

// Algoritmen är Howard Hinnants "days_from_civil" / "civil_from_days": exakt
// heltalsaritmetik i 400-årscykler (146 097 dagar).
function daysFromCivil(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (month + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(dayNumber: number): DateParts {
  const z = dayNumber + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return { year, month, day };
}

const MIN_DAY_NUMBER = daysFromCivil(1, 1, 1);
const MAX_DAY_NUMBER = daysFromCivil(9999, 12, 31);

/** Dagnummer: antal dagar från 1970-01-01 (negativt före). 1970-01-02 → 1. */
export function toDayNumber(date: IsoDate): number {
  const p = parseIsoDate(date);
  return daysFromCivil(p.year, p.month, p.day);
}

/** Formaterade dagnummer (som PARSED_DATES, åt andra hållet). */
const FORMATTED_DAYS = new Map<number, IsoDate>();

/** Affärsdatum för ett dagnummer. 0 → '1970-01-01'. */

export function fromDayNumber(dayNumber: number): IsoDate {
  const cached = FORMATTED_DAYS.get(dayNumber);
  if (cached !== undefined) return cached;
  if (
    !Number.isSafeInteger(dayNumber) ||
    dayNumber < MIN_DAY_NUMBER ||
    dayNumber > MAX_DAY_NUMBER
  ) {
    throw new DomainError("invalid_date", `Dagnumret ${dayNumber} ligger utanför år 1–9999.`);
  }
  const p = civilFromDays(dayNumber);
  const date = `${pad4(p.year)}-${pad2(p.month)}-${pad2(p.day)}`;
  if (FORMATTED_DAYS.size >= PARSED_DATES_MAX) FORMATTED_DAYS.clear();
  FORMATTED_DAYS.set(dayNumber, date);
  return date;
}

/** Lägger till (eller drar ifrån, vid negativt tal) hela kalenderdagar. addDays('2026-02-28', 1) → '2026-03-01'. */
export function addDays(date: IsoDate, days: number): IsoDate {
  if (!Number.isSafeInteger(days)) {
    throw new DomainError("invalid_input", `Antal dagar måste vara ett heltal, fick ${days}.`);
  }
  return fromDayNumber(toDayNumber(date) + days);
}

/**
 * Antal dagar från `from` till `to` (to − from). Samma dag → 0, nästa dag → 1,
 * dagen före → −1. För antal dagar i en period med båda ändar, se `periodDays`.
 */
export function daysBetween(from: IsoDate, to: IsoDate): number {
  return toDayNumber(to) - toDayNumber(from);
}

/** Alla dagar från `start` till `end`, båda inräknade. Tom lista om `end` är före `start`. */
export function eachDay(start: IsoDate, end: IsoDate): IsoDate[] {
  const a = toDayNumber(start);
  const b = toDayNumber(end);
  const out: IsoDate[] = [];
  for (let n = a; n <= b; n++) out.push(fromDayNumber(n));
  return out;
}

/** Jämför två affärsdatum: −1, 0 eller 1. */
export function compareDates(a: IsoDate, b: IsoDate): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Det tidigaste av två datum. */
export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

/** Det senaste av två datum. */
export function maxDate(a: IsoDate, b: IsoDate): IsoDate {
  return a >= b ? a : b;
}

/** Veckodag enligt ISO: 1 = måndag … 7 = söndag. */
export function dayOfWeek(date: IsoDate): number {
  // 1970-01-01 var en torsdag (4).
  const n = toDayNumber(date);
  return ((((n + 3) % 7) + 7) % 7) + 1;
}

// ---------------------------------------------------------------------------
// Månader
// ---------------------------------------------------------------------------

/** Delar upp en månad 'ÅÅÅÅ-MM'. */
export function parseIsoMonth(month: string): { year: number; month: number } {
  const m = typeof month === "string" ? MONTH_PATTERN.exec(month) : null;
  const year = m ? Number(m[1]) : NaN;
  const mon = m ? Number(m[2]) : NaN;
  if (!m || year < 1 || mon < 1 || mon > 12) {
    throw new DomainError(
      "invalid_month",
      `Ogiltig månad: ${JSON.stringify(month)}. Väntat format är ÅÅÅÅ-MM.`,
    );
  }
  return { year, month: mon };
}

/** Månaden ett datum ligger i. monthOf('2026-11-02') → '2026-11'. */
export function monthOf(date: IsoDate): IsoMonth {
  parseIsoDate(date);
  return date.slice(0, 7);
}

/**
 * Antal dagar i månaden. Tar en månad ('2026-02') eller ett datum i månaden ('2026-02-14').
 * daysInMonth('2024-02') → 29, daysInMonth('2026-02') → 28.
 */
export function daysInMonth(monthOrDate: string): number {
  const month = monthOrDate.length === 10 ? monthOf(monthOrDate) : monthOrDate;
  const p = parseIsoMonth(month);
  return monthLength(p.year, p.month);
}

/** Första dagen i månaden. */
export function monthStart(month: IsoMonth): IsoDate {
  parseIsoMonth(month);
  return `${month}-01`;
}

/** Sista dagen i månaden. */
export function monthEnd(month: IsoMonth): IsoDate {
  return `${month}-${pad2(daysInMonth(month))}`;
}

/** Lägger till hela månader. addMonths('2026-11', 2) → '2027-01'. */
export function addMonths(month: IsoMonth, months: number): IsoMonth {
  if (!Number.isSafeInteger(months)) {
    throw new DomainError("invalid_input", `Antal månader måste vara ett heltal, fick ${months}.`);
  }
  const p = parseIsoMonth(month);
  const index = p.year * 12 + (p.month - 1) + months;
  const year = Math.floor(index / 12);
  const mon = index - year * 12 + 1;
  if (year < 1 || year > 9999) {
    throw new DomainError("invalid_month", `Månaden hamnar utanför år 1–9999.`);
  }
  return `${pad4(year)}-${pad2(mon)}`;
}

/** Alla månader som perioden `start`–`end` berör, i ordning. */
export function eachMonth(start: IsoDate, end: IsoDate): IsoMonth[] {
  const first = monthOf(start);
  const last = monthOf(end);
  const out: IsoMonth[] = [];
  if (end < start) return out;
  for (let m = first; m <= last; m = addMonths(m, 1)) out.push(m);
  return out;
}

/**
 * Hela månader från `from` till `to`. En månad har gått när samma dagnummer
 * nåtts (eller månadens sista dag, om månaden är kortare):
 * 2026-01-15 → 2026-02-14 = 0, → 2026-02-15 = 1; 2026-01-31 → 2026-02-28 = 1.
 * Negativt om `to` är före `from`.
 */
export function monthsElapsed(from: IsoDate, to: IsoDate): number {
  if (to < from) return -monthsElapsed(to, from);
  const a = parseIsoDate(from);
  const b = parseIsoDate(to);
  let months = (b.year - a.year) * 12 + (b.month - a.month);
  const anchorDay = Math.min(a.day, monthLength(b.year, b.month));
  if (b.day < anchorDay) months -= 1;
  return months;
}

// ---------------------------------------------------------------------------
// Veckor
// ---------------------------------------------------------------------------

/** ISO-veckan som datumet ligger i. weekOf('2027-01-01') → 2026-W53. */
export function weekOf(date: IsoDate): IsoWeek {
  const n = toDayNumber(date);
  const dow = ((((n + 3) % 7) + 7) % 7) + 1;
  const monday = n - (dow - 1);
  const thursday = monday + 3;
  const year = civilFromDays(thursday).year;
  const week = Math.floor((thursday - daysFromCivil(year, 1, 1)) / 7) + 1;
  return {
    year,
    week,
    key: `${pad4(year)}-W${pad2(week)}`,
    start: fromDayNumber(monday),
    end: fromDayNumber(monday + 6),
  };
}

/**
 * ISO 8601-beteckning för veckan, 'ÅÅÅÅ-Www' (t.ex. '2026-W45'). Används som nyckel
 * vid gruppering per vecka; i gränssnittet visas den som "v. 45".
 */
export function isoWeekLabel(date: IsoDate): string {
  return weekOf(date).key;
}

/** Måndagen i veckan. */
export function weekStart(date: IsoDate): IsoDate {
  return weekOf(date).start;
}

// ---------------------------------------------------------------------------
// Perioder
// ---------------------------------------------------------------------------

/** Kontrollerar att perioden har giltiga datum och att start ≤ slut. */
export function assertPeriod(period: Period): void {
  if (!period || typeof period !== "object") {
    throw new DomainError("invalid_period", "Period saknas.");
  }
  assertIsoDate(period.start, "Periodens start");
  assertIsoDate(period.end, "Periodens slut");
  if (period.end < period.start) {
    throw new DomainError(
      "invalid_period",
      `Perioden slutar (${period.end}) före den börjar (${period.start}).`,
    );
  }
}

/** Antal dagar i perioden, båda ändar inräknade. 1–30 nov → 30. */
export function periodDays(period: Period): number {
  return daysBetween(period.start, period.end) + 1;
}

/** Sant om datumet ligger i perioden (inklusive ändarna). */
export function inPeriod(date: IsoDate, period: Period): boolean {
  return date >= period.start && date <= period.end;
}

/** Den gemensamma delen av två perioder, eller `null` om de inte överlappar. */
export function intersectPeriods(a: Period, b: Period): Period | null {
  const start = maxDate(a.start, b.start);
  const end = minDate(a.end, b.end);
  return start <= end ? { start, end } : null;
}

/** Antal gemensamma dagar för två perioder (0 om de inte överlappar). */
export function overlapDays(a: Period, b: Period): number {
  const p = intersectPeriods(a, b);
  return p ? periodDays(p) : 0;
}

/** Hela kalendermånaden som period. monthPeriod('2026-02') → 1–28 feb. */
export function monthPeriod(month: IsoMonth): Period {
  return { start: monthStart(month), end: monthEnd(month) };
}

/**
 * Lika lång period som slutar dagen före `period` börjar (för "mot föregående period").
 * 1–30 nov → 2–31 okt. En hel kalendermånad ger i stället hela föregående månad
 * (1–31 okt → 1–30 sep), så att månad jämförs med månad.
 */
export function previousPeriod(period: Period): Period {
  assertPeriod(period);
  const month = period.start.slice(0, 7);
  if (period.start === monthStart(month) && period.end === monthEnd(month)) {
    return monthPeriod(addMonths(month, -1));
  }
  const days = periodDays(period);
  const end = addDays(period.start, -1);
  return { start: addDays(end, -(days - 1)), end };
}
