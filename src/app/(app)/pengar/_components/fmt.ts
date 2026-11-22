/**
 * Små formatterare för Pengar och Butiker i V2 (rena, för server och klient). Öre in, text ut;
 * avrundning bara här (src/lib/format.ts gör siffrorna).
 */

import { formatInt, formatKronor, NBSP } from "@/lib/format";

/** "123 675 kr" (hela kronor). */
export function kr(ore: number): string {
  return formatKronor(ore / 100, { decimals: 0 });
}

/** "5 176,40 kr" när det finns ören, annars "5 176 kr" (belopp som ska betalas). */
export function krExact(ore: number): string {
  return formatKronor(ore / 100, { decimals: ore % 100 === 0 ? 0 : 2 });
}

/** "20,4 %" ur bp (en decimal). */
export function pct(bp: number, digits = 1): string {
  return `${(bp / 100).toLocaleString("sv-SE", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${NBSP}%`;
}

/** "+13 %", "−16 %" ur bp (hela procent). */
export function signedPct(bp: number): string {
  const v = Math.round(bp / 100);
  return `${v > 0 ? "+" : v < 0 ? "−" : ""}${formatInt(Math.abs(v))}${NBSP}%`;
}

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
];

/** "15 december" för '2026-12-15'. */
export function dayMonth(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1] ?? ""}`;
}

/** "2 nov" för '2026-11-02'. */
export function dayMonthShort(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${(MONTHS[Number(iso.slice(5, 7)) - 1] ?? "").slice(0, 3)}`;
}

/** "oktober" för '2026-10'. */
export function monthName(month: string): string {
  return MONTHS[Number(month.slice(5, 7)) - 1] ?? month;
}

/** "Okt" för '2026-10'. */
export function monthShortCap(month: string): string {
  const m = monthName(month).slice(0, 3);
  return m.charAt(0).toUpperCase() + m.slice(1);
}

/** "1 butik" / "3 butiker". */
export function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}
