/**
 * Tidpunkter → affärsdatum och klockslag i organisationens tidszon.
 *
 * Tidszonen anges alltid uttryckligen till Intl, så resultatet beror aldrig på
 * processens tidszon (TZ). Tidpunkter utan tidszon ('2026-11-01T17:17') avvisas,
 * eftersom de annars skulle tolkas i processens lokala tid.
 */

import { DomainError, type IsoDate } from "@/domain";

/** Standardtidszon för affärsdatum. */
export const DEFAULT_TIME_ZONE = "Europe/Stockholm";

/** Millisekunder per timme. */
export const HOUR_MS = 3_600_000;

const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Tolkar en tidpunkt till millisekunder sedan 1970 (UTC).
 * Tar `Date`, millisekunder eller en ISO 8601-sträng MED tidszon (Z eller ±hh:mm).
 * Kastar `DomainError('invalid_input')` för strängar utan tidszon eller ogiltiga värden.
 */
export function parseInstant(value: Date | string | number): number {
  let ms: number;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === "number") ms = value;
  else if (typeof value === "string" && INSTANT_PATTERN.test(value)) ms = Date.parse(value);
  else ms = NaN;
  if (!Number.isFinite(ms)) {
    throw new DomainError(
      "invalid_input",
      `Ogiltig tidpunkt: ${JSON.stringify(value)}. Väntat ISO 8601 med tidszon, t.ex. 2026-11-01T16:17:00Z.`,
    );
  }
  return ms;
}

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    partsFormatters.set(timeZone, f);
  }
  return f;
}

/** Datum och klockslag för en tidpunkt i tidszonen. */
export function localParts(ms: number, timeZone: string = DEFAULT_TIME_ZONE) {
  const parts = partsFormatter(timeZone).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year").padStart(4, "0");
  const hour = get("hour") === "24" ? "00" : get("hour");
  return {
    date: `${year}-${get("month")}-${get("day")}` as IsoDate,
    time: `${hour}:${get("minute")}`,
  };
}

/**
 * Affärsdatum för en tidpunkt: kalenderdagen i organisationens tidszon.
 * businessDateAt('2026-11-01T23:30:00Z') → '2026-11-02' (00:30 svensk vintertid).
 */
export function businessDateAt(
  instant: Date | string | number,
  timeZone: string = DEFAULT_TIME_ZONE,
): IsoDate {
  return localParts(parseInstant(instant), timeZone).date;
}

/** Klockslag 'TT:MM' (24 h) för en tidpunkt i tidszonen. */
export function clockTimeAt(
  instant: Date | string | number,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  return localParts(parseInstant(instant), timeZone).time;
}
