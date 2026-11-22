/**
 * Pengar (G4): Resultat och "Från intäkt till vinst". Samma tal som Lönsamhet: vinsten,
 * intäkten och marginalen ur Lönsamhets modell, staplarna ur dess veckor/dagar och
 * vattenfallets steg ur bryggan plus resultAfterProfit (återbetalningar, gratis-pack, fasta
 * kostnader). Inget räknas på ett nytt sätt.
 */

import { periodDays } from "@/domain";
import "server-only";

import { profitability } from "@/domain";
import { chartUnitFor, compareText, type SearchParamsInput } from "@/components/shell/period-state";
import { loadContext, loadPeriod } from "@/server/data/core";
import { loadProfitAdjustments } from "@/server/data/adjustments";

import { resultAfterProfit } from "@/app/(app)/lonsamhet/_lib/result";

import { loadDaySales } from "./day-sales";
import { loadMoneyProfit, moneyKey } from "./money-base";
import { profitBars, waterfallRows, type ProfitBar, type WaterfallRow } from "./money-model";

export interface MoneyResult {
  /** "22 okt – 20 nov". */
  readonly periodLabel: string;
  readonly days: number;
  /** Periodens längd i dagar (som periodvalet). */
  readonly periodDays: number;
  readonly profitOre: number;
  readonly profitLabel: string;
  readonly revenueOre: number;
  readonly marginBp: number | null;
  readonly profitPerDayOre: number | null;
  readonly deltaBp: number | null;
  readonly deltaOre: number | null;
  /** "mot förra 30 dagarna", "mot dagen innan". */
  readonly compareText: string | null;
  /**
   * Staplarnas upplösning efter periodens längd (chartUnitFor). "hour": en dag, staplarna är
   * intäkten per timme (vinst per timme räknas inte, hyra och andel hör till dagen).
   */
  readonly unit: "hour" | "day" | "week" | "month" | null;
  readonly bars: readonly ProfitBar[];
  /** Var n:e stapel får en etikett under (alla vid få staplar, var 3:e timme). */
  readonly labelStep: number;
  readonly best: { readonly label: string; readonly profitOre: number } | null;
  readonly orders: number;
}

export interface MoneyWaterfall {
  readonly rows: readonly WaterfallRow[];
  /** Order utan inköpspris ingår inte (intäkt, öre). */
  readonly unpricedRevenueOre: number;
}

export async function loadMoneyResult(sp: SearchParamsInput): Promise<MoneyResult | null> {
  const [data, p, ctx] = await Promise.all([
    loadMoneyProfit(moneyKey(sp)),
    loadPeriod(sp),
    loadContext(),
  ]);
  if (!data) return null;
  const { model } = data;
  const kpi = new Map(model.kpis.map((k) => [k.id, k]));
  const profit = kpi.get("profit");
  // I dag jämförs inte med hela i går (en halv dag mot en hel ser ut som ett ras); Hem har
  // "i går samma tid" ur takten.
  const prevProfit = p.key !== "idag" ? (profit?.previous ?? null) : null;
  const unit = chartUnitFor(p.days);
  let bars: ProfitBar[];
  if (unit === "hour") {
    const day = await loadDaySales(sp);
    bars = day.sales.hours.map((h) => ({
      key: String(h.hour),
      label: String(h.hour).padStart(2, "0"),
      profitOre: h.revenueOre,
      partial: false,
      partialText: null,
      paceOre: null,
    }));
  } else if (unit === "month") {
    const months = model.trend.month.buckets;
    bars = profitBars(months, "day", ctx.today);
    // Korta månadsnamn ("jan", "apr"); året bara på första etiketten och där året byts.
    const step = labelStepFor(unit, bars.length);
    let lastYear = "";
    bars = bars.map((b, i) => {
      const start = months[i]?.start ?? "";
      const year = start.slice(0, 4);
      const mon = MONTHS[Number(start.slice(5, 7)) - 1] ?? b.label;
      const shown = i % step === 0;
      const withYear = shown && year !== lastYear;
      if (shown) lastYear = year;
      return { ...b, label: withYear ? `${mon} ’${year.slice(2)}` : mon };
    });
  } else {
    bars = profitBars(model.trend[unit].buckets, unit, ctx.today);
  }
  const best = (unit === "hour" ? [] : bars).reduce<ProfitBar | null>(
    (b, x) => (!x.partial && (b === null || x.profitOre > b.profitOre) ? x : b),
    null,
  );
  return {
    periodLabel: model.periodLabel,
    days: model.days,
    // Samma N som periodvalet ("30 dagar"), inte bara dagarna med data.
    periodDays: periodDays(p.period),
    profitOre: model.bridge.profitOre,
    profitLabel: model.bridge.profitLabel,
    revenueOre: model.bridge.revenueOre,
    marginBp: model.bridge.marginBp,
    profitPerDayOre: model.days > 0 ? Math.round(model.bridge.profitOre / model.days) : null,
    deltaBp:
      prevProfit !== null && profit?.delta != null ? Math.round(profit.delta * 10_000) : null,
    deltaOre: prevProfit !== null ? model.bridge.profitOre - prevProfit : null,
    compareText: prevProfit !== null ? (compareText(p.resolved) ?? "mot förra perioden") : null,
    unit: bars.length > 0 ? unit : null,
    bars,
    labelStep: labelStepFor(unit, bars.length),
    best: best && best.profitOre > 0 ? { label: best.label, profitOre: best.profitOre } : null,
    orders: model.orders,
  };
}

export async function loadMoneyWaterfall(sp: SearchParamsInput): Promise<MoneyWaterfall | null> {
  const data = await loadMoneyProfit(moneyKey(sp));
  if (!data) return null;
  const { model, input, organization, p } = data;
  const adjustments = await loadProfitAdjustments(p.period);
  const result = resultAfterProfit({
    current: input.current,
    organization: organization.current,
    refunds: adjustments.refunds,
    fixedCosts: adjustments.fixedCosts,
    freePacks: adjustments.freePacks,
    scope: p.scope,
    machines: input.machines.map((m) => ({ id: m.id, name: m.code || m.name })),
  });
  const b = model.bridge;
  // Butikerna med andel i perioden (samma liggare som vattenfallet).
  const stores = profitability(input.current, "store").rows.filter(
    (r) => r.kind === "item" && r.compensationOre !== 0,
  ).length;
  return {
    rows: waterfallRows({
      revenueOre: b.revenueOre,
      unpricedRevenueOre: b.unpricedRevenueOre,
      vmbVatOre: b.vmbVatOre,
      costOre: b.costOre,
      feesOre: b.feesOre,
      profitBeforeShareOre: b.profitBeforeShareOre,
      compensationOre: b.compensationOre,
      refundOre: result.refundOre,
      freePackOre: result.freePackOre,
      fixedCostOre: result.fixedCostOre,
      cardFeeBp: input.settings.cardFeeBp,
      stores,
    }),
    unpricedRevenueOre: b.unpricedRevenueOre,
  };
}

const MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
] as const;

/** Var n:e etikett under staplarna: var 3:e timme, högst 8 etiketter vid många staplar. */
export function labelStepFor(unit: "hour" | "day" | "week" | "month", bars: number): number {
  if (unit === "hour") return 3;
  return bars > 8 ? Math.ceil(bars / 8) : 1;
}
