/**
 * Globalt periodval och filter, lagrade i URL:en.
 *
 *   ?period=idag | 7d | 30d | manad | allt
 *   ?from=2026-10-13&to=2026-11-01           (eget intervall, båda ändar ingår)
 *   ?butik=<id>&automat=<id>                 (globalt filter)
 *
 * Allt här är rena funktioner utan React, så att samma tolkning används i
 * Server Components (parsePeriod(await searchParams)) och i klienten
 * (usePeriod i ./use-period). Datum är kalenderdagar vid lokal midnatt,
 * samma konvention som src/lib/period.ts.
 */
import {
  addDays,
  calendarDaysBetween,
  daysInPeriod,
  endOfMonth,
  normalizePeriod,
  previousPeriod,
  startOfMonth,
  type Period as DateRange,
} from "@/lib/period";
import { formatPeriodShort } from "@/lib/format";

export type { DateRange };

export type PeriodKey = "idag" | "7d" | "30d" | "manad" | "allt" | "eget";

export const DEFAULT_PERIOD: Exclude<PeriodKey, "eget"> = "30d";

/** Tidszonen som avgör vad "i dag" är. Kalenderdagar räknas i bolagets tid, inte serverns. */
export const DEFAULT_TIME_ZONE = "Europe/Stockholm";

export const PERIOD_PARAM = "period";
export const FROM_PARAM = "from";
export const TO_PARAM = "to";
export const STORE_PARAM = "butik";
export const MACHINE_PARAM = "automat";

/** Parametrar som skalet äger och som följer med när man byter sida. */
export const SHELL_PARAMS = [
  PERIOD_PARAM,
  FROM_PARAM,
  TO_PARAM,
  STORE_PARAM,
  MACHINE_PARAM,
] as const;

export const periodChoices: ReadonlyArray<{ key: PeriodKey; label: string; short: string }> = [
  { key: "idag", label: "I dag", short: "I dag" },
  { key: "7d", label: "7 dagar", short: "7 d" },
  { key: "30d", label: "30 dagar", short: "30 d" },
  { key: "manad", label: "Denna månad", short: "Mån" },
  { key: "allt", label: "Allt", short: "Allt" },
  { key: "eget", label: "Eget intervall", short: "Eget" },
];

const PRESET_KEYS = new Set<string>(["idag", "7d", "30d", "manad", "allt"]);

export type ResolvedPeriod = {
  key: PeriodKey;
  /** null för "allt" när ingen startpunkt för data är känd. */
  range: DateRange | null;
  /** Jämförelseperioden. null för "allt". */
  previous: DateRange | null;
  /** Dagens datum som användes (lokal midnatt). */
  today: Date;
};

export type SearchParamsInput =
  | URLSearchParams
  | { get(name: string): string | null }
  | Record<string, string | string[] | undefined>;

export type ParseOptions = {
  /** Nu. Standard new Date(). */
  now?: Date;
  /** Tidszon för "i dag". Standard Europe/Stockholm. */
  timeZone?: string;
  /** Första dagen med data. Ger "allt" ett faktiskt intervall. */
  earliest?: Date;
};

/* ------------------------------------------------------------------ */
/* Hjälpare                                                            */
/* ------------------------------------------------------------------ */

function readParam(sp: SearchParamsInput, name: string): string | null {
  if (typeof (sp as URLSearchParams).get === "function") {
    return (sp as { get(name: string): string | null }).get(name);
  }
  const v = (sp as Record<string, string | string[] | undefined>)[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

/** Kalenderdagen `now` i given tidszon, som lokal midnatt. */
export function todayIn(now: Date, timeZone: string = DEFAULT_TIME_ZONE): Date {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return new Date(get("year"), get("month") - 1, get("day"));
  } catch {
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
  }
}

/**
 * Väggklockan i en tidszon som lokalt Date-objekt (för formatering med
 * src/lib/format), så att server och klient visar samma klockslag.
 */
export function wallClockIn(d: Date, timeZone: string = DEFAULT_TIME_ZONE): Date {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(d);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return new Date(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  } catch {
    return d;
  }
}

/** "2026-10-13" → lokal midnatt. Ogiltigt (även 2026-02-30) → null. */
export function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return date;
}

/** Lokal midnatt → "2026-10-13". */
export function toIsoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* Tolkning                                                            */
/* ------------------------------------------------------------------ */

/**
 * Tolkar periodvalet ur search params. Tål skräp: okända värden, ogiltiga
 * datum och omvända intervall ger aldrig ett fel, utan standardperioden
 * respektive ett rättvänt intervall. Ett eget intervall som går in i
 * framtiden kapas vid i dag.
 *
 * Jämförelse:
 * - idag, 7d, 30d, eget: lika lång period direkt före.
 * - manad (månaden hittills): samma dagar i föregående månad, så att
 *   1–2 nov jämförs med 1–2 okt och inte med 30–31 okt.
 * - allt: ingen jämförelse.
 */
export function parsePeriod(sp: SearchParamsInput, options: ParseOptions = {}): ResolvedPeriod {
  const today = todayIn(options.now ?? new Date(), options.timeZone);
  const raw = readParam(sp, PERIOD_PARAM);
  const from = parseIsoDate(readParam(sp, FROM_PARAM));
  const to = parseIsoDate(readParam(sp, TO_PARAM));

  // Ett eget intervall gäller när from finns och period saknas eller är "eget".
  if (from && (raw === null || raw === "eget")) {
    const custom = normalizePeriod({ start: from, end: to ?? today });
    if (custom.start.getTime() <= today.getTime()) {
      const range = { start: custom.start, end: custom.end > today ? today : custom.end };
      return { key: "eget", range, previous: previousPeriod(range), today };
    }
  }

  const key = raw && PRESET_KEYS.has(raw) ? (raw as Exclude<PeriodKey, "eget">) : DEFAULT_PERIOD;
  return resolvePreset(key, today, options.earliest);
}

export function resolvePreset(
  key: Exclude<PeriodKey, "eget">,
  today: Date,
  earliest?: Date,
): ResolvedPeriod {
  switch (key) {
    case "idag": {
      const range = { start: today, end: today };
      return { key, range, previous: previousPeriod(range), today };
    }
    case "7d":
    case "30d": {
      const n = key === "7d" ? 7 : 30;
      const range = { start: addDays(today, -(n - 1)), end: today };
      return { key, range, previous: previousPeriod(range), today };
    }
    case "manad": {
      const range = { start: startOfMonth(today), end: today };
      const prevStart = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const prevMonthEnd = endOfMonth(prevStart);
      const sameDay = new Date(prevStart.getFullYear(), prevStart.getMonth(), today.getDate());
      // 31 mar → 28/29 feb: kapa vid månadens slut.
      const prevEnd = sameDay.getMonth() !== prevStart.getMonth() ? prevMonthEnd : sameDay;
      return { key, range, previous: { start: prevStart, end: prevEnd }, today };
    }
    case "allt": {
      const start = earliest ? startOfDayLocal(earliest) : null;
      const range = start && start <= today ? { start, end: today } : null;
      return { key, range, previous: null, today };
    }
  }
}

function startOfDayLocal(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/* ------------------------------------------------------------------ */
/* Skrivning                                                           */
/* ------------------------------------------------------------------ */

export type PeriodSelection =
  { key: Exclude<PeriodKey, "eget"> } | { key: "eget"; range: DateRange };

/**
 * Ny query med periodvalet satt. Övriga parametrar (filter, sidans egna)
 * lämnas orörda. Förval skrivs alltid ut, även standardvalet, så att en
 * delad länk visar samma vy även om standarden ändras senare.
 */
export function withPeriod(
  current: SearchParamsInput,
  selection: PeriodSelection,
): URLSearchParams {
  const next = toURLSearchParams(current);
  next.delete(PERIOD_PARAM);
  next.delete(FROM_PARAM);
  next.delete(TO_PARAM);
  if (selection.key === "eget") {
    const r = normalizePeriod(selection.range);
    next.set(FROM_PARAM, toIsoDate(r.start));
    next.set(TO_PARAM, toIsoDate(r.end));
  } else {
    next.set(PERIOD_PARAM, selection.key);
  }
  return next;
}

export type Scope = { butik: string | null; automat: string | null };

export function parseScope(sp: SearchParamsInput): Scope {
  const clean = (v: string | null) => (v && v.trim() ? v.trim() : null);
  return { butik: clean(readParam(sp, STORE_PARAM)), automat: clean(readParam(sp, MACHINE_PARAM)) };
}

/** Ny query med filtret satt; null tar bort parametern. */
export function withScope(current: SearchParamsInput, scope: Partial<Scope>): URLSearchParams {
  const next = toURLSearchParams(current);
  for (const [param, value] of [
    [STORE_PARAM, scope.butik],
    [MACHINE_PARAM, scope.automat],
  ] as const) {
    if (value === undefined) continue;
    if (value === null || value === "") next.delete(param);
    else next.set(param, value);
  }
  return next;
}

/** Bara skalets parametrar, för att bära period och filter mellan sidor. */
export function carriedQuery(current: SearchParamsInput): string {
  const src = toURLSearchParams(current);
  const out = new URLSearchParams();
  for (const p of SHELL_PARAMS) {
    const v = src.get(p);
    if (v) out.set(p, v);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

export function toURLSearchParams(sp: SearchParamsInput): URLSearchParams {
  if (sp instanceof URLSearchParams) return new URLSearchParams(sp);
  if (typeof (sp as URLSearchParams).get === "function") {
    return new URLSearchParams((sp as { toString(): string }).toString());
  }
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(sp as Record<string, string | string[] | undefined>)) {
    if (Array.isArray(v)) v.forEach((x) => out.append(k, x));
    else if (v !== undefined) out.set(k, v);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Beskrivning                                                         */
/* ------------------------------------------------------------------ */

export type PeriodDescription = {
  /** "4 okt. – 2 nov." eller "All data" */
  rangeLabel: string;
  /** "3 sep. – 3 okt." eller null */
  comparisonLabel: string | null;
  /** Antal dagar i perioden, null för "allt" utan startpunkt. */
  days: number | null;
};

/** Texter till mono-raden i toppbaren och till rubriker. */
export function describePeriod(p: ResolvedPeriod): PeriodDescription {
  return {
    rangeLabel: p.range ? formatPeriodShort(p.range, p.today) : "All data",
    comparisonLabel: p.previous ? formatPeriodShort(p.previous, p.today) : null,
    days: p.range ? daysInPeriod(p.range) : null,
  };
}

/** Antal dagar mellan två datum inklusive båda ändar, oavsett ordning. */
export function inclusiveDays(a: Date, b: Date): number {
  return Math.abs(calendarDaysBetween(a, b)) + 1;
}
