/**
 * Visning för Ekonomi och Avtal: belopp i öre till text, perioder och etiketter. Ingen
 * beräkning: alla tal kommer från @/domain, @/analytics och @/reports via src/server/accounting.
 * Fungerar både på servern och i klientkomponenter.
 */

import {
  formatInt,
  formatKronor,
  formatMonth,
  formatPeriod,
  formatPeriodShort,
  formatSek,
  formatSignedKronor,
  MISSING,
  NBSP,
} from "@/lib/format";

export type IsoPeriod = { readonly start: string; readonly end: string };

/** 'ÅÅÅÅ-MM-DD' → lokal Date vid midnatt (för format.ts). */
export function isoToDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1);
}

/** Öre → "1 234,50 kr". */
export function kr(ore: number | null | undefined): string {
  return ore === null || ore === undefined ? MISSING : formatKronor(ore / 100);
}

/**
 * Öre → "425 817 kr", med ören bara när de finns ("129,50 kr"): enskilda belopp på sidan,
 * som på V2-sidorna, även bokföringens månadssiffror. Bara verifikationslistan behåller
 * två decimaler (kr).
 */
export function amount(ore: number | null | undefined): string {
  if (ore === null || ore === undefined) return MISSING;
  return formatKronor(ore / 100, { decimals: ore % 100 === 0 ? 0 : 2 });
}

/**
 * Belopp som står bredvid varandra (en månads siffror i Bokföring) i samma form: har något av
 * dem ören får alla två decimaler ("30 000,00 kr" bredvid "81 645,20 kr"), annars hela kronor.
 */
export function amountsAlike(ores: readonly number[]): string[] {
  const decimals = ores.some((o) => o % 100 !== 0) ? 2 : 0;
  return ores.map((o) => formatKronor(o / 100, { decimals }));
}

/** Öre → "1 235 kr" (hela kronor, rubriker och KPI). */
export function sek(ore: number | null | undefined): string {
  return ore === null || ore === undefined ? MISSING : formatSek(ore / 100);
}

/** Öre → "+12,00 kr" / "−98,00 kr" / "±0,00 kr". */
export function signedKr(ore: number): string {
  return formatSignedKronor(ore / 100);
}

/** Öre → "+12 kr" / "−713 kr" (hela kronor, i rubriker och meningar, design.md 4). */
export function signedSek(ore: number): string {
  return formatSignedKronor(ore / 100, { decimals: 0 });
}

/** Öre → text för ett beloppsfält: "41200" eller "41200,50". */
export function amountField(ore: number): string {
  const kr = Math.trunc(ore / 100);
  const rest = Math.abs(ore % 100);
  return rest === 0 ? String(kr) : `${kr},${String(rest).padStart(2, "0")}`;
}

export function periodText(p: IsoPeriod): string {
  return formatPeriod({ start: isoToDate(p.start), end: isoToDate(p.end) });
}

export function periodShort(p: IsoPeriod, today?: string): string {
  return formatPeriodShort(
    { start: isoToDate(p.start), end: isoToDate(p.end) },
    today ? isoToDate(today) : new Date(),
  );
}

/** 'ÅÅÅÅ-MM' → "oktober 2026". */
export function monthText(month: string): string {
  return formatMonth(isoToDate(`${month}-01`), { year: "always" });
}

/** Plural med antal: plural(2, "avvikelse", "avvikelser") → "2 avvikelser". */
export function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

/** Text med versal först. */
export function capitalize(text: string): string {
  return text.charAt(0).toLocaleUpperCase("sv-SE") + text.slice(1);
}

/** Lägg till punkt om meningen saknar avslutning. */
/** En mening: stor bokstav först och punkt sist (om den saknas). */
export function sentence(text: string): string {
  const t = text.trim();
  const capitalized = t.charAt(0).toLocaleUpperCase("sv-SE") + t.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

export const FIXED_COST_CATEGORY_LABEL = {
  insurance: "Försäkring",
  software: "Programvara",
  transport: "Transport",
  storage: "Lager och lokal",
  other: "Övrigt",
} as const;

export const INTERVAL_LABEL = {
  month: "per månad",
  quarter: "per kvartal",
  year: "per år",
} as const;
