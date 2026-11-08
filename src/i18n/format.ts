/**
 * Formatering per språk. Svenska går via @/lib/format (samma regler som resten av appen).
 * Engelska: brittisk gruppering och decimalpunkt ("1,325"), belopp alltid i SEK med "kr"
 * efter talet ("1,325 kr", som svenska kronor skrivs på engelska), procent "33%", datum
 * "1 Nov" / "1 Nov 2026" och 24-timmarsklocka. Äkta minustecken och hårda mellanslag som
 * på svenska. Rent och klientsäkert.
 */

import {
  formatDate as svDate,
  formatDateTime as svDateTime,
  formatInt as svInt,
  formatKronor as svKronor,
  formatMarginBp as svMarginBp,
  formatSek as svSek,
  formatTime as svTime,
  MINUS,
  MISSING,
  NBSP,
  type DateOptions,
} from "@/lib/format";

import { INTL_LOCALE, type Locale } from "./locale";

export interface Formatters {
  readonly locale: Locale;
  /** 12 480 · 12,480 */
  int(value: number): string;
  /** Hela kronor: 12 480 kr · 12,480 kr */
  sek(value: number): string;
  /** Kronor med decimaler (standard 2): 79 987,00 kr · 79,987.00 kr */
  kronor(value: number, decimals?: number): string;
  /** Baspunkter som procent: 2 375 → 23,8 % · 23.8% */
  marginBp(bp: number, digits?: number): string;
  /** 17:17 */
  time(d: Date): string;
  /** 1 nov. 2026 · 1 Nov 2026 ({ year: "auto" } utelämnar innevarande år) */
  date(d: Date, options?: DateOptions): string;
  /** 1 nov. 17:17 · 1 Nov 17:17 */
  dateTime(d: Date, options?: DateOptions): string;
}

const sv: Formatters = {
  locale: "sv",
  int: svInt,
  sek: svSek,
  kronor: (v, decimals = 2) => svKronor(v, { decimals }),
  marginBp: svMarginBp,
  time: svTime,
  date: svDate,
  dateTime: svDateTime,
};

// ---------------------------------------------------------------------------
// Engelska
// ---------------------------------------------------------------------------

const EN = INTL_LOCALE.en;
const enNumber = new Map<number, Intl.NumberFormat>();

function enNf(digits: number): Intl.NumberFormat {
  let f = enNumber.get(digits);
  if (!f) {
    f = new Intl.NumberFormat(EN, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: "negative",
    });
    enNumber.set(digits, f);
  }
  return f;
}

function enNum(value: number, digits: number): string {
  return enNf(digits).format(value).replace(/-/g, MINUS);
}

/** Halva bort från noll, som @/lib/format. */
function roundInt(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

const MONTHS_EN = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function validDate(d: Date): boolean {
  return d instanceof Date && Number.isFinite(d.getTime());
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function showYear(d: Date, options: DateOptions, fallback: "auto" | "always"): boolean {
  const mode = options.year ?? fallback;
  if (mode === "always") return true;
  if (mode === "never") return false;
  return d.getFullYear() !== (options.now ?? new Date()).getFullYear();
}

const en: Formatters = {
  locale: "en",
  int: (v) => (Number.isFinite(v) ? enNum(roundInt(v), 0) : MISSING),
  sek: (v) => (Number.isFinite(v) ? `${enNum(roundInt(v), 0)}${NBSP}kr` : MISSING),
  kronor: (v, decimals = 2) =>
    Number.isFinite(v)
      ? `${enNum(v, Math.min(20, Math.max(0, Math.trunc(decimals))))}${NBSP}kr`
      : MISSING,
  marginBp: (bp, digits = 1) => {
    if (!Number.isFinite(bp)) return MISSING;
    const d = Math.min(2, Math.max(0, Math.trunc(digits)));
    const step = 10 ** (2 - d);
    const units = Math.sign(bp) * Math.floor((Math.abs(Math.round(bp)) + step / 2) / step) || 0;
    return `${enNum(units / 10 ** d, d)}%`;
  },
  time: (d) => (validDate(d) ? `${pad2(d.getHours())}:${pad2(d.getMinutes())}` : MISSING),
  date: (d, options = {}) => {
    if (!validDate(d)) return MISSING;
    const base = `${d.getDate()}${NBSP}${MONTHS_EN[d.getMonth()]}`;
    return showYear(d, options, "always") ? `${base}${NBSP}${d.getFullYear()}` : base;
  },
  dateTime: (d, options = {}) =>
    validDate(d)
      ? `${en.date(d, { year: options.year ?? "auto", now: options.now })} ${en.time(d)}`
      : MISSING,
};

const BY_LOCALE: Record<Locale, Formatters> = { sv, en };

/** Formatteringen för språket. */
export function formatters(locale: Locale): Formatters {
  return BY_LOCALE[locale];
}
