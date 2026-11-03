/**
 * Periodvalet i URL:en (?period=, ?from=&to=, ?butik=, ?automat=) som affärsdatum.
 *
 * Ren funktion, utan databas: tolkningen görs av skalets parsePeriod/parseScope, så att
 * servern och klienten alltid visar samma period. Här översätts den till @/domain-
 * perioder ('ÅÅÅÅ-MM-DD') och "Allt" får sin start (första dagen med data).
 */

import {
  parsePeriod,
  parseScope,
  toIsoDate,
  type SearchParamsInput,
} from "@/components/shell/period-state";
import { addDays as addIsoDays, isIsoDate, periodDays, type IsoDate, type Period } from "@/domain";

import type { AppPeriod, DataScope } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value: string | null): value is string {
  return value !== null && UUID.test(value);
}

/** "2026-10-13" → lokal midnatt (Date), som skalets perioder. */
function localMidnight(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Filtret ur URL:en. Värden som inte är uuid ignoreras (null). */
export function scopeFromSearchParams(sp: SearchParamsInput): DataScope {
  const raw = parseScope(sp);
  return {
    storeId: isUuid(raw.butik) ? raw.butik.toLowerCase() : null,
    machineId: isUuid(raw.automat) ? raw.automat.toLowerCase() : null,
  };
}

export interface ResolveAppPeriodOptions {
  /** Organisationens tidszon. */
  readonly timeZone: string;
  /** Första dagen med data, för "Allt". */
  readonly dataStart: IsoDate | null;
  /** Nu. Standard new Date(). */
  readonly now?: Date;
}

/**
 * Perioden, jämförelsen och filtret ur search params. "Allt" går från första dagen med
 * data till i dag; utan data blir det bara i dag. Ett eget intervall före första dagen
 * med data kapas inte (sidan visar då tomma dagar, vilket är sant).
 */
export function resolveAppPeriod(
  sp: SearchParamsInput,
  options: ResolveAppPeriodOptions,
): AppPeriod {
  const dataStart = options.dataStart && isIsoDate(options.dataStart) ? options.dataStart : null;
  const resolved = parsePeriod(sp, {
    now: options.now,
    timeZone: options.timeZone,
    earliest: dataStart ? localMidnight(dataStart) : undefined,
  });
  const today = toIsoDate(resolved.today);
  const period: Period = resolved.range
    ? { start: toIsoDate(resolved.range.start), end: toIsoDate(resolved.range.end) }
    : { start: today, end: today };
  const compare: Period | null = resolved.previous
    ? { start: toIsoDate(resolved.previous.start), end: toIsoDate(resolved.previous.end) }
    : null;
  return {
    key: resolved.key,
    period,
    compare,
    days: periodDays(period),
    dataStart,
    scope: scopeFromSearchParams(sp),
    resolved,
  };
}

/** Datumet som Date mitt på dagen, så att det blir samma kalenderdag i alla tidszoner (skalets `earliest`). */
export function isoDateToShellDate(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

/**
 * Dagarna med data i perioden, samma regel på alla sidor: från organisationens första
 * order och, när perioden slutar i dag utan någon order i dag, bara till och med i går.
 * null om inga dagar återstår. Rubrikernas antal dagar och snitten per dag räknas på
 * dessa dagar; beloppen gäller hela perioden.
 */
export function dataCoverage(
  period: Period,
  dataStart: IsoDate | null,
  today: IsoDate,
  hasOrdersToday: boolean,
): Period | null {
  if (dataStart === null) return null;
  const start = period.start > dataStart ? period.start : dataStart;
  let end = period.end;
  if (end >= today && !hasOrdersToday) {
    const yesterday = addIsoDays(today, -1);
    if (yesterday < end) end = yesterday;
  }
  return start <= end ? { start, end } : null;
}

/** Antal dagar med data (dataCoverage); 0 utan data. */
export function coverageDays(
  period: Period,
  dataStart: IsoDate | null,
  today: IsoDate,
  hasOrdersToday: boolean,
): number {
  const c = dataCoverage(period, dataStart, today, hasOrdersToday);
  return c ? periodDays(c) : 0;
}
