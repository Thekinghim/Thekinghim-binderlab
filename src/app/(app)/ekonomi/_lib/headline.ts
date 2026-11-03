/**
 * Rubriken överst på Ekonomi: ett svar med siffror, räknat ur avstämningen och kassaflödet.
 */

import type { CashflowResult } from "@/analytics/cashflow";
import type { ReconciliationResult } from "@/analytics/reconciliation";
import { formatDate } from "@/lib/format";

import {
  isoToDate,
  periodShort,
  periodText,
  plural,
  sek,
  sentence,
  signedSek,
  type IsoPeriod,
} from "./view";

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

/** "Nästa utbetalning 74 625 kr, 3 nov." eller, försenad, "74 625 kr väntades 2 nov. Har inte kommit." */
export function nextPayoutText(
  next: { date: string; amountOre: number; overdue: boolean },
  today: string,
): string {
  const day = formatDate(isoToDate(next.date), { year: "auto", now: isoToDate(today) });
  return next.overdue
    ? `${sentence(`${sek(next.amountOre)} väntades ${day}`)} Har inte kommit.`
    : sentence(`Nästa utbetalning ${sek(next.amountOre)}, ${day}`);
}

/** "i oktober 2026" för en hel kalendermånad, annars "4 okt. – 2 nov.". */
function coveredText(p: IsoPeriod, today: string): string {
  const [y, m] = p.start.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const fullMonth =
    p.start.endsWith("-01") &&
    p.end.slice(0, 7) === p.start.slice(0, 7) &&
    Number(p.end.slice(8)) === lastDay;
  return fullMonth ? `i ${periodText(p)}` : periodShort(p, today);
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

/** Utan källa för utbetalningar: en neutral rad, inga väntade eller saknade utbetalningar. */
export const NO_PAYOUT_SOURCE_TEXT = "Ladda upp filen från Awish.";

/**
 * `payoutsTracked` = det finns en källa för utbetalningar (en inläst utbetalning eller fil).
 * Utan den visas varken väntade eller saknade utbetalningar, bara en neutral rad.
 */
export function economyHeadline(
  result: ReconciliationResult | null,
  cash: CashflowResult | null,
  period: IsoPeriod,
  today: string,
  payoutsTracked = true,
): Headline {
  const when = periodShort(period, today);
  if (!result || result.payouts.length === 0) {
    if (!payoutsTracked) {
      return { title: "Inga utbetalningar inlästa.", aside: NO_PAYOUT_SOURCE_TEXT };
    }
    const next = nextExpectedPayout(cash);
    return {
      title: sentence(`Ingen utbetalning för ${when}`),
      aside: next ? nextPayoutText(next, today) : NO_PAYOUT_SOURCE_TEXT,
    };
  }
  const t = result.totals;
  // Utbetalningarnas egen försäljningsperiod (t.ex. 1–31 okt.), inte den valda perioden:
  // utbetalningen för oktober kan komma in 2 nov. och räknas då till "30 d" fast den gäller
  // en annan period än Hem visar för samma 30 dagar.
  const covered = payoutSpan(result);
  const diff = t.differenceOre === 0 ? "" : ` Skillnad ${signedSek(t.differenceOre)}.`;
  const facts = `${sentence(
    `Utbetalt ${sek(t.actualOre)} av ${sek(t.expectedOre)} för ${coveredText(covered, today).replace(/^i /, "")}`,
  )}${diff}`;
  if (t.openDeviations > 0) {
    return {
      title: `${plural(t.openDeviations, "avvikelse", "avvikelser")} att utreda.`,
      aside: facts,
    };
  }
  return { title: "Utbetalningarna stämmer.", aside: facts };
}

/**
 * Rubriken på Bokföring: nästa månad att skicka ("Oktober 2026 klar att skicka."), annars
 * läget. `nextName` är månadens namn med stor bokstav.
 */
export function bookkeepingTitle(
  months: readonly { readonly status: "open" | "closed" | "sent" }[],
  nextName: string,
): string {
  if (months.some((m) => m.status === "closed")) return `${nextName} klar att skicka.`;
  return months.some((m) => m.status === "sent") ? "Allt är skickat." : "Inget att skicka ännu.";
}
