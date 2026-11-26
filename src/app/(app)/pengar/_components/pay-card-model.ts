/**
 * Kortet "Att betala" på Pengar: samma tal som /pengar/utbetalningar.
 *
 * Har organisationen lagt in utbetalningar från Nayax är det saldona där som gäller (butiker,
 * partnern och momsen, src/server/payouts/balances.ts), och kortets summa är sidans "Att
 * betala just nu" (toPayOre). Annars är det de obetalda avräkningarna till butikerna
 * (loadMoneyPay). Kortet räknar inget eget.
 */

import type { PayOverview, RecipientRow } from "@/server/payouts/balances";

import { monthName } from "./fmt";

export interface PayoutPayRow {
  readonly key: string;
  readonly kind: RecipientRow["kind"];
  readonly name: string;
  readonly leftOre: number;
  readonly lineIds: readonly string[];
}

export interface PayoutPayCard {
  readonly rows: readonly PayoutPayRow[];
  /** Samma som "Att betala just nu" på Utbetalningar. */
  readonly totalOre: number;
}

/** Mottagarna med något kvar, i Utbetalningars ordning, och sidans summa. */
export function payoutPayCard(
  overview: Pick<PayOverview, "recipients" | "toPayOre">,
): PayoutPayCard {
  return {
    rows: overview.recipients
      .filter((r) => r.leftOre > 0)
      .map((r) => ({
        key: r.key,
        kind: r.kind,
        name: r.name,
        leftOre: r.leftOre,
        lineIds: r.lineIds,
      })),
    totalOre: overview.toPayOre,
  };
}

/**
 * Butiker utan avräkning (samma som "Saknas" på Utbetalning) i en mening: "Bio Ett saknar
 * avräkning för oktober." eller "7 butiker saknar avräkning för oktober.". Flera månader:
 * utan månad. Tom lista: null.
 */
export function missingSettlementsText(
  missing: readonly { readonly storeName: string; readonly month: string }[],
): string | null {
  if (missing.length === 0) return null;
  const months = [...new Set(missing.map((m) => m.month))];
  const stores = new Set(missing.map((m) => m.storeName)).size;
  const which = months.length === 1 ? ` för ${monthName(months[0]!)}` : "";
  return stores === 1
    ? `${missing[0]!.storeName} saknar avräkning${which}.`
    : `${stores} butiker saknar avräkning${which}.`;
}
