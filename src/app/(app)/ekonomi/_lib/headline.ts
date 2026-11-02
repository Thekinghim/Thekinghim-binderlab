/**
 * Rubriken överst på Ekonomi: ett svar med siffror, räknat ur avstämningen och kassaflödet.
 */

import type { CashflowResult } from "@/analytics/cashflow";
import type { ReconciliationResult } from "@/analytics/reconciliation";
import { formatDate } from "@/lib/format";

import { isoToDate, periodShort, plural, sek, sentence, signedSek, type IsoPeriod } from "./view";

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
  // En försenad utbetalning ligger i kassaflödet på i morgon; rubriken visar dagen den väntades.
  return item
    ? { date: item.dueDate ?? item.date, amountOre: item.amountOre, overdue: item.overdue }
    : null;
}

/** "Nästa väntade utbetalning 74 625 kr, 3 nov." eller, försenad, "… väntades 2 nov. och har inte kommit". */
export function nextPayoutText(
  next: { date: string; amountOre: number; overdue: boolean },
  today: string,
): string {
  const day = formatDate(isoToDate(next.date), { year: "auto", now: isoToDate(today) });
  return next.overdue
    ? `Utbetalningen på ${sek(next.amountOre)} som väntades ${day} har inte kommit.`
    : `Nästa väntade utbetalning ${sek(next.amountOre)}, ${day}.`;
}

/** Från första utbetalningens första dag till sista utbetalningens sista dag. */
export function payoutSpan(result: ReconciliationResult): IsoPeriod {
  let start = result.payouts[0]!.period.start;
  let end = result.payouts[0]!.period.end;
  for (const p of result.payouts) {
    if (p.period.start < start) start = p.period.start;
    if (p.period.end > end) end = p.period.end;
  }
  return { start, end };
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
        ? nextPayoutText(next, today)
        : "Utbetalningarna laddas upp som CSV från Awish.",
    };
  }
  const t = result.totals;
  // Utbetalningarnas egen försäljningsperiod (t.ex. 1–31 okt.), inte den valda perioden:
  // utbetalningen för oktober kan komma in 2 nov. och räknas då till "30 d" fast den gäller
  // en annan period än Hem visar för samma 30 dagar.
  const covered = payoutSpan(result);
  const facts = `Utbetalt ${sek(t.actualOre)} mot väntade ${sek(t.expectedOre)} för försäljningen ${periodShort(
    covered,
    today,
  )} (${plural(result.payouts.length, "utbetalning", "utbetalningar")}), skillnad ${signedSek(
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
