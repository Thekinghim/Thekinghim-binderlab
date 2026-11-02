/**
 * Svensk formatering. Alla tal, belopp, datum och perioder i UI:t,
 * rapporter och e-post går via dessa funktioner.
 *
 * Typografiska regler som gäller överallt:
 * - Hårt mellanslag (U+00A0) som tusentalsavgränsare och mellan tal och
 *   enhet: "79 987,00 kr", "33,1 %". Intl kan ge U+00A0 eller U+202F
 *   beroende på ICU-version; allt normaliseras till U+00A0.
 * - Äkta minustecken (U+2212): "−1 240 kr". Aldrig bindestreck.
 * - Tankstreck (U+2013) i intervall: "1–30 nov." utan mellanslag när
 *   ändarna är enkla, "3 okt. – 1 nov." med hårda mellanslag när
 *   ändarna själva innehåller mellanslag.
 * - Värden som saknas eller inte är ändliga (NaN, ±Infinity, ogiltigt
 *   datum) visas som ett ensamt tankstreck: "–".
 *
 * Undantag: formatCsvNumber skriver bindestreck och inga avgränsare,
 * eftersom kalkylprogram annars inte läser talet.
 */

import {
  calendarDaysBetween,
  isFullMonth,
  isSameDay,
  isWholeMonths,
  isWholeYears,
  normalizePeriod,
  type Period,
} from "./period";

export const NBSP = " ";
export const MINUS = "−";
export const EN_DASH = "–";
/** Visas för saknade eller ogiltiga värden. */
export const MISSING = EN_DASH;

const LOCALE = "sv-SE";

// ---------------------------------------------------------------------------
// Intern hjälp
// ---------------------------------------------------------------------------

const formatters = new Map<string, Intl.NumberFormat>();

function nf(min: number, max: number = min): Intl.NumberFormat {
  const key = `${min}:${max}`;
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: min,
      maximumFractionDigits: max,
      // Döljer minus på −0 efter avrundning (−0,001 → "0,00").
      signDisplay: "negative",
    });
    formatters.set(key, f);
  }
  return f;
}

/** Gör Intl-utdata deterministisk: smala/vanliga mellanslag → U+00A0, bindestreck → U+2212. */
function normalize(s: string): string {
  return s.replace(/[   ]/g, NBSP).replace(/[-−]/g, MINUS);
}

function num(value: number, digits: number): string {
  return normalize(nf(digits).format(value));
}

function clampDigits(digits: number): number {
  return Math.min(20, Math.max(0, Math.trunc(digits)));
}

function isValidDate(d: Date): boolean {
  return d instanceof Date && Number.isFinite(d.getTime());
}

// ---------------------------------------------------------------------------
// Tal
// ---------------------------------------------------------------------------

/** 12 480 · −3 (avrundat heltal) */
export function formatInt(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  return num(Math.round(value), 0);
}

/** 1 234,57 med valfritt antal decimaler (standard 0). */
export function formatNumber(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return MISSING;
  return num(value, clampDigits(digits));
}

/** 12,4 (alltid en decimal) */
export function formatDecimal(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  return num(value, 1);
}

const compactFmt = new Intl.NumberFormat(LOCALE, {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** 12,4 tn · 1,2 mn (Intl:s korta form, för täta etiketter) */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  return normalize(compactFmt.format(value));
}

/**
 * Tal för CSV-export med semikolon som fältavgränsare: decimalkomma,
 * inga tusentalsavgränsare, vanligt bindestreck. 79987 → "79987,00".
 * Saknade värden blir en tom cell.
 */
export function formatCsvNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "";
  const d = clampDigits(digits);
  const s = new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
    useGrouping: false,
    signDisplay: "negative",
  }).format(value);
  return s.replace(/−/g, "-");
}

// ---------------------------------------------------------------------------
// Kronor
// ---------------------------------------------------------------------------

export type KronorOptions = {
  /** Antal decimaler. Standard 2 (öre). 0 avrundar till hela kronor. */
  decimals?: number;
};

/** 79 987,00 kr · { decimals: 0 } → 79 987 kr · −1 240,50 kr */
export function formatKronor(value: number, options: KronorOptions = {}): string {
  if (!Number.isFinite(value)) return MISSING;
  return `${num(value, clampDigits(options.decimals ?? 2))}${NBSP}kr`;
}

/** Förändring i kronor, tecken skrivs alltid ut: +1 240,00 kr · −1 240,00 kr · ±0,00 kr */
export function formatSignedKronor(value: number, options: KronorOptions = {}): string {
  if (!Number.isFinite(value)) return MISSING;
  const digits = clampDigits(options.decimals ?? 2);
  const body = num(Math.abs(value), digits);
  const isZero = Number(Math.abs(value).toFixed(digits)) === 0;
  const sign = isZero ? "±" : value > 0 ? "+" : MINUS;
  return `${sign}${body}${NBSP}kr`;
}

/** 12 480 kr (hela kronor, för tabeller och KPI:er). Motsvarar formatKronor(v, { decimals: 0 }). */
export function formatSek(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  return `${num(Math.round(value), 0)}${NBSP}kr`;
}

/** Axlar och kompakta etiketter: 8 000 · 12 tkr · 31,1 tkr · 1,2 mkr */
export function formatSekAxis(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${formatDecimal(value / 1_000_000)}${NBSP}mkr`;
  if (abs >= 10_000) {
    const k = value / 1000;
    return `${Number.isInteger(Math.round(k * 10) / 10) ? formatInt(k) : formatDecimal(k)}${NBSP}tkr`;
  }
  return formatInt(value);
}

/** Alltid i tkr: 2,9 tkr · 131,4 tkr */
export function formatTkr(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  const k = Math.round(value / 100) / 10;
  return `${Number.isInteger(k) ? formatInt(k) : formatDecimal(k)}${NBSP}tkr`;
}

// ---------------------------------------------------------------------------
// Procent
// ---------------------------------------------------------------------------

export type PercentOptions = {
  /** Antal decimaler. Standard 1. */
  digits?: number;
};

/**
 * Andel 0–1 som procent: 0.331 → "33,1 %".
 * Andra argumentet kan vara antal decimaler (formatPercent(v, 0) → "33 %")
 * eller ett options-objekt ({ digits: 2 }).
 */
export function formatPercent(share: number, digits: number | PercentOptions = 1): string {
  if (!Number.isFinite(share)) return MISSING;
  const d = clampDigits(typeof digits === "number" ? digits : (digits.digits ?? 1));
  return `${num(share * 100, d)}${NBSP}%`;
}

/** +42 % · −8 % · ±0 % (förändring som andel). Tecken skrivs alltid ut. Standard 0 decimaler. */
export function formatDelta(change: number, digits = 0): string {
  if (!Number.isFinite(change)) return MISSING;
  const d = clampDigits(digits);
  const pct = Math.abs(change) * 100;
  const isZero = Number(pct.toFixed(d)) === 0;
  const sign = isZero ? "±" : change > 0 ? "+" : MINUS;
  return `${sign}${num(pct, d)}${NBSP}%`;
}

// ---------------------------------------------------------------------------
// Tid och varaktighet
// ---------------------------------------------------------------------------

/**
 * Varaktighet i millisekunder, högst två enheter:
 * 45 s · 14 min · 2 h 14 min · 2 h · 3 d · 3 d 4 h.
 * Avrundas till närmaste minsta visade enhet.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return MISSING;
  const sign = ms < 0 ? MINUS : "";
  const abs = Math.abs(ms);
  const sec = Math.round(abs / 1000);
  if (sec < 60) return `${sign}${sec}${NBSP}s`;
  const min = Math.round(abs / 60_000);
  if (min < 60) return `${sign}${min}${NBSP}min`;
  if (min < 24 * 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return `${sign}${h}${NBSP}h${m ? ` ${m}${NBSP}min` : ""}`;
  }
  const hours = Math.round(abs / 3_600_000);
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  return `${sign}${formatInt(d)}${NBSP}d${h ? ` ${h}${NBSP}h` : ""}`;
}

// ---------------------------------------------------------------------------
// Datum
// ---------------------------------------------------------------------------

/** Korta månadsnamn enligt Språkrådet (och Intl sv-SE): punkt bara där ordet är förkortat. */
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

/** Kompakta månader utan punkt, för axlar och täta etiketter (formatDay). */
const MONTHS_TIGHT = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
] as const;
const WEEKDAYS = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"] as const;

export const weekdaysShort = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"] as const;

function monthShort(d: Date): string {
  return MONTHS_SHORT[d.getMonth()] ?? "";
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export type YearDisplay = "auto" | "always" | "never";

export type DateOptions = {
  /** auto: utelämna året om det är samma som i `now`. */
  year?: YearDisplay;
  /** Referens för year: "auto". Standard new Date(). */
  now?: Date;
};

function showYear(d: Date, options: DateOptions, fallback: YearDisplay): boolean {
  const mode = options.year ?? fallback;
  if (mode === "always") return true;
  if (mode === "never") return false;
  return d.getFullYear() !== (options.now ?? new Date()).getFullYear();
}

/** 26 okt (axlar och täta etiketter, utan punkt) */
export function formatDay(d: Date): string {
  if (!isValidDate(d)) return MISSING;
  return `${d.getDate()}${NBSP}${MONTHS_TIGHT[d.getMonth()]}`;
}

/** tis 26 okt */
export function formatWeekdayDay(d: Date): string {
  if (!isValidDate(d)) return MISSING;
  return `${WEEKDAYS[d.getDay()]} ${formatDay(d)}`;
}

/** 17:17 · 09:05 (24-timmarsklocka) */
export function formatTime(d: Date): string {
  if (!isValidDate(d)) return MISSING;
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 1 nov. 2026. Året skrivs ut som standard; { year: "auto" } utelämnar innevarande år. */
export function formatDate(d: Date, options: DateOptions = {}): string {
  if (!isValidDate(d)) return MISSING;
  const base = `${d.getDate()}${NBSP}${monthShort(d)}`;
  return showYear(d, options, "always") ? `${base}${NBSP}${d.getFullYear()}` : base;
}

/** 1 nov. 17:17 · 28 dec. 2025 17:17. Året utelämnas som standard om det är innevarande år. */
export function formatDateTime(d: Date, options: DateOptions = {}): string {
  if (!isValidDate(d)) return MISSING;
  return `${formatDate(d, { year: options.year ?? "auto", now: options.now })} ${formatTime(d)}`;
}

/** november 2026 · { year: "never" } → november */
export function formatMonth(d: Date, options: DateOptions = {}): string {
  if (!isValidDate(d)) return MISSING;
  const name = MONTHS_LONG[d.getMonth()] ?? "";
  return showYear(d, options, "always") ? `${name} ${d.getFullYear()}` : name;
}

/**
 * Relativ tidpunkt för händelser och loggar:
 * nyss · för 4 min sedan · för 3 h sedan · igår 17:17 · mån 17:17 · 24 okt. 17:17.
 * Tidpunkter i framtiden (mer än en minut) visas som absolut datum och tid.
 */
export function formatRelative(d: Date, now: Date = new Date()): string {
  if (!isValidDate(d) || !isValidDate(now)) return MISSING;
  const diff = now.getTime() - d.getTime();
  if (Math.abs(diff) < 60_000) return "nyss";
  if (diff < 0) return formatDateTime(d, { now });
  const min = Math.floor(diff / 60_000);
  if (min < 60) return `för ${min}${NBSP}min sedan`;
  const days = calendarDaysBetween(d, now);
  if (days === 0) return `för ${Math.floor(min / 60)}${NBSP}h sedan`;
  if (days === 1) return `igår ${formatTime(d)}`;
  if (days < 7) return `${WEEKDAYS[d.getDay()]} ${formatTime(d)}`;
  return formatDateTime(d, { now });
}

// ---------------------------------------------------------------------------
// Perioder
// ---------------------------------------------------------------------------

/** Intervall: tätt tankstreck om ändarna saknar mellanslag, annars hårda mellanslag kring. */
function range(a: string, b: string): string {
  const spaced = /[\s ]/.test(a) || /[\s ]/.test(b);
  return spaced ? `${a}${NBSP}${EN_DASH}${NBSP}${b}` : `${a}${EN_DASH}${b}`;
}

/**
 * Period med inklusivt slutdatum, alltid med år:
 * - en dag: 1 nov. 2026
 * - hel månad: november 2026
 * - flera hela månader: oktober–november 2026
 * - helt år: 2026 · flera hela år: 2025–2026
 * - samma månad: 1–30 nov. 2026
 * - samma år: 3 okt. – 1 nov. 2026 (även året hittills: 1 jan. – 1 nov. 2026)
 * - över årsskifte: 28 dec. 2025 – 3 jan. 2026
 */
export function formatPeriod(period: Period): string {
  if (!isValidDate(period.start) || !isValidDate(period.end)) return MISSING;
  const { start, end } = normalizePeriod(period);
  const sy = start.getFullYear();
  const ey = end.getFullYear();

  if (isSameDay(start, end)) return formatDate(start, { year: "always" });
  if (isWholeYears({ start, end })) return sy === ey ? String(sy) : range(String(sy), String(ey));
  if (isFullMonth({ start, end })) return formatMonth(start, { year: "always" });
  if (isWholeMonths({ start, end })) {
    return sy === ey
      ? `${range(formatMonth(start, { year: "never" }), formatMonth(end, { year: "never" }))} ${ey}`
      : range(formatMonth(start), formatMonth(end));
  }
  if (sy === ey && start.getMonth() === end.getMonth()) {
    return `${start.getDate()}${EN_DASH}${end.getDate()}${NBSP}${monthShort(end)}${NBSP}${ey}`;
  }
  if (sy === ey) {
    return range(formatDate(start, { year: "never" }), formatDate(end, { year: "always" }));
  }
  return range(formatDate(start, { year: "always" }), formatDate(end, { year: "always" }));
}

/**
 * Kort period för etiketter, knappar och axlar. Året utelämnas när hela
 * perioden ligger i samma år som `now`:
 * 1 nov. · 1–30 nov. · 3 okt. – 1 nov. · nov. · 2025 · 28 dec. 2025 – 3 jan.
 */
export function formatPeriodShort(period: Period, now: Date = new Date()): string {
  if (!isValidDate(period.start) || !isValidDate(period.end)) return MISSING;
  const { start, end } = normalizePeriod(period);
  const sy = start.getFullYear();
  const ey = end.getFullYear();
  const current = now.getFullYear();
  const yearSuffix = sy === ey && ey !== current ? `${NBSP}${ey}` : "";

  if (isSameDay(start, end)) return formatDate(start, { year: "auto", now });
  if (isWholeYears({ start, end })) return sy === ey ? String(sy) : range(String(sy), String(ey));
  if (isFullMonth({ start, end })) return `${monthShort(start)}${yearSuffix}`;
  if (sy === ey && start.getMonth() === end.getMonth()) {
    return `${start.getDate()}${EN_DASH}${end.getDate()}${NBSP}${monthShort(end)}${yearSuffix}`;
  }
  if (sy === ey) {
    return (
      range(formatDate(start, { year: "never" }), formatDate(end, { year: "never" })) + yearSuffix
    );
  }
  return range(formatDate(start, { year: "always" }), formatDate(end, { year: "auto", now }));
}
