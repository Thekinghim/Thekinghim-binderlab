/**
 * Globalt periodval och filter, lagrade i URL:en.
 *
 *   ?period=idag | igar | 7d | 30d | manad | forra-manaden | allt
 *   ?from=2026-10-13&to=2026-11-01           (eget intervall, båda ändar ingår; högst två år)
 *   ?fran=2026-10-13&till=2026-11-01         (samma sak med svenska namn; läses bara när
 *                                             värdet är ett datum, skrivs aldrig: ?fran=hem
 *                                             är Fyll på:s retur och Rapporter har egna)
 *   ?butik=<id>&automat=<id>                 (globalt filter)
 *   ?agare=<id>                              (butiksägare: alla ägarens butiker tillsammans)
 *   ?vmb=1                                   (vyknappen "Med VMB": vinst efter VMB-moms)
 *   ?andel=1                                 (vyknappen "Visa butikernas andel")
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
  isSameDay,
  normalizePeriod,
  previousPeriod,
  startOfMonth,
  type Period as DateRange,
} from "@/lib/period";
import { formatPeriodShort } from "@/lib/format";

export type { DateRange };

export type PeriodKey =
  "idag" | "igar" | "7d" | "30d" | "manad" | "forra-manaden" | "allt" | "eget";

export const DEFAULT_PERIOD: Exclude<PeriodKey, "eget"> = "30d";

/** Tidszonen som avgör vad "i dag" är. Kalenderdagar räknas i bolagets tid, inte serverns. */
export const DEFAULT_TIME_ZONE = "Europe/Stockholm";

export const PERIOD_PARAM = "period";
export const FROM_PARAM = "from";
export const TO_PARAM = "to";
/** Svenska namn för ett eget intervall (?fran=&till=). Läses som from/to, skrivs aldrig. */
export const FROM_ALIAS = "fran";
export const TO_ALIAS = "till";
/** Längsta egna intervall (dagar, båda ändar inräknade): två år. Längre ger standardvalet. */
export const MAX_RANGE_DAYS = 731;
/**
 * Kakan där periodväljaren sparar senaste valet ("period=igar" eller "from=…&to=…"), så att
 * valet följer med till nästa periodsida även när länken saknar ?period (proxyn lägger på det).
 */
export const PERIOD_COOKIE = "binderlab-period";
/** Hur länge valet sparas: en arbetsdag. Nästa morgon börjar man på standardvalet igen. */
export const PERIOD_COOKIE_MAX_AGE = 60 * 60 * 12;
export const STORE_PARAM = "butik";
export const MACHINE_PARAM = "automat";
/**
 * Butiksägaren (store_owners): filtret gäller alla butiker med den ägaren tillsammans, med
 * samma regler som en vald butik (butikens andel dras). En vald butik vinner över ägaren.
 */
export const OWNER_PARAM = "agare";
export const VMB_PARAM = "vmb";
/**
 * Vyknappen "Visa butikernas andel" (?andel=1, av = ?andel=0). Av (standard): vår vinst och
 * marginal före butikernas andel. På: andelen dras per butik och avtal (vår del).
 */
export const STORE_SHARE_PARAM = "andel";
/**
 * Kakan där knappen sparar valet ("1" = på), så att det gäller på alla sidor även när en
 * länk saknar ?andel. Läses av proxyn (src/proxy.ts), som sätter STORE_SHARE_HEADER.
 */
export const STORE_SHARE_COOKIE = "binderlab-andel";
/**
 * Förfrågans header som proxyn sätter från ?andel eller kakan, så att serverns laddare
 * (requestStoreShareView) drar butikernas andel likadant på hela sidan.
 */
export const STORE_SHARE_HEADER = "x-binderlab-andel";

/**
 * Förfrågans header som proxyn (src/proxy.ts) sätter från ?vmb=1, så att serverns laddare
 * räknar vinsten efter VMB-moms utan att varje sida skickar valet vidare.
 */
export const VMB_HEADER = "x-binderlab-vmb";

/** Parametrar som skalet äger och som följer med när man byter sida. */
export const SHELL_PARAMS = [
  PERIOD_PARAM,
  FROM_PARAM,
  TO_PARAM,
  STORE_PARAM,
  OWNER_PARAM,
  MACHINE_PARAM,
  VMB_PARAM,
  STORE_SHARE_PARAM,
] as const;

/**
 * Parametrarna som bär periodvalet (förval eller eget intervall). ?fran/?till räknas bara
 * när värdet är ett datum (isoAlias): samma namn används av Fyll på (?fran=hem) och av
 * Rapporters egna datum, som aldrig skrivs om.
 */
export const PERIOD_PARAMS = [PERIOD_PARAM, FROM_PARAM, TO_PARAM, FROM_ALIAS, TO_ALIAS] as const;

export const periodChoices: ReadonlyArray<{ key: PeriodKey; label: string; short: string }> = [
  { key: "idag", label: "I dag", short: "I dag" },
  { key: "igar", label: "I går", short: "I går" },
  { key: "7d", label: "7 dagar", short: "7 d" },
  { key: "30d", label: "30 dagar", short: "30 d" },
  { key: "manad", label: "Denna månad", short: "Månad" },
  { key: "forra-manaden", label: "Förra månaden", short: "Förra mån." },
  { key: "allt", label: "Allt", short: "Allt" },
  { key: "eget", label: "Eget intervall", short: "Eget" },
];

const PRESET_KEYS = new Set<string>([
  "idag",
  "igar",
  "7d",
  "30d",
  "manad",
  "forra-manaden",
  "allt",
]);

/** Förvalen (allt utom "eget"). */
export type PresetKey = Exclude<PeriodKey, "eget">;

export function isPresetKey(value: string | null | undefined): value is PresetKey {
  return typeof value === "string" && PRESET_KEYS.has(value);
}

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
 * - idag, igar, 7d, 30d, eget: lika lång period direkt före (i går mot dagen innan).
 * - manad (månaden hittills): samma dagar i föregående månad, så att
 *   1–2 nov jämförs med 1–2 okt och inte med 30–31 okt.
 * - forra-manaden: hela månaden innan (oktober mot september).
 * - allt: ingen jämförelse.
 *
 * Ett eget intervall längre än två år (MAX_RANGE_DAYS) eller som börjar i framtiden ger
 * standardvalet.
 */
export function parsePeriod(sp: SearchParamsInput, options: ParseOptions = {}): ResolvedPeriod {
  const today = todayIn(options.now ?? new Date(), options.timeZone);
  const raw = readParam(sp, PERIOD_PARAM);
  const custom = raw === null || raw === "eget" ? customRange(sp, today) : null;
  if (custom) {
    // Ett eget intervall på en dag som är i dag eller i går är förvalet (samma jämförelse:
    // i dag jämförs inte som en halv dag mot hela i går).
    if (isSameDay(custom.start, custom.end)) {
      if (isSameDay(custom.start, today)) return resolvePreset("idag", today);
      if (isSameDay(custom.start, addDays(today, -1))) return resolvePreset("igar", today);
    }
    return { key: "eget", range: custom, previous: previousPeriod(custom), today };
  }
  const key = isPresetKey(raw) ? raw : DEFAULT_PERIOD;
  return resolvePreset(key, today, options.earliest);
}

/** ?fran/?till räknas bara när värdet ser ut som ett datum (inte ?fran=hem). */
function isoAlias(sp: SearchParamsInput, name: string): string | null {
  const v = readParam(sp, name);
  return v !== null && /^\s*\d{4}-\d{2}-\d{2}\s*$/.test(v) ? v : null;
}

function rawFrom(sp: SearchParamsInput): string | null {
  const v = readParam(sp, FROM_PARAM);
  return v !== null && v !== "" ? v : isoAlias(sp, FROM_ALIAS);
}

function rawTo(sp: SearchParamsInput): string | null {
  const v = readParam(sp, TO_PARAM);
  return v !== null && v !== "" ? v : isoAlias(sp, TO_ALIAS);
}

/**
 * Det egna intervallet, eller null (standardvalet gäller): saknat eller ogiltigt från-datum,
 * ett till-datum som finns men inte är ett datum, en start i framtiden eller längre än två år.
 * Saknas till gäller i dag; ett slut i framtiden kapas vid i dag.
 */
function customRange(sp: SearchParamsInput, today: Date): DateRange | null {
  const fromRaw = rawFrom(sp);
  if (fromRaw === null) return null;
  const from = parseIsoDate(fromRaw);
  if (!from) return null;
  const toRaw = rawTo(sp);
  // Bara en start i framtiden (inget slut): ingen period, inte "i dag".
  if (toRaw === null && from.getTime() > today.getTime()) return null;
  const to = toRaw === null ? today : parseIsoDate(toRaw);
  if (!to) return null;
  const r = normalizePeriod({ start: from, end: to });
  if (r.start.getTime() > today.getTime()) return null;
  const range = { start: r.start, end: r.end > today ? today : r.end };
  return daysInPeriod(range) <= MAX_RANGE_DAYS ? range : null;
}

export function resolvePreset(key: PresetKey, today: Date, earliest?: Date): ResolvedPeriod {
  switch (key) {
    case "idag": {
      const range = { start: today, end: today };
      return { key, range, previous: previousPeriod(range), today };
    }
    case "igar": {
      const day = addDays(today, -1);
      const range = { start: day, end: day };
      return { key, range, previous: previousPeriod(range), today };
    }
    case "forra-manaden": {
      const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
      const range = { start, end: endOfMonth(start) };
      const prevStart = new Date(start.getFullYear(), start.getMonth() - 1, 1);
      return { key, range, previous: { start: prevStart, end: endOfMonth(prevStart) }, today };
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

export type PeriodSelection = { key: PresetKey } | { key: "eget"; range: DateRange };

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
  for (const p of PERIOD_PARAMS) next.delete(p);
  if (selection.key === "eget") {
    const r = normalizePeriod(selection.range);
    next.set(FROM_PARAM, toIsoDate(r.start));
    next.set(TO_PARAM, toIsoDate(r.end));
  } else {
    next.set(PERIOD_PARAM, selection.key);
  }
  return next;
}

/** Filtret: en butik, en butiksägare (alla dess butiker) eller ingen, och en automat. */
export type Scope = { butik: string | null; agare: string | null; automat: string | null };

/** Filtret ur URL:en. En vald butik vinner över en ägare (ägaren räknas då inte). */
export function parseScope(sp: SearchParamsInput): Scope {
  const clean = (v: string | null) => (v && v.trim() ? v.trim() : null);
  const butik = clean(readParam(sp, STORE_PARAM));
  return {
    butik,
    agare: butik ? null : clean(readParam(sp, OWNER_PARAM)),
    automat: clean(readParam(sp, MACHINE_PARAM)),
  };
}

/**
 * Ny query med filtret satt; null tar bort parametern. Butik och ägare är ett val: anges
 * butiken (eller tas den bort) utan ägare, tas ägaren också bort.
 */
export function withScope(current: SearchParamsInput, scope: Partial<Scope>): URLSearchParams {
  const next = toURLSearchParams(current);
  if (scope.butik !== undefined && scope.agare === undefined) next.delete(OWNER_PARAM);
  for (const [param, value] of [
    [STORE_PARAM, scope.butik],
    [OWNER_PARAM, scope.agare],
    [MACHINE_PARAM, scope.automat],
  ] as const) {
    if (value === undefined) continue;
    if (value === null || value === "") next.delete(param);
    else next.set(param, value);
  }
  return next;
}

/**
 * Vyknappen "Med VMB" (?vmb=1). Standard av: omsättning och vinst före VMB-moms. Bokföringen
 * följer sin egen knapp "VMB i bokföringen" (standard av), oberoende av vyknappen.
 */
export function parseVmbView(sp: SearchParamsInput): boolean {
  return readParam(sp, VMB_PARAM) === "1";
}

/** Ny query med vyknappen satt (på = ?vmb=1, av = parametern tas bort). */
export function withVmbView(current: SearchParamsInput, on: boolean): URLSearchParams {
  const next = toURLSearchParams(current);
  if (on) next.set(VMB_PARAM, "1");
  else next.delete(VMB_PARAM);
  return next;
}

/**
 * Vyknappen "Visa butikernas andel" ur URL:en: true (?andel=1), false (?andel=0) eller null
 * (ingen parameter: kakan avgör, storeShareViewOf).
 */
export function readStoreShareParam(sp: SearchParamsInput): boolean | null {
  const v = readParam(sp, STORE_SHARE_PARAM);
  return v === "1" ? true : v === "0" ? false : null;
}

/** Sant med ?andel=1 (bara URL:en; serverns val, med kakan, är storeShareViewOf). */
export function parseStoreShareView(sp: SearchParamsInput): boolean {
  return readStoreShareParam(sp) === true;
}

/**
 * Vyknappens läge för en förfrågan: ?andel=1/0 i URL:en, annars kakan som knappen sparar.
 * Av (standard): vår vinst och marginal FÖRE butikernas andel. På: andelen dras (vår del).
 * En vald butik drar dessutom alltid sin egen andel (loadDomainInputFor), oavsett knappen.
 */
export function storeShareViewOf(sp: SearchParamsInput, cookieValue: string | undefined): boolean {
  return readStoreShareParam(sp) ?? cookieValue === "1";
}

/** Kort förklaring bredvid knappen: vad vår vinst räknas som i läget. */
export function storeShareHint(on: boolean): string {
  return on ? "Vinsten är efter butikernas del" : "Vinsten är före butikernas del";
}

/**
 * Ny query med vyknappen satt (på = ?andel=1, av = parametern tas bort). Knappen sparar
 * samtidigt valet i kakan (STORE_SHARE_COOKIE), så att det följer med till alla sidor.
 */
export function withStoreShareView(current: SearchParamsInput, on: boolean): URLSearchParams {
  const next = toURLSearchParams(current);
  if (on) next.set(STORE_SHARE_PARAM, "1");
  else next.delete(STORE_SHARE_PARAM);
  return next;
}

/**
 * Om butikernas andel ska dras och visas som eget tal: med vyknappen (`toggleOn`, serverns
 * val ur URL eller kaka), eller när en butik är vald (då gäller just den butikens andel
 * enligt dess avtal). Samma regel som loadDomainInputFor (`Settings.deductStoreShare`).
 */
export function showStoreShare(sp: SearchParamsInput, toggleOn = parseStoreShareView(sp)): boolean {
  if (toggleOn) return true;
  // Skalet lägger till automatens butik vid automatfilter: det är inget val av butik.
  // En butiksägare räknas som ett val av butik (alla ägarens butiker).
  const scope = parseScope(sp);
  return Boolean(scope.butik || scope.agare) && !scope.automat;
}

/** Bara skalets parametrar, för att bära period och filter mellan sidor. */
export function carriedQuery(current: SearchParamsInput): string {
  const src = toURLSearchParams(current);
  // Periodvalet som appen skriver det (?fran/?till med datum blir ?from/?to), sedan filtren.
  const out = new URLSearchParams(periodQuery(src).replace(/^\?/, ""));
  for (const p of SHELL_PARAMS) {
    if (p === PERIOD_PARAM || p === FROM_PARAM || p === TO_PARAM) continue;
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

/* ------------------------------------------------------------------ */
/* Namn, jämförelse och upplösning (samma på alla sidor)               */
/* ------------------------------------------------------------------ */

/** Bara periodvalet ur en period: "I dag", "Förra månaden", eget intervall. */
type PeriodLike = Pick<ResolvedPeriod, "key" | "range" | "today">;

/** En period på exakt en dag (I dag, I går eller ett eget intervall på en dag). */
export function isSingleDay(p: Pick<ResolvedPeriod, "range">): boolean {
  return p.range !== null && isSameDay(p.range.start, p.range.end);
}

/**
 * Periodens namn i rubriker och på knappen: "I dag", "I går", "7 dagar", "Förra månaden",
 * och för ett eget intervall datumen ("14–20 nov."). Ett eget intervall som råkar vara i dag
 * eller i går heter så.
 */
export function periodName(p: PeriodLike): string {
  if (p.key !== "eget") return periodChoices.find((c) => c.key === p.key)?.label ?? p.key;
  if (!p.range) return "Eget intervall";
  if (isSingleDay(p)) {
    if (isSameDay(p.range.start, p.today)) return "I dag";
    if (isSameDay(p.range.start, addDays(p.today, -1))) return "I går";
  }
  return formatPeriodShort(p.range, p.today);
}

/** Namnet i löptext ("Analys · i går", "vinst i går"): förvalen med liten bokstav. */
export function periodNameInline(p: PeriodLike): string {
  const name = periodName(p);
  return p.key === "eget" && !/^I (dag|går)$/.test(name) ? name : lowerFirst(name);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/**
 * Jämförelsetexten efter en förändring: "mot i går", "mot dagen innan", "mot förra 7 dagarna",
 * "mot månaden innan", "mot perioden innan". null utan jämförelse ("Allt").
 */
export function compareText(p: Pick<ResolvedPeriod, "key" | "range" | "previous">): string | null {
  if (!p.previous || !p.range) return null;
  switch (p.key) {
    case "idag":
      return "mot i går";
    case "igar":
      return "mot dagen innan";
    case "7d":
      return "mot förra 7 dagarna";
    case "30d":
      return "mot förra 30 dagarna";
    case "manad":
      return "mot samma dagar förra månaden";
    case "forra-manaden":
      return "mot månaden innan";
    default:
      if (isSingleDay(p)) return "mot dagen innan";
      return `mot ${daysInPeriod(p.range)} dagar innan`;
  }
}

/** Upplösningen i diagram över perioden. */
export type ChartUnit = "hour" | "day" | "week" | "month";

/**
 * Hur ett diagram delar upp perioden: en dag per timme, upp till 31 dagar per dag, upp till
 * ett halvår per vecka och längre per månad.
 */
export function chartUnitFor(days: number): ChartUnit {
  if (days <= 1) return "hour";
  if (days <= 31) return "day";
  if (days <= 183) return "week";
  return "month";
}

/* ------------------------------------------------------------------ */
/* Periodvalet mellan sidor (kakan och länkarna)                       */
/* ------------------------------------------------------------------ */

/** Finns ett periodval i adressen (förval eller eget intervall)? */
export function hasPeriodParam(sp: SearchParamsInput): boolean {
  const v = readParam(sp, PERIOD_PARAM);
  return (v !== null && v !== "") || rawFrom(sp) !== null || rawTo(sp) !== null;
}

/**
 * Valet som kakans värde: "period=igar" eller "from=2026-11-14&to=2026-11-20". Standardvalet
 * (30 dagar) sparas inte (null = ta bort kakan), så att en sida utan ?period visar standard.
 */
export function periodCookieValue(selection: PeriodSelection): string | null {
  if (selection.key === DEFAULT_PERIOD) return null;
  return withPeriod(new URLSearchParams(), selection).toString();
}

/**
 * Kakans värde tillbaka som parametrar, bara om det är ett giltigt val (ett känt förval eller
 * två riktiga datum). Allt annat ger null, så att en trasig kaka aldrig styr en sida.
 */
export function periodFromCookie(value: string | null | undefined): URLSearchParams | null {
  if (!value || value.length > 80) return null;
  let raw: URLSearchParams;
  try {
    raw = new URLSearchParams(value);
  } catch {
    return null;
  }
  const key = raw.get(PERIOD_PARAM);
  if (key !== null) {
    return isPresetKey(key) && key !== DEFAULT_PERIOD
      ? new URLSearchParams({ [PERIOD_PARAM]: key })
      : null;
  }
  const from = parseIsoDate(raw.get(FROM_PARAM));
  const to = parseIsoDate(raw.get(TO_PARAM));
  if (!from || !to) return null;
  const r = normalizePeriod({ start: from, end: to });
  if (daysInPeriod(r) > MAX_RANGE_DAYS) return null;
  return new URLSearchParams({ [FROM_PARAM]: toIsoDate(r.start), [TO_PARAM]: toIsoDate(r.end) });
}

/**
 * Bara periodvalet ur adressen, skrivet som appen skriver det ("?period=igar",
 * "?from=…&to=…", ?fran/?till översatta), för menyns länkar. "" utan val.
 */
export function periodQuery(sp: SearchParamsInput): string {
  if (!hasPeriodParam(sp)) return "";
  const raw = readParam(sp, PERIOD_PARAM);
  let out: URLSearchParams;
  if (isPresetKey(raw)) out = new URLSearchParams({ [PERIOD_PARAM]: raw });
  else {
    const from = rawFrom(sp);
    const to = rawTo(sp);
    out = new URLSearchParams();
    if (from) out.set(FROM_PARAM, from);
    if (to) out.set(TO_PARAM, to);
  }
  const s = out.toString();
  return s ? `?${s}` : "";
}

/**
 * Sidorna som visar tal över en period och därför får det sparade valet (kakan) när länken
 * saknar ?period, och vars länkar i menyn och korten bär valet. Bara exakta sökvägar: en
 * undersida (en automat, en butik, en rapport) har egna datum.
 */
export const PERIOD_PAGES: readonly string[] = [
  "/",
  "/pengar",
  "/butiker",
  "/automater",
  "/automater/svinn",
  "/automater/enhetsekonomi",
  "/vart-lager",
  "/lonsamhet",
  "/order",
  "/ekonomi",
  "/lager",
  "/prognos",
  "/marknad",
  "/inkopspriser",
  "/inkorg",
  "/expansion",
  "/expansion/saljunderlag",
  "/effekt",
];

/** Next:s interna parameter för RSC-hämtningar; följer aldrig med i en omdirigering. */
const RSC_PARAM = "_rsc";

/** Sökvägen utan avslutande snedstreck ("/pengar/" → "/pengar"). */
function cleanPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") || "/" : pathname;
}

export function isPeriodPage(pathname: string): boolean {
  return PERIOD_PAGES.includes(cleanPath(pathname));
}

/**
 * Proxyns omdirigering för periodvalet, eller null: en periodsida (PERIOD_PAGES) utan
 * periodval i adressen får det sparade valet ur kakan. Returnerar sökvägen med query
 * ("/pengar?period=igar"). Övriga parametrar behålls, utom Next:s interna _rsc (klienten
 * hämtar då om med en ny, och adressfältet visar aldrig _rsc). Andra sökvägar och ?fran=/?till=
 * (Fyll på:s retur, Rapporters datum) rörs aldrig.
 */
export function periodRedirect(
  pathname: string,
  sp: URLSearchParams,
  cookieValue: string | undefined,
): string | null {
  if (!isPeriodPage(pathname) || hasPeriodParam(sp)) return null;
  const saved = periodFromCookie(cookieValue);
  if (!saved) return null;
  const next = new URLSearchParams(sp);
  next.delete(RSC_PARAM);
  for (const [k, v] of saved) next.set(k, v);
  const q = next.toString();
  return q ? `${pathname}?${q}` : pathname;
}

/**
 * Kakans nya värde när en periodsida öppnas med ett periodval i adressen (en länk som
 * "/pengar?period=idag" eller en delad länk), så att nästa sida utan ?period visar samma
 * period: en sträng = spara, null = ta bort (standardvalet), undefined = lämna kakan.
 */
export function periodCookieFromUrl(
  pathname: string,
  sp: SearchParamsInput,
): string | null | undefined {
  if (!isPeriodPage(pathname) || !hasPeriodParam(sp)) return undefined;
  if (readParam(sp, PERIOD_PARAM) === DEFAULT_PERIOD) return null;
  const saved = periodFromCookie(periodQuery(sp).replace(/^\?/, ""));
  return saved ? saved.toString() : undefined;
}

/**
 * Länken med periodvalet (`periodQs`, "?period=igar") när den går till en periodsida och inte
 * redan har ett eget val: "/lonsamhet?vy=title" → "/lonsamhet?vy=title&period=igar". Andra
 * länkar (en automat, Fyll på, Rapporter) lämnas orörda.
 */
export function withPeriodHref(href: string, periodQs: string): string {
  if (!periodQs) return href;
  const hashAt = href.indexOf("#");
  const hash = hashAt >= 0 ? href.slice(hashAt) : "";
  const base = hashAt >= 0 ? href.slice(0, hashAt) : href;
  const qAt = base.indexOf("?");
  const path = qAt >= 0 ? base.slice(0, qAt) : base;
  if (!isPeriodPage(path)) return href;
  const q = new URLSearchParams(qAt >= 0 ? base.slice(qAt + 1) : "");
  if (hasPeriodParam(q)) return href;
  for (const [k, v] of new URLSearchParams(periodQs.replace(/^\?/, ""))) q.set(k, v);
  return `${path}?${q.toString()}${hash}`;
}

/**
 * Periodnamnet på telefonens smala datumknapp: förvalen som vanligt, ett eget intervall med
 * siffror ("28/12–3/1", "1/11") så att slutdatumet alltid syns.
 */
export function periodNameCompact(p: PeriodLike): string {
  const name = periodName(p);
  if (p.key !== "eget" || !p.range || name.length <= 9) return name;
  // Inom en månad räcker namnet ("10–16 nov."), samma stil som rubrikerna; siffror bara över
  // månadsgränsen.
  const { start, end } = p.range;
  const sameMonth =
    start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth();
  if (sameMonth && name.length <= 11) return name;
  const dm = (d: Date) => `${d.getDate()}/${d.getMonth() + 1}`;
  if (isSingleDay(p)) return dm(p.range.start);
  return `${dm(p.range.start)}–${dm(p.range.end)}`;
}

/** Kortare jämförelsetext för små rutor (KPI-bandet): "mot förra 7 d", "mot dagen innan". */
export function compareTextShort(
  p: Pick<ResolvedPeriod, "key" | "range" | "previous">,
): string | null {
  const t = compareText(p);
  if (t === null) return null;
  return t
    .replace(/ dagarna$/, " d")
    .replace(/ dagar innan$/, " d innan")
    .replace("samma dagar förra månaden", "förra mån.");
}
