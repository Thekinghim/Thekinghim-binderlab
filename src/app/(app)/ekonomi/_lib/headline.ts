/**
 * Rubriken överst på Ekonomi: ett svar med siffror, räknat ur avstämningen och kassaflödet.
 */

import type { CashflowResult } from "@/analytics/cashflow";
import type { ReconciliationResult } from "@/analytics/reconciliation";
import { formatDate } from "@/lib/format";

import { isoToDate, periodShort, plural, sek, sentence, signedKr, type IsoPeriod } from "./view";

export interface Headline {
  readonly title: string;
  readonly aside: string;
}

/** Nästa väntade utbetalning enligt kassaflödets prognos. */
export function nextExpectedPayout(
  cash: CashflowResult | null,
): { date: string; amountOre: number; overdue: boolean } | null {
  const item = cash?.items
    .filter((i) => i.kind === "payout" && i.phase === "forecast")
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))[0];
  return item ? { date: item.date, amountOre: item.amountOre, overdue: item.overdue } : null;
}

export function economyHeadline(
  result: ReconciliationResult | null,
  cash: CashflowResult | null,
  period: IsoPeriod,
  today: string,
): Headline {
  const when = periodShort(period, today);
  if (!result || result.payouts.length === 0) {
    const next = nextExpectedPayout(cash);
    return {
      title: sentence(`Ingen utbetalning för ${when}`),
      aside: next
        ? `Nästa väntade utbetalning ${sek(next.amountOre)}, ${formatDate(isoToDate(next.date), {
            year: "auto",
            now: isoToDate(today),
          })}${next.overdue ? ", försenad" : ""}.`
        : "Utbetalningarna laddas upp som CSV från Awish.",
    };
  }
  const t = result.totals;
  const facts = `Utbetalt ${sek(t.actualOre)} mot väntade ${sek(t.expectedOre)} för ${when}, skillnad ${signedKr(
    t.differenceOre,
  )}.`;
  if (t.openDeviations > 0) {
    return {
      title: `${plural(t.openDeviations, "avvikelse", "avvikelser")} att utreda i utbetalningarna.`,
      aside: facts,
    };
  }
  return { title: "Utbetalningarna stämmer mot försäljningen.", aside: facts };
}
