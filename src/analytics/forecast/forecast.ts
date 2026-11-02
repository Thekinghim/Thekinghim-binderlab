/**
 * Försäljningsprognos per titel × automat för de kommande veckorna (standard 4), med
 * osäkerhetsintervall, backtest och komponenter som förklarar varje siffra.
 *
 * Regler:
 * - **Serier.** En serie är en titel i en automat som sålt minst en gång under historiken
 *   (standard 8 veckor t.o.m. `asOf`) och vars automat är i drift dagen efter `asOf`.
 *   Order utan automat räknas inte.
 * - **Dagar med data.** Före seriens första försäljning, utanför automatens drifttid och på
 *   dagar i `unavailable` (slutsålt) räknas dagen inte alls (se model.ts).
 * - **Antal.** Modellen i model.ts: veckodagsjusterat, viktat glidande medel med trend.
 *   Efter automatens sista driftdag är prognosen 0.
 * - **Intäkt** = antal × snittpris exkl. moms, avrundat per dag. Snittpriset är seriens
 *   snitt de senaste 28 dagarna; saknas order där används seriens hela historik, sedan
 *   titelns snitt i alla automater de senaste 28 dagarna.
 * - **Osäkerhet.** Dagsvariansen är den största av backtestens residualvarians och
 *   prognosen själv (Poisson-golv: slumpen i ett litet antal köp). För en summa över k dagar
 *   är variansen k × dagsvariansen; för flera serier summeras varianserna (oberoende).
 *   Intervallet är summan ± z × √varians (z = 1,282 för 80 %), nedre gränsen minst 0.
 * - **Träffsäkerhet** mäts med backtest på rullande ursprung (backtest.ts).
 */

import {
  addDays,
  assertIsoDate,
  daysBetween,
  DomainError,
  roundHalfUp,
  vatOfGross,
  type IsoDate,
  type OrderLine,
  type Period,
} from "@/domain";
import { isMachineActive, machineNames, titleNames } from "../todos/common";
import { pct, periodText } from "../todos/text";
import type { MachineRef } from "../todos/types";
import { accuracyMetrics, backtestHistory, residualVariance } from "./backtest";
import {
  approxKr,
  assertIntAtLeast,
  factorText,
  fig,
  isqrtRound,
  MILLI,
  packs,
  packsOneDecimal,
  planEvidence,
  seriesKey,
  signedPacksOneDecimal,
  type PlanEvidence,
  type PlanFigure,
} from "./common";
import { fitModel, predictDay, type DailyHistory, type ModelSettings } from "./model";
import type {
  AccuracyMetrics,
  AggregateForecast,
  BacktestOrigin,
  BacktestPoint,
  ForecastAccuracy,
  ForecastComponents,
  ForecastDay,
  ForecastInput,
  ForecastOptions,
  ForecastResult,
  ForecastTotal,
  PriceSource,
  SeriesBacktest,
  SeriesForecast,
} from "./types";

/** Standardvärden för prognosen. */
export const FORECAST_DEFAULTS = {
  horizonDays: 28,
  historyWeeks: 8,
  weekdayPriorDays: 2,
  maxTrendBp: 3_000,
  trendMinDaysPerHalf: 7,
  trendMinUnits: 10,
  minHistoryDays: 14,
  intervalCoverageBp: 8_000,
  priceWindowDays: 28,
  backtestOrigins: 6,
  backtestHorizonDays: 7,
  backtestStepDays: 7,
} as const satisfies Required<ForecastOptions>;

/** z-värden (i tusendelar) för de täckningar som stöds, normalfördelning. */
export const Z_BY_COVERAGE_BP: Readonly<Record<number, number>> = {
  5_000: 674,
  8_000: 1_282,
  9_000: 1_645,
  9_500: 1_960,
  9_900: 2_576,
};

type ResolvedOptions = { -readonly [K in keyof Required<ForecastOptions>]: number } & {
  zMilli: number;
};

/** Standardvärden plus angivna inställningar, kontrollerade. */
export function resolveForecastOptions(options: ForecastOptions = {}): ResolvedOptions {
  const o = { ...FORECAST_DEFAULTS, ...stripUndefined(options) };
  assertIntAtLeast(o.horizonDays, 1, "Prognosens längd i dagar");
  assertIntAtLeast(o.historyWeeks, 1, "Antal veckor historik");
  assertIntAtLeast(o.weekdayPriorDays, 0, "Krympningen av veckodagsfaktorerna");
  assertIntAtLeast(o.maxTrendBp, 0, "Största trendeffekt");
  assertIntAtLeast(o.trendMinDaysPerHalf, 0, "Minsta antal dagar för trend");
  assertIntAtLeast(o.trendMinUnits, 0, "Minsta antal pack för trend");
  assertIntAtLeast(o.minHistoryDays, 0, "Minsta antal dagar med data");
  assertIntAtLeast(o.priceWindowDays, 1, "Fönstret för snittpris");
  assertIntAtLeast(o.backtestOrigins, 0, "Antal ursprung i backtesten");
  assertIntAtLeast(o.backtestHorizonDays, 1, "Backtestens längd i dagar");
  assertIntAtLeast(o.backtestStepDays, 1, "Steget mellan backtestens ursprung");
  const zMilli = Z_BY_COVERAGE_BP[o.intervalCoverageBp];
  if (zMilli === undefined) {
    throw new DomainError(
      "invalid_input",
      `Intervallets täckning måste vara en av ${Object.keys(Z_BY_COVERAGE_BP).join(", ")} bp, fick ${o.intervalCoverageBp}.`,
    );
  }
  return { ...o, zMilli };
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Nettointäkt (exkl. moms) för en order. */
function netOre(o: OrderLine, vatRateBp: number): number {
  return o.amountOre - vatOfGross(o.amountOre, vatRateBp);
}

/** Text för horisonten: "4 veckor" eller "10 dagar". */
export function horizonText(days: number): string {
  if (days % 7 === 0) return days === 7 ? "veckan" : `${days / 7} veckor`;
  return `${days} dagar`;
}

/** Ett intervall i text: "35–50". */
function rangeText(lowMilli: number, highMilli: number): string {
  return `${packs(lowMilli)}–${packs(highMilli)}`;
}

// ---------------------------------------------------------------------------
// Intervall
// ---------------------------------------------------------------------------

/** En series bidrag till en summa: antal, intäkt och varians för dagarna i summan. */
interface Part {
  readonly unitsMilli: number;
  readonly revenueOre: number;
  /** Dagsvarians × antal aktiva dagar (milli²). */
  readonly varianceMilli2: bigint;
  /** Dagsvarians × antal aktiva dagar × snittpris² (milli² × öre²). */
  readonly revenueVariance: bigint;
}

/** Summa med intervall: summa ± z × √(Σ varians). */
function totalOf(parts: readonly Part[], period: Period, days: number, zMilli: number): ForecastTotal {
  let units = 0;
  let revenue = 0;
  let v = 0n;
  let rv = 0n;
  for (const p of parts) {
    units += p.unitsMilli;
    revenue += p.revenueOre;
    v += p.varianceMilli2;
    rv += p.revenueVariance;
  }
  const z = BigInt(zMilli);
  const halfUnits = roundHalfUp(z * isqrtRound(v), 1_000n);
  const halfRevenue = roundHalfUp(z * isqrtRound(rv), 1_000_000n);
  return {
    period,
    days,
    unitsMilli: units,
    unitsLowMilli: Math.max(0, units - halfUnits),
    unitsHighMilli: units + halfUnits,
    revenueOre: revenue,
    revenueLowOre: Math.max(0, revenue - halfRevenue),
    revenueHighOre: revenue + halfRevenue,
  };
}

/** Det som behövs för en series bidrag till en summa. */
interface SeriesDays {
  readonly days: readonly ForecastDay[];
  /** Aktiv dag i horisonten (automaten i drift). */
  readonly active: readonly boolean[];
  readonly dayVarianceMilli2: number;
  readonly avgPriceOre: number;
}

/** Intern arbetsdata för en serie. */
interface SeriesWork extends SeriesDays {
  readonly forecast: SeriesForecast;
  readonly backtest: SeriesBacktest;
}

/** Bidraget från serien för horisontens dagar [from, to] (0-baserat, inklusive). */
function partOf(w: SeriesDays, from: number, to: number): Part {
  let units = 0;
  let revenue = 0;
  let k = 0;
  for (let i = from; i <= to; i++) {
    const d = w.days[i];
    if (!d) continue;
    units += d.unitsMilli;
    revenue += d.revenueOre;
    if (w.active[i]) k += 1;
  }
  const v = BigInt(w.dayVarianceMilli2) * BigInt(k);
  const price = BigInt(w.avgPriceOre);
  return { unitsMilli: units, revenueOre: revenue, varianceMilli2: v, revenueVariance: v * price * price };
}

/** Rullande veckor (7 dagar) i horisonten; sista veckan kan vara kortare. */
function weekRanges(asOf: IsoDate, horizonDays: number): Array<{ from: number; to: number; period: Period }> {
  const out: Array<{ from: number; to: number; period: Period }> = [];
  for (let from = 0; from < horizonDays; from += 7) {
    const to = Math.min(horizonDays - 1, from + 6);
    out.push({ from, to, period: { start: addDays(asOf, from + 1), end: addDays(asOf, to + 1) } });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Huvudfunktion
// ---------------------------------------------------------------------------

/**
 * Prognos för intäkt och antal per titel × automat, per titel, per automat och totalt,
 * för `horizonDays` dagar efter `asOf`, med intervall, komponenter, backtest och underlag.
 */
export function forecastSales(input: ForecastInput): ForecastResult {
  assertIsoDate(input.asOf, "Prognosens utgångsdag");
  const o = resolveForecastOptions(input.options);
  const asOf = input.asOf;
  const vat = input.settings.vatRateBp;
  const titleName = titleNames(input.titles ?? []);
  const machineName = machineNames(input.machines ?? []);
  const machines = new Map<string, MachineRef>((input.machines ?? []).map((m) => [m.id, m]));
  const active = (machineId: string, date: IsoDate): boolean => {
    const m = machines.get(machineId);
    return m ? isMachineActive(m, date) : true;
  };
  const unavailable = new Set<string>();
  for (const u of input.unavailable ?? []) {
    assertIsoDate(u.date, "Dag utan försäljning");
    unavailable.add(`${seriesKey(u.machineId, u.titleId)}\u0000${u.date}`);
  }

  const model: ModelSettings = {
    historyWeeks: o.historyWeeks,
    weekdayPriorDays: o.weekdayPriorDays,
    maxTrendBp: o.maxTrendBp,
    trendMinDaysPerHalf: o.trendMinDaysPerHalf,
    trendMinUnits: o.trendMinUnits,
  };
  const span = 7 * o.historyWeeks;
  const length =
    span + o.backtestHorizonDays + Math.max(0, o.backtestOrigins - 1) * o.backtestStepDays;
  const rangeStart = addDays(asOf, -(length - 1));
  const historyStart = addDays(asOf, -(span - 1));
  const priceStart = addDays(asOf, -(o.priceWindowDays - 1));
  const endIndex = length - 1;
  const horizon: Period = { start: addDays(asOf, 1), end: addDays(asOf, o.horizonDays) };

  // Gruppera order per serie (bara order t.o.m. asOf).
  let ordersWithoutMachine = 0;
  const bySeries = new Map<string, OrderLine[]>();
  const titlePrice = new Map<string, { net: number; n: number }>();
  for (const order of input.orders) {
    assertIsoDate(order.businessDate, `Datum för order ${order.id}`);
    if (order.businessDate > asOf) continue;
    if (order.machineId === null) {
      ordersWithoutMachine += 1;
      continue;
    }
    const key = seriesKey(order.machineId, order.titleId);
    const list = bySeries.get(key);
    if (list) list.push(order);
    else bySeries.set(key, [order]);
    if (order.businessDate >= priceStart) {
      const t = titlePrice.get(order.titleId) ?? { net: 0, n: 0 };
      t.net += netOre(order, vat);
      t.n += 1;
      titlePrice.set(order.titleId, t);
    }
  }

  const works: SeriesWork[] = [];
  const keys = [...bySeries.keys()].sort();
  for (const key of keys) {
    const orders = bySeries.get(key)!;
    const { machineId, titleId } = orders[0]! as { machineId: string; titleId: string };
    if (!orders.some((x) => x.businessDate >= historyStart)) continue;
    if (!active(machineId, horizon.start)) continue;

    let firstDate = orders[0]!.businessDate;
    for (const x of orders) if (x.businessDate < firstDate) firstDate = x.businessDate;

    // Daglig historik.
    const units = new Array<number>(length).fill(0);
    const available = new Array<boolean>(length).fill(false);
    const excludedDates: IsoDate[] = [];
    for (let i = 0; i < length; i++) {
      const date = addDays(rangeStart, i);
      const ok =
        date >= firstDate &&
        active(machineId, date) &&
        !unavailable.has(`${key}\u0000${date}`);
      available[i] = ok;
      if (!ok && date >= historyStart && date >= firstDate) excludedDates.push(date);
    }
    const historyOrderIds: string[] = [];
    let seriesNet = 0;
    let seriesN = 0;
    let windowNet = 0;
    let windowN = 0;
    for (const x of orders) {
      const net = netOre(x, vat);
      seriesNet += net;
      seriesN += 1;
      if (x.businessDate >= priceStart) {
        windowNet += net;
        windowN += 1;
      }
      if (x.businessDate < rangeStart) continue;
      const i = daysBetween(rangeStart, x.businessDate);
      units[i] = units[i]! + 1;
      if (x.businessDate >= historyStart && available[i]) historyOrderIds.push(x.id);
    }
    const history: DailyHistory = { start: rangeStart, units, available };
    const comps = fitModel(history, endIndex, model);
    if (!comps) continue;

    // Snittpris.
    let avgPriceOre = 0;
    let priceSource: PriceSource = "none";
    const tp = titlePrice.get(titleId);
    if (windowN > 0) {
      avgPriceOre = roundHalfUp(windowNet, windowN);
      priceSource = "series";
    } else if (seriesN > 0) {
      avgPriceOre = roundHalfUp(seriesNet, seriesN);
      priceSource = "series-history";
    } else if (tp && tp.n > 0) {
      avgPriceOre = roundHalfUp(tp.net, tp.n);
      priceSource = "title";
    }

    // Prognos per dag.
    const days: ForecastDay[] = [];
    const activeDays: boolean[] = [];
    let sumMilli = 0;
    for (let h = 1; h <= o.horizonDays; h++) {
      const p = predictDay(comps, h, o.maxTrendBp);
      const isActive = active(machineId, p.date);
      const unitsMilli = isActive ? p.unitsMilli : 0;
      activeDays.push(isActive);
      sumMilli += unitsMilli;
      days.push({
        date: p.date,
        weekday: p.weekday,
        baseMilli: isActive ? p.baseMilli : 0,
        trendMilli: isActive ? p.trendMilli : 0,
        factorBp: p.factorBp,
        unitsMilli,
        revenueOre: roundHalfUp(unitsMilli * avgPriceOre, MILLI),
      });
    }

    // Backtest och varians.
    const bt = backtestHistory(history, endIndex, model, {
      origins: o.backtestOrigins,
      horizonDays: o.backtestHorizonDays,
      stepDays: o.backtestStepDays,
    });
    const metrics = accuracyMetrics(bt.points, bt.origins);
    const resVar = residualVariance(bt.points);
    const activeCount = activeDays.filter(Boolean).length;
    const poissonVar = activeCount > 0 ? roundHalfUp(sumMilli * MILLI, activeCount) : 0;
    const useResiduals = resVar !== null && resVar > poissonVar;
    const dayVar = useResiduals ? resVar : poissonVar;

    const backtest: SeriesBacktest = {
      key,
      titleId,
      machineId,
      origins: bt.origins,
      points: bt.points,
      metrics,
    };

    const draft: Omit<SeriesForecast, "weeks" | "total" | "text" | "explanation" | "evidence"> = {
      key,
      titleId,
      machineId,
      status: comps.availableDays >= o.minHistoryDays ? "ok" : "low-data",
      components: comps,
      avgPriceOre,
      priceSource,
      dayVarianceMilli2: dayVar,
      varianceSource: useResiduals ? "residuals" : "poisson",
      days,
      accuracy: metrics,
    };
    const tmp: SeriesDays = { days, active: activeDays, dayVarianceMilli2: dayVar, avgPriceOre };
    const weeks = weekRanges(asOf, o.horizonDays).map((r) =>
      totalOf([partOf(tmp, r.from, r.to)], r.period, r.to - r.from + 1, o.zMilli),
    );
    const total = totalOf([partOf(tmp, 0, o.horizonDays - 1)], horizon, o.horizonDays, o.zMilli);

    const tName = titleName(titleId);
    const mName = machineName(machineId);
    const coverage = pct(o.intervalCoverageBp);
    const text =
      `${tName} i ${mName}: ${approxKr(total.revenueOre)} och ca ${packs(total.unitsMilli)} pack ` +
      `kommande ${horizonText(o.horizonDays)} (${coverage}-intervall: ${rangeText(total.unitsLowMilli, total.unitsHighMilli)} pack).`;
    const explanation = explainComponents(comps, avgPriceOre, priceSource, o.historyWeeks);
    const evidence = planEvidence({
      rule:
        `Prognos = nivå (viktat glidande medel av ${o.historyWeeks} veckor, veckodagsjusterat) + trend, ` +
        `× veckodagsfaktor; intäkt = antal × snittpris exkl. moms. Intervall: ±${packsOneDecimal(o.zMilli)} × √varians ` +
        `(${useResiduals ? "backtestens residualer" : "Poisson-golv"}).`,
      period: comps.history,
      orderIds: historyOrderIds,
      dates: excludedDates,
      titleIds: [titleId],
      machineIds: [machineId],
      figures: [
        fig("levelMilli", "Nivå, pack per dag", comps.levelMilli, "milli"),
        fig("trendMilliPerWeek", "Trend, pack per dag och vecka", comps.trendMilliPerWeek, "milli"),
        ...comps.weekdayFactorsBp.map((f, i) =>
          fig(`weekdayFactor${i + 1}`, `Veckodagsfaktor ${WEEKDAY_SHORT[i]}`, f, "bp"),
        ),
        fig("historyUnits", "Sålda pack i historiken", comps.units, "packs"),
        fig("availableDays", "Dagar med data", comps.availableDays, "days"),
        fig("excludedDays", "Dagar som inte räknades", comps.excludedDays, "days"),
        fig("avgPriceOre", "Snittpris exkl. moms", avgPriceOre, "ore"),
        fig("forecastUnitsMilli", "Prognos, pack", total.unitsMilli, "milli"),
        fig("forecastLowMilli", "Prognos, nedre gräns", total.unitsLowMilli, "milli"),
        fig("forecastHighMilli", "Prognos, övre gräns", total.unitsHighMilli, "milli"),
        fig("forecastRevenueOre", "Prognos, intäkt", total.revenueOre, "ore"),
        ...accuracyFigures(metrics),
      ],
    });

    works.push({
      ...tmp,
      forecast: { ...draft, weeks, total, text, explanation, evidence },
      backtest,
    });
  }

  const ranges = weekRanges(asOf, o.horizonDays);
  const aggregate = (
    key: string,
    group: readonly SeriesWork[],
    label: (t: ForecastTotal) => string,
  ): AggregateForecast => {
    const days = Array.from({ length: o.horizonDays }, (_, i) => {
      let u = 0;
      let r = 0;
      for (const w of group) {
        u += w.forecast.days[i]?.unitsMilli ?? 0;
        r += w.forecast.days[i]?.revenueOre ?? 0;
      }
      return { date: addDays(asOf, i + 1), unitsMilli: u, revenueOre: r };
    });
    const weeks = ranges.map((r) =>
      totalOf(group.map((w) => partOf(w, r.from, r.to)), r.period, r.to - r.from + 1, o.zMilli),
    );
    const total = totalOf(
      group.map((w) => partOf(w, 0, o.horizonDays - 1)),
      horizon,
      o.horizonDays,
      o.zMilli,
    );
    let dayVar = 0;
    for (const w of group) dayVar += w.forecast.dayVarianceMilli2;
    return {
      key,
      seriesKeys: group.map((w) => w.forecast.key),
      days,
      weeks,
      total,
      dayVarianceMilli2: dayVar,
      text: label(total),
      evidence: planEvidence({
        rule: "Summan av seriernas prognoser. Intervallet räknas på summan av seriernas varianser (serierna antas oberoende).",
        period: horizon,
        titleIds: group.map((w) => w.forecast.titleId),
        machineIds: group.map((w) => w.forecast.machineId),
        figures: totalFigures(total, group.length),
      }),
    };
  };

  const coverage = pct(o.intervalCoverageBp);
  const groupBy = (pick: (w: SeriesWork) => string): Map<string, SeriesWork[]> => {
    const m = new Map<string, SeriesWork[]>();
    for (const w of works) {
      const k = pick(w);
      const list = m.get(k);
      if (list) list.push(w);
      else m.set(k, [w]);
    }
    return m;
  };
  const byRevenue = (a: AggregateForecast, b: AggregateForecast): number =>
    b.total.revenueOre - a.total.revenueOre || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

  const byTitle = [...groupBy((w) => w.forecast.titleId)]
    .map(([id, group]) =>
      aggregate(
        id,
        group,
        (t) =>
          `${titleName(id)}: ${approxKr(t.revenueOre)} och ca ${packs(t.unitsMilli)} pack kommande ` +
          `${horizonText(o.horizonDays)} i ${group.length === 1 ? "1 automat" : `${group.length} automater`} ` +
          `(${coverage}-intervall: ${krRange(t)}).`,
      ),
    )
    .sort(byRevenue);
  const byMachine = [...groupBy((w) => w.forecast.machineId)]
    .map(([id, group]) =>
      aggregate(
        id,
        group,
        (t) =>
          `${machineName(id)}: ${approxKr(t.revenueOre)} och ca ${packs(t.unitsMilli)} pack kommande ` +
          `${horizonText(o.horizonDays)} (${coverage}-intervall: ${krRange(t)}).`,
      ),
    )
    .sort(byRevenue);
  const total = aggregate(
    "total",
    works,
    (t) =>
      `Prognos kommande ${horizonText(o.horizonDays)} (${periodText(horizon)}): ${approxKr(t.revenueOre)} ` +
      `(${coverage}-intervall: ${krRange(t)}), ca ${packs(t.unitsMilli)} pack.`,
  );

  const backtests = works.map((w) => w.backtest);
  return {
    asOf,
    horizon,
    series: works.map((w) => w.forecast),
    byTitle,
    byMachine,
    total,
    accuracy: overallAccuracy(backtests, o.backtestHorizonDays, o.backtestStepDays),
    backtests,
    ordersWithoutMachine,
  };
}

const WEEKDAY_SHORT = ["mån", "tis", "ons", "tor", "fre", "lör", "sön"] as const;
const WEEKDAY_LONG = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"] as const;

/** Intervall i kronor: "16 900–19 900 kr". */
function krRange(t: ForecastTotal): string {
  const lo = approxKr(t.revenueLowOre).replace(/^ca /, "").replace(/ kr$/, "");
  const hi = approxKr(t.revenueHighOre).replace(/^ca /, "");
  return `${lo}–${hi}`;
}

/**
 * Komponenterna i en mening: "Nivå 1,5 pack/dag (viktat snitt av 8 veckor), trend +0,1 pack/dag
 * per vecka, starkast lördag (1,4×), svagast tisdag (0,7×). Snittpris 49,00 kr. 3 dagar räknades inte."
 */
export function explainComponents(
  c: ForecastComponents,
  avgPriceOre: number,
  priceSource: PriceSource,
  historyWeeks: number,
): string {
  const parts: string[] = [];
  parts.push(
    `Nivå ${packsOneDecimal(c.levelMilli)} pack/dag (viktat snitt av ${historyWeeks} ${historyWeeks === 1 ? "vecka" : "veckor"}, senaste veckan väger mest)`,
  );
  if (c.trendApplied) {
    parts.push(`trend ${signedPacksOneDecimal(c.trendMilliPerWeek)} pack/dag per vecka`);
  } else {
    parts.push("ingen trend");
  }
  let maxI = 0;
  let minI = 0;
  c.weekdayFactorsBp.forEach((f, i) => {
    if (f > c.weekdayFactorsBp[maxI]!) maxI = i;
    if (f < c.weekdayFactorsBp[minI]!) minI = i;
  });
  if (c.weekdayFactorsBp[maxI] !== c.weekdayFactorsBp[minI]) {
    parts.push(
      `starkast ${WEEKDAY_LONG[maxI]} (${factorText(c.weekdayFactorsBp[maxI]!)}×), svagast ${WEEKDAY_LONG[minI]} (${factorText(c.weekdayFactorsBp[minI]!)}×)`,
    );
  }
  let text = `${parts.join(", ")}.`;
  if (priceSource === "none") text += " Snittpris saknas, intäkten räknas som 0.";
  else {
    const kronor = Math.floor(avgPriceOre / 100);
    const ore = avgPriceOre - kronor * 100;
    const src =
      priceSource === "series"
        ? "senaste 28 dagarna"
        : priceSource === "series-history"
          ? "hela historiken"
          : "titelns snitt i alla automater";
    text += ` Snittpris ${kronor},${String(ore).padStart(2, "0")} kr (${src}).`;
  }
  if (c.excludedDays > 0) {
    text += ` ${c.excludedDays} ${c.excludedDays === 1 ? "dag" : "dagar"} utan data räknades inte (slutsålt, ur drift eller före första försäljningen).`;
  }
  if (c.trendNote) text += ` ${c.trendNote}`;
  return text;
}

function accuracyFigures(m: AccuracyMetrics): PlanFigure[] {
  const out: PlanFigure[] = [];
  if (m.wapeBp !== null) out.push(fig("wapeBp", "Fel per dag (WAPE)", m.wapeBp, "bp"));
  if (m.mapeBp !== null) out.push(fig("mapeBp", "Fel per vecka (MAPE)", m.mapeBp, "bp"));
  if (m.biasBp !== null) out.push(fig("biasBp", "Bias (positivt = för hög)", m.biasBp, "bp"));
  if (m.naiveWapeBp !== null)
    out.push(fig("naiveWapeBp", "Fel för förra veckans snitt (WAPE)", m.naiveWapeBp, "bp"));
  out.push(fig("backtestPoints", "Jämförda dagar", m.points, "days"));
  return out;
}

function totalFigures(t: ForecastTotal, series: number): PlanFigure[] {
  return [
    fig("series", "Serier (titel × automat)", series, "count"),
    fig("forecastUnitsMilli", "Prognos, pack", t.unitsMilli, "milli"),
    fig("forecastLowMilli", "Prognos, nedre gräns", t.unitsLowMilli, "milli"),
    fig("forecastHighMilli", "Prognos, övre gräns", t.unitsHighMilli, "milli"),
    fig("forecastRevenueOre", "Prognos, intäkt", t.revenueOre, "ore"),
    fig("forecastRevenueLowOre", "Prognos, intäkt nedre gräns", t.revenueLowOre, "ore"),
    fig("forecastRevenueHighOre", "Prognos, intäkt övre gräns", t.revenueHighOre, "ore"),
  ];
}

/**
 * Träffsäkerhet för alla serier: per serie och dag (fel tar inte ut varandra) och på
 * summan per dag (det som avgör totalintäkten).
 */
export function overallAccuracy(
  backtests: readonly SeriesBacktest[],
  horizonDays: number,
  stepDays: number,
): ForecastAccuracy {
  const allPoints: BacktestPoint[] = [];
  const allOrigins: BacktestOrigin[] = [];
  const sumPoints = new Map<string, { a: number; f: number; n: number; origin: IsoDate; date: IsoDate }>();
  const sumOrigins = new Map<IsoDate, { a: number; f: number; n: number; days: number; period: Period }>();
  for (const b of backtests) {
    for (const p of b.points) {
      allPoints.push(p);
      const k = `${p.origin}|${p.date}`;
      const s = sumPoints.get(k) ?? { a: 0, f: 0, n: 0, origin: p.origin, date: p.date };
      s.a += p.actualMilli;
      s.f += p.forecastMilli;
      s.n += p.naiveMilli;
      sumPoints.set(k, s);
    }
    for (const x of b.origins) {
      allOrigins.push(x);
      const s = sumOrigins.get(x.origin) ?? { a: 0, f: 0, n: 0, days: x.days, period: x.period };
      s.a += x.actualMilli;
      s.f += x.forecastMilli;
      s.n += x.naiveMilli;
      sumOrigins.set(x.origin, s);
    }
  }
  const series = accuracyMetrics(allPoints, allOrigins);
  const totalPoints = [...sumPoints.values()].map((s) => ({
    actualMilli: s.a,
    forecastMilli: s.f,
    naiveMilli: s.n,
  }));
  const totalOrigins = [...sumOrigins.values()].map((s) => ({ actualMilli: s.a, forecastMilli: s.f }));
  const total = accuracyMetrics(totalPoints, totalOrigins);

  const originDates = [...sumOrigins.keys()].sort();
  const n = originDates.length;
  const span =
    horizonDays === 7 && stepDays === 7 ? `${n} ${n === 1 ? "veckan" : "veckorna"}` : `${n} testperioderna`;
  let text: string;
  if (total.wapeBp === null) {
    text = "För lite historik för att mäta träffsäkerheten.";
  } else {
    text = `Träffsäkerhet de senaste ${span}: summan per dag missade i snitt ${pct(total.wapeBp)} (WAPE)`;
    if (total.mapeBp !== null) text += `, summan per ${horizonDays === 7 ? "vecka" : "period"} ${pct(total.mapeBp)} (MAPE)`;
    text += "";
    const bias = total.biasBp ?? 0;
    const biasRounded = roundHalfUp(bias, 100);
    text +=
      biasRounded === 0
        ? "; ingen systematisk avvikelse."
        : `; prognosen låg ${pct(Math.abs(bias))} för ${bias > 0 ? "högt" : "lågt"}.`;
    if (series.wapeBp !== null) text += ` Per titel och automat: ${pct(series.wapeBp)}.`;
    if (total.naiveWapeBp !== null)
      text += ` Att gissa förra veckans snitt hade missat ${pct(total.naiveWapeBp)}.`;
  }
  const first = originDates[0];
  const lastOrigin = originDates[n - 1];
  const period: Period | null =
    first !== undefined && lastOrigin !== undefined
      ? { start: addDays(first, 1), end: addDays(lastOrigin, horizonDays) }
      : null;
  const evidence: PlanEvidence = planEvidence({
    rule:
      "Backtest med rullande ursprung: modellen anpassas på data fram till varje ursprung och förutsäger " +
      `de följande ${horizonDays} dagarna. WAPE = Σ|prognos − utfall| / Σ utfall; MAPE = snittet av ` +
      "|prognos − utfall| / utfall per ursprung; bias = Σ(prognos − utfall) / Σ utfall. Slutsålda dagar jämförs inte.",
    period,
    dates: originDates,
    titleIds: backtests.map((b) => b.titleId),
    machineIds: backtests.map((b) => b.machineId),
    figures: [
      ...accuracyFigures(total),
      ...(series.wapeBp !== null
        ? [fig("seriesWapeBp", "Fel per titel, automat och dag (WAPE)", series.wapeBp, "bp")]
        : []),
      fig("origins", "Ursprung", n, "count"),
    ],
  });
  return { series, total, text, evidence };
}
