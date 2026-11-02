/**
 * Lokal tid i en namngiven tidszon ↔ UTC, byggt på Intl (inget externt
 * bibliotek). Resultatet beror aldrig på processens tidszon (TZ): all
 * aritmetik sker i UTC-millisekunder och Intl får alltid en uttrycklig zon.
 *
 * Sommartid:
 * - Dubbeltimme (t.ex. 25 okt. 2026 02:00–02:59 i Stockholm): klockslaget
 *   finns två gånger. Vi väljer den TIDIGASTE och rapporterar `ambiguous`,
 *   så att importen kan logga det.
 * - Glapp (t.ex. 29 mars 2026 02:00–02:59 i Stockholm): klockslaget finns
 *   inte. Vi flyttar fram det lika mycket som glappet (02:30 → 03:30, samma
 *   som Temporals "compatible") och rapporterar `gap`.
 * - Asia/Shanghai har ingen sommartid, så Awish-tider är alltid entydiga.
 */

export interface LocalDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond?: number;
}

export type ZonedResolution = "exact" | "ambiguous" | "gap";

export interface ZonedToUtcResult {
  utc: Date;
  resolution: ZonedResolution;
  /** Vid `ambiguous`: båda tänkbara tidpunkterna, tidigaste först. */
  candidates: Date[];
}

const DAY_MS = 86_400_000;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Sant om Intl känner till tidszonen (IANA-namn som "Asia/Shanghai"). */
export function isValidTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.trim() === "") {
    return false;
  }
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

export function assertTimeZone(timeZone: string): void {
  if (!isValidTimeZone(timeZone)) {
    throw new RangeError(`Okänd tidszon: ${timeZone}`);
  }
}

function utcMs(p: LocalDateTime): number {
  const d = new Date(0);
  d.setUTCFullYear(p.year, p.month - 1, p.day);
  d.setUTCHours(p.hour, p.minute, p.second, p.millisecond ?? 0);
  return d.getTime();
}

/** Väggklockan i `timeZone` vid tidpunkten `date`. */
export function utcToZoned(date: Date, timeZone: string): LocalDateTime {
  const ms = date.getTime();
  if (!Number.isFinite(ms)) {
    throw new RangeError("Ogiltig tidpunkt.");
  }
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((p) => p.type === type);
    if (!part) {
      throw new Error(`Intl saknar ${type}`);
    }
    return Number.parseInt(part.value, 10);
  };
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
    millisecond: ((ms % 1000) + 1000) % 1000,
  };
}

/** Zonens förskjutning mot UTC (ms) vid tidpunkten `ms`. */
function offsetAt(ms: number, timeZone: string): number {
  return utcMs(utcToZoned(new Date(ms), timeZone)) - ms;
}

/** Lokal tid i `timeZone` → UTC. Se filhuvudet för sommartidsreglerna. */
export function zonedToUtc(local: LocalDateTime, timeZone: string): ZonedToUtcResult {
  assertTimeZone(timeZone);
  const target = utcMs(local);
  const offsets = new Set([
    offsetAt(target - DAY_MS, timeZone),
    offsetAt(target, timeZone),
    offsetAt(target + DAY_MS, timeZone),
  ]);
  const candidates = [...new Set([...offsets].map((o) => target - o))]
    .filter((t) => utcMs(utcToZoned(new Date(t), timeZone)) === target)
    .sort((a, b) => a - b);

  const first = candidates[0];
  if (first !== undefined) {
    return {
      utc: new Date(first),
      resolution: candidates.length > 1 ? "ambiguous" : "exact",
      candidates: candidates.map((t) => new Date(t)),
    };
  }
  // Glapp: använd förskjutningen från före övergången (flyttar fram).
  const before = offsetAt(target - DAY_MS, timeZone);
  return { utc: new Date(target - before), resolution: "gap", candidates: [] };
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/** "YYYY-MM-DD" för en lokal tid. */
export function formatLocalDate(p: LocalDateTime): string {
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** "YYYY-MM-DD HH:mm:ss" för en lokal tid. */
export function formatLocalDateTime(p: LocalDateTime): string {
  return `${formatLocalDate(p)} ${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** Affärsdatum: datumet i `timeZone` (organisationens zon) för UTC-tiden. */
export function businessDateOf(date: Date, timeZone: string): string {
  return formatLocalDate(utcToZoned(date, timeZone));
}

/** "YYYY-MM-DD HH:mm:ss" i `timeZone` för UTC-tiden. */
export function formatInZone(date: Date, timeZone: string): string {
  return formatLocalDateTime(utcToZoned(date, timeZone));
}

function daysInMonth(year: number, month: number): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, 0);
  return d.getUTCDate();
}

export type ParsedSourceTime =
  | { ok: true; kind: "local"; local: LocalDateTime }
  | { ok: true; kind: "absolute"; utc: Date }
  | { ok: false; message: string };

const SOURCE_TIME =
  /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T]+(\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,3})\d*)?)?)\s*(Z|[+-]\d{2}:?\d{2})?$/i;

/**
 * Tolkar en tid från källan: "YYYY-MM-DD HH:mm:ss", "YYYY-MM-DD HH:mm",
 * "YYYY/MM/DD HH:mm(:ss)" och "YYYY-MM-DDTHH:mm:ss". Utan zonangivelse är det
 * lokal tid i källans tidszon (`kind: "local"`); med "Z" eller "+08:00" är
 * tidpunkten redan entydig (`kind: "absolute"`).
 */
export function parseSourceDateTime(input: string | null | undefined): ParsedSourceTime {
  const text = (input ?? "").trim();
  if (text === "") {
    return { ok: false, message: "Tid saknas." };
  }
  const m = SOURCE_TIME.exec(text);
  if (!m) {
    return {
      ok: false,
      message: `Kan inte tolka tiden "${text}" (väntade ÅÅÅÅ-MM-DD TT:MM:SS).`,
    };
  }
  const local: LocalDateTime = {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: m[6] === undefined ? 0 : Number(m[6]),
    millisecond: m[7] === undefined ? 0 : Number(m[7].padEnd(3, "0")),
  };
  if (local.year < 2000 || local.year > 2100) {
    return { ok: false, message: `Orimligt år i tiden "${text}".` };
  }
  if (
    local.month < 1 ||
    local.month > 12 ||
    local.day < 1 ||
    local.day > daysInMonth(local.year, local.month) ||
    local.hour > 23 ||
    local.minute > 59 ||
    local.second > 59
  ) {
    return { ok: false, message: `Ogiltigt datum eller klockslag i "${text}".` };
  }
  const zone = m[8];
  if (zone === undefined) {
    return { ok: true, kind: "local", local };
  }
  let offsetMinutes = 0;
  if (zone.toUpperCase() !== "Z") {
    const digits = zone.replace(":", "");
    const sign = digits.startsWith("-") ? -1 : 1;
    const hours = Number(digits.slice(1, 3));
    const minutes = Number(digits.slice(3, 5));
    if (hours > 14 || minutes > 59) {
      return { ok: false, message: `Ogiltig tidszonsangivelse i "${text}".` };
    }
    offsetMinutes = sign * (hours * 60 + minutes);
  }
  return { ok: true, kind: "absolute", utc: new Date(utcMs(local) - offsetMinutes * 60_000) };
}
