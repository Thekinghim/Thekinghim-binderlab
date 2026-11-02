/**
 * Formatering för Marknad: öre, bp och affärsdatum till text via src/lib/format.
 * Ren modul (ingen server-only), används av modellen, sidan och klientkomponenterna.
 */

import type { ScenarioFigure } from "@/analytics/expansion/common";
import type { IsoDate, Period } from "@/domain";
import {
  formatDate,
  formatDelta,
  formatInt,
  formatKronor,
  formatNumber,
  formatPercent,
  formatPeriod,
  formatSignedKronor,
  NBSP,
} from "@/lib/format";

/** "2026-11-14" → Date mitt på dagen (samma kalenderdag i alla tidszoner). */
export function dateOf(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

/** 14 nov. (innevarande år) · 14 nov. 2025. */
export function dayText(date: IsoDate, today: IsoDate): string {
  return formatDate(dateOf(date), { year: "auto", now: dateOf(today) });
}

/** Perioden med år: "3 okt. – 1 nov. 2026". */
export function periodLabel(period: Period): string {
  return formatPeriod({ start: dateOf(period.start), end: dateOf(period.end) });
}

/** 2 490 öre → "24,90 kr". */
export function kronor(ore: number): string {
  return formatKronor(ore / 100);
}

/** 2 490 öre → "25 kr". */
export function kronorWhole(ore: number): string {
  return formatKronor(ore / 100, { decimals: 0 });
}

/** +12 000 öre → "+120 kr". */
export function signedKronorWhole(ore: number): string {
  return formatSignedKronor(ore / 100, { decimals: 0 });
}

/** 1 250 bp → "12,5 %". */
export function percentOfBp(bp: number, digits = 1): string {
  return formatPercent(bp / 10_000, digits);
}

/** Förändring i bp med tecken: 1 250 → "+13 %". */
export function deltaOfBp(bp: number, digits = 0): string {
  return formatDelta(bp / 10_000, digits);
}

/** Tiondelar som tal: 125 → "12,5". */
export function tenthsNumber(tenths: number): string {
  return Number.isInteger(tenths / 10) ? formatInt(tenths / 10) : formatNumber(tenths / 10, 1);
}

/** Antal med enhet: 12 → "12 pack". */
export function packs(n: number): string {
  return `${formatInt(n)}${NBSP}pack`;
}

/** Ett tal i underlaget med sin enhet. */
export function figureText(f: ScenarioFigure): string {
  switch (f.unit) {
    case "ore":
      return kronor(f.value);
    case "bp":
      return percentOfBp(f.value);
    case "count":
      return formatInt(f.value);
    case "packs":
      return packs(f.value);
    case "days":
      return `${formatInt(f.value)}${NBSP}d`;
    case "hours":
      return `${formatInt(f.value)}${NBSP}h`;
    case "minutes":
      return `${formatInt(f.value)}${NBSP}min`;
    case "tenths":
      return tenthsNumber(f.value);
    case "hundredths":
      return formatNumber(f.value / 100, 2);
    default:
      return formatInt(f.value);
  }
}

/** Det i ett underlag som behövs för länkarna till orderlistan. */
export interface OrderLinkEvidence {
  readonly period: Period | null;
  readonly orderIds: readonly string[];
  readonly dates: readonly IsoDate[];
  readonly titleIds: readonly string[];
  readonly machineIds: readonly string[];
}

/** Så många titlar får egna länkar till orderlistan; fler visas som en länk utan titel. */
const MAX_TITLE_LINKS = 6;

/**
 * Länkar till orderlistan, avgränsade så nära underlaget som orderlistan kan: perioden,
 * automaten när underlaget gäller exakt en, och titeln (en länk per titel när underlaget
 * gäller flera, högst MAX_TITLE_LINKS).
 */
export function orderLinks(
  e: OrderLinkEvidence,
  titleName: (id: string) => string,
): { href: string; label: string }[] {
  if (e.orderIds.length === 0) return [];
  const sorted = [...e.dates].sort();
  const start = e.period?.start ?? sorted[0];
  const end = e.period?.end ?? sorted[sorted.length - 1];
  if (!start || !end) return [];
  const base = new URLSearchParams({ from: start, to: end });
  if (e.machineIds.length === 1) base.set("automat", e.machineIds[0]!);
  const count = `${formatInt(e.orderIds.length)}${NBSP}order i underlaget`;
  if (e.titleIds.length === 0 || e.titleIds.length > MAX_TITLE_LINKS) {
    return [{ href: `/order?${base.toString()}`, label: `${count} →` }];
  }
  if (e.titleIds.length === 1) {
    base.set("titel", e.titleIds[0]!);
    return [{ href: `/order?${base.toString()}`, label: `${count} →` }];
  }
  return e.titleIds.map((id) => {
    const params = new URLSearchParams(base);
    params.set("titel", id);
    return { href: `/order?${params.toString()}`, label: `Order för ${titleName(id)} →` };
  });
}
