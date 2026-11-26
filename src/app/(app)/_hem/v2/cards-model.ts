/**
 * Rena delar av Hems analyskort (cards-data.ts), så att talen går att pröva mot källan.
 */

import { settlementDue, settlementLink } from "@/analytics/todos/settlements";
import type { IsoDate, IsoMonth } from "@/domain";

import type { HomeKpi } from "@/app/(app)/_hem/model";
import { missingSettlementsText } from "@/app/(app)/pengar/_components/pay-card-model";

/**
 * Jämförelseperiodens vinst (öre) för Resultat: Hems nyckeltal som det är (samma tal som
 * hjältekortets "mot förra"), inte räknat baklänges ur den avrundade förändringen.
 */
export function previousProfitOre(
  kpi: Pick<HomeKpi, "value" | "previous"> | undefined,
): number | null {
  return kpi?.value != null ? (kpi.previous ?? null) : null;
}

export interface MissingSettlements {
  readonly text: string;
  readonly stores: number;
  /** Äldsta saknade månadens sista dag att betala (den 15:e månaden efter). */
  readonly due: IsoDate;
  /** Utbetalning för den månaden, där knappen skapar avräkningarna. */
  readonly href: string;
}

/**
 * Butiker utan avräkning (samma som "Saknas" på Utbetalning och "Skapa
 * oktober-avräkningarna" i Att göra) för Butiker-kortet, eller null när inget saknas.
 */
export function missingSettlements(
  missing: readonly { readonly storeName: string; readonly month: string }[],
): MissingSettlements | null {
  const text = missingSettlementsText(missing);
  const oldest = missing.reduce<string | null>(
    (a, m) => (a === null || m.month < a ? m.month : a),
    null,
  );
  if (!text || !oldest) return null;
  const month = oldest as IsoMonth;
  return {
    text,
    stores: new Set(missing.map((m) => m.storeName)).size,
    due: settlementDue(month),
    href: settlementLink(month),
  };
}
