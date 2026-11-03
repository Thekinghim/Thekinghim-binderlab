/**
 * Gemensamt för rapportsidorna (butik, bokföring, delägare): omvandling från
 * ögonblicksbildens öre, bp och affärsdatum till formaterad text via src/lib/format.
 */

import {
  formatDate,
  formatDelta,
  formatKronor,
  formatMonth,
  formatPercent,
  formatSek,
} from "@/lib/format";
import type { Period as DatePeriod } from "@/lib/period";
import { isWholeMonth, periodText } from "@/reports/text";

/** 'ÅÅÅÅ-MM-DD' → lokal midnatt (samma konvention som src/lib/period). */
export function localDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

export function datePeriod(p: { start: string; end: string }): DatePeriod {
  return { start: localDate(p.start), end: localDate(p.end) };
}

/** Öre → "12 480 kr". */
export const sek = (ore: number) => formatSek(ore / 100);
/** Öre → "12 480,50 kr". */
export const kronor = (ore: number) => formatKronor(ore / 100);
/** Öre → "−1 240 kr" för avdrag (alltid med minus). */
export const minusSek = (ore: number) =>
  ore === 0 ? formatSek(0) : formatSek(-Math.abs(ore) / 100);
/** Öre → "12 480" (utan enhet, för nyckeltal där enheten står bredvid). */
export const sekValue = (ore: number) => formatSek(ore / 100).replace(/\s*kr$/, "");
/** bp → "33,1 %". `null` → "–". */
export const pct = (bp: number | null, digits = 1) =>
  bp === null ? "–" : formatPercent(bp / 10_000, digits);
/** Förändring i bp → "+12 %". */
// En decimal, som mejlet (formatDelta(…, 1)): samma förändring står likadant i PDF och mejl.
export const delta = (bp: number | null) => (bp === null ? undefined : formatDelta(bp / 10_000, 1));
/** "oktober 2026" */
export const monthLabel = (month: string) => formatMonth(localDate(`${month}-01`));
/** "oktober" */
export const monthName = (month: string) =>
  formatMonth(localDate(`${month}-01`), { year: "never" });
/**
 * Rapportens period för rubriker: "oktober 2026", eller för eget datum "15–31 okt. 2026".
 */
export const periodLabel = (s: { month: string; period: { start: string; end: string } }) =>
  isWholeMonth(s.period) ? monthLabel(s.month) : periodText(s.period);
/** I löptext: "oktober", eller för eget datum "15–31 okt. 2026". */
export const periodName = (s: { month: string; period: { start: string; end: string } }) =>
  isWholeMonth(s.period) ? monthName(s.month) : periodText(s.period);
/** "24 okt." */
export const dayLabel = (iso: string) => formatDate(localDate(iso), { year: "never" });

/** Rubriknivåer: egen sida (h1 + h2) eller inbäddad under sidans h1 (h2 + h3). */
export type HeadingLevel = "page" | "embedded";
export const TITLE_TAG = { page: "h1", embedded: "h2" } as const;
export const SECTION_TAG = { page: "h2", embedded: "h3" } as const;

/** Avslutar en mening utan dubbel punkt efter en förkortning ("30 okt."). */
export const sentence = (text: string) => (text.endsWith(".") ? text : `${text}.`);
