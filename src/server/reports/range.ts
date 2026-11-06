/**
 * Eget datum för rapporter: kontroll av ett från–till-intervall. Ren modul (inga anrop),
 * används av server action, tjänsten och sidan.
 *
 * Regler: giltiga datum, från ≤ till, till högst i dag (organisationens affärsdag) och
 * högst ett år (366 dagar). Alla rapporttyper (butik, bokföring och delägare) kan ha eget datum.
 */

import {
  isIsoDate,
  monthPeriod,
  periodDays,
  type IsoDate,
  type IsoMonth,
  type Period,
} from "@/domain";
import { isWholeMonth } from "@/reports/text";

import type { ReportType } from "./kinds";

/** Längsta egna intervall (ett år, skottår inräknat). */
export const MAX_RANGE_DAYS = 366;

/** Rapporttyper där man kan välja eget datum. */
export const RANGE_TYPES: readonly ReportType[] = ["butik", "bokforing", "delagare"];

export function allowsRange(type: ReportType): boolean {
  return RANGE_TYPES.includes(type);
}

/** Felet på svenska, eller null om intervallet går att använda. */
export function rangeError(from: string, to: string, today: IsoDate): string | null {
  if (!isIsoDate(from) || !isIsoDate(to)) return "Skriv datum som ÅÅÅÅ-MM-DD.";
  if (from > to) return "Från-datumet måste vara före till-datumet.";
  if (to > today) return "Till-datumet kan inte vara efter i dag.";
  if (periodDays({ start: from, end: to }) > MAX_RANGE_DAYS)
    return "Perioden får vara högst ett år.";
  return null;
}

/** Förvalt intervall när man byter till eget datum: månaden, men aldrig efter i dag. */
export function defaultRange(month: IsoMonth, today: IsoDate): Period {
  const p = monthPeriod(month);
  return { start: p.start, end: p.end > today ? today : p.end };
}

/** Sant om intervallet är ett eget datum (inte en hel kalendermånad). */
export function isCustomRange(period: Period): boolean {
  return !isWholeMonth(period);
}
