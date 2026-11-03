/**
 * Förlorad försäljning: perioder då en titel varit slutsåld i en automat och vad det
 * kostade, totalt och per månad ("Slutsålt kostade ca 3 200 kr i oktober").
 *
 * Regler per titel × automat och dag:
 * 1. **Saldo enligt lagret** (stock.ts: senaste inventering + påfyllningar − försäljning).
 *    - Saldo > 0 vid dagens början → titeln fanns.
 *    - Saldo ≤ 0 vid dagens början och ingen påfyllning under dagen → **slutsåld** hela dagen.
 *    - Saldo ≤ 0 vid dagens början och påfylld under dagen → **påfyllningsdag**, räknas som
 *      en halv slutsåld dag (`refillDayShareBp`).
 *    - Saldo ≤ 0 men order samma dag → titeln fanns (lagret saknar en registrering);
 *      dagen listas i `mismatches`.
 *    - Dagen då sista packet säljs räknas inte (konservativt).
 * 2. **Heuristik när saldot är okänt** (före första inventering/påfyllning, eller efter ett
 *    negativt saldo): minst `heuristicMinDays` dagar i rad utan försäljning av titeln, där
 *    titeln enligt takten före borde ha sålt minst `heuristicMinExpectedMilli` (3 pack:
 *    då är chansen under 5 % att det blir 0 av en slump) och automaten sålde andra titlar
 *    minst hälften av dagarna (automaten fungerade). Takten måste bygga på minst
 *    `minRateDays` dagar med data (standard 7): en takt från en eller två dagar säger inget
 *    om vad titeln "borde" ha sålt, så då dras ingen slutsats. Då räknas dagarna som troligen
 *    slutsålda. Kostnaden för dessa visas också separat (`heuristicLostRevenueOre`).
 * 3. **Takt före** = sålda pack / dagar med data under `rateWindowDays` dagar före periodens
 *    första dag. Slutsålda dagar räknas inte, så en tidigare slutförsäljning drar inte ned takten.
 * 4. **Kostnad** = takt × slutsålda dagar (viktade) × snittpris exkl. moms, avrundat en gång
 *    per period. Snittpriset är seriens snitt i fönstret (annars titelns snitt i alla
 *    automater i fönstret, annars seriens snitt tidigare). Bruttoresultat = intäkt − takt ×
 *    dagar × inköpspriset som gällde periodens första dag.
 * 5. **Långa perioder.** Är titeln slutsåld längre än `maxOpenDays` dagar antas den ha tagits
 *    ur sortimentet; dagarna därefter kostar inget.
 * 6. **Per månad.** En periods kostnad fördelas på månaderna efter slutsålda dagar (största-
 *    restmetoden), så att månaderna summerar exakt till perioden och totalen.
 * Bara dagar inom analysperioden kostar; en period som börjat före räknas från periodens start.
 */

import {
  addDays,
  allocateLargestRemainder,
  assertIsoDate,
  assertPeriod,
  daysBetween,
  DomainError,
  eachMonth,
  intersectPeriods,
  monthOf,
  monthPeriod,
  PriceIndex,
  roundHalfUp,
  vatOfGross,
  type IsoDate,
  type IsoMonth,
  type OrderLine,
  type Period,
} from "@/domain";
import {
  approxKr,
  assertIntAtLeast,
  fig,
  MILLI,
  packsOneDecimal,
  planEvidence,
  seriesKey,
} from "../forecast/common";
import { isMachineActive, machineNames, titleNames } from "../todos/common";
import { krExact, monthName, periodText, plural, tenths } from "../todos/text";
import type { MachineRef } from "../todos/types";
import { replayStockDaily, type DailyStock } from "./stock";
import type {
  LostSalesInput,
  LostSalesMonth,
  LostSalesOptions,
  LostSalesResult,
  PreStockoutRate,
  StockDayStatus,
  StockoutDay,
  StockoutPeriod,
} from "./types";

/** Standardvärden. */
export const LOST_SALES_DEFAULTS = {
  rateWindowDays: 28,
  minRateDays: 7,
  refillDayShareBp: 5_000,
  maxOpenDays: 28,
  heuristic: true,
  heuristicMinDays: 2,
  heuristicMinExpectedMilli: 3_000,
  heuristicMinOtherSalesBp: 5_000,
} as const satisfies Required<LostSalesOptions>;

type Resolved = {
  -readonly [K in keyof Required<LostSalesOptions>]: Required<LostSalesOptions>[K];
};

function resolve(options: LostSalesOptions = {}): Resolved {
  const o: Resolved = { ...LOST_SALES_DEFAULTS };
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) (o as Record<string, unknown>)[k] = v;
  }
  assertIntAtLeast(o.rateWindowDays, 1, "Fönstret för takten");
  assertIntAtLeast(o.minRateDays, 0, "Minsta antal dagar för takten");
  assertIntAtLeast(o.maxOpenDays, 1, "Längsta period");
  assertIntAtLeast(o.heuristicMinDays, 1, "Heuristikens minsta antal dagar");
  assertIntAtLeast(o.heuristicMinExpectedMilli, 0, "Heuristikens minsta väntade försäljning");
  for (const [v, label] of [
    [o.refillDayShareBp, "Påfyllningsdagens andel"],
    [o.heuristicMinOtherSalesBp, "Heuristikens andel dagar med annan försäljning"],
  ] as const) {
    if (!Number.isSafeInteger(v) || v < 0 || v > 10_000) {
      throw new DomainError("invalid_rate", `${label} måste vara 0–10 000 bp, fick ${String(v)}.`);
    }
  }
  return o;
}

const LOST: ReadonlySet<StockDayStatus> = new Set(["stockout", "refill-day", "probable-stockout"]);

/** Dagar som text med en decimal när det behövs: 70 000 bp → "7 dagar", 65 000 → "6,5 dagar". */
function daysText(weightBp: number): string {
  const t = roundHalfUp(weightBp, 1_000);
  if (t % 10 === 0) return plural(t / 10, "dag", "dagar");
  return `${tenths(t)} dagar`;
}

/** Arbetsdata per serie. */
interface Series {
  readonly machineId: string;
  readonly titleId: string;
  readonly first: IsoDate;
  /** Order per dag (affärsdatum → order). */
  readonly ordersByDate: Map<IsoDate, OrderLine[]>;
  readonly orders: OrderLine[];
  readonly stock: Map<IsoDate, DailyStock>;
}

/**
 * Förlorad försäljning för analysperioden: perioder med slutsålt per titel × automat,
 * kostnad per period, per månad och totalt, med underlag.
 */
export function lostSales(input: LostSalesInput): LostSalesResult {
  assertPeriod(input.period);
  const o = resolve(input.options);
  const period = input.period;
  const vat = input.settings.vatRateBp;
  const rangeStart = addDays(period.start, -(o.rateWindowDays + o.maxOpenDays));
  const end = period.end;
  const titleName = titleNames(input.titles ?? []);
  const machineName = machineNames(input.machines ?? []);
  const machines = new Map<string, MachineRef>((input.machines ?? []).map((m) => [m.id, m]));
  const active = (machineId: string, date: IsoDate): boolean => {
    const m = machines.get(machineId);
    return m ? isMachineActive(m, date) : true;
  };
  const prices = new PriceIndex(input.prices ?? []);
  const net = (x: OrderLine): number => x.amountOre - vatOfGross(x.amountOre, vat);

  // Order per serie och per automat och dag.
  const series = new Map<string, Series>();
  const machineDayOrders = new Map<string, number>();
  const titleOrders = new Map<string, OrderLine[]>();
  const getSeries = (machineId: string, titleId: string, first: IsoDate): Series => {
    const k = seriesKey(machineId, titleId);
    let s = series.get(k);
    if (!s) {
      s = { machineId, titleId, first, ordersByDate: new Map(), orders: [], stock: new Map() };
      series.set(k, s);
    } else if (first < s.first) {
      s = { ...s, first };
      series.set(k, s);
    }
    return s;
  };
  for (const x of input.orders) {
    assertIsoDate(x.businessDate, `Datum för order ${x.id}`);
    if (x.businessDate > end) continue;
    const t = titleOrders.get(x.titleId);
    if (t) t.push(x);
    else titleOrders.set(x.titleId, [x]);
    if (x.machineId === null) continue;
    const s = getSeries(x.machineId, x.titleId, x.businessDate);
    s.orders.push(x);
    const list = s.ordersByDate.get(x.businessDate);
    if (list) list.push(x);
    else s.ordersByDate.set(x.businessDate, [x]);
    const mk = `${x.machineId}\u0000${x.businessDate}`;
    machineDayOrders.set(mk, (machineDayOrders.get(mk) ?? 0) + 1);
  }

  // Lagret per automat (lagerplatsen = automaten).
  const machineEvents = input.stockEvents
    .filter((e) => e.machineId !== null)
    .map((e) => ({ ...e, locationId: e.machineId as string }));
  for (const st of replayStockDaily(machineEvents, end)) {
    const s = getSeries(st.machineId as string, st.titleId, st.firstDate);
    for (const d of st.days) s.stock.set(d.date, d);
  }

  const rangeDays = daysBetween(rangeStart, end) + 1;
  const periods: StockoutPeriod[] = [];
  const stockoutDays: StockoutDay[] = [];
  const mismatches: Array<{ machineId: string; titleId: string; date: IsoDate }> = [];

  for (const key of [...series.keys()].sort()) {
    const s = series.get(key)!;
    const dates: IsoDate[] = [];
    const status: StockDayStatus[] = [];
    const sales: number[] = [];

    // Pass 1: lagret.
    for (let i = 0; i < rangeDays; i++) {
      const date = addDays(rangeStart, i);
      dates.push(date);
      const sold = s.ordersByDate.get(date)?.length ?? 0;
      sales.push(sold);
      if (!active(s.machineId, date) || date < s.first) {
        status.push("inactive");
        continue;
      }
      const st = s.stock.get(date);
      if (st && st.opening !== null) {
        if (st.opening > 0) status.push("available");
        else if (st.inflow > 0) status.push("refill-day");
        else if (sold > 0) {
          status.push("available");
          mismatches.push({ machineId: s.machineId, titleId: s.titleId, date });
        } else status.push("stockout");
      } else {
        status.push(sold > 0 ? "available" : "unknown");
      }
    }

    const rateBefore = (startIndex: number): PreStockoutRate & { orders: OrderLine[] } => {
      const from = Math.max(0, startIndex - o.rateWindowDays);
      let units = 0;
      let days = 0;
      const orders: OrderLine[] = [];
      for (let i = from; i < startIndex; i++) {
        const st = status[i];
        if (st !== "available" && st !== "unknown") continue;
        days += 1;
        units += sales[i]!;
        for (const x of s.ordersByDate.get(dates[i]!) ?? []) orders.push(x);
      }
      return {
        window: {
          start: addDays(rangeStart, startIndex - o.rateWindowDays),
          end: addDays(rangeStart, startIndex - 1),
        },
        units,
        days,
        perDayMilli: days > 0 ? roundHalfUp(units * MILLI, days) : 0,
        lowData: days < o.minRateDays,
        orders,
      };
    };

    // Pass 2: heuristiken på okända dagar, i tidsordning.
    if (o.heuristic) {
      let i = 0;
      while (i < rangeDays) {
        if (status[i] !== "unknown") {
          i += 1;
          continue;
        }
        let j = i;
        while (j + 1 < rangeDays && status[j + 1] === "unknown") j += 1;
        const runDays = j - i + 1;
        const soldBefore = s.orders.some((x) => x.businessDate < dates[i]!);
        if (runDays >= o.heuristicMinDays && soldBefore) {
          const rate = rateBefore(i);
          const expectedMilli =
            rate.days > 0 ? roundHalfUp(rate.units * MILLI * runDays, rate.days) : 0;
          let otherDays = 0;
          for (let k = i; k <= j; k++) {
            const all = machineDayOrders.get(`${s.machineId}\u0000${dates[k]!}`) ?? 0;
            if (all - sales[k]! > 0) otherDays += 1;
          }
          if (
            rate.days >= o.minRateDays &&
            expectedMilli >= o.heuristicMinExpectedMilli &&
            otherDays * 10_000 >= o.heuristicMinOtherSalesBp * runDays
          ) {
            for (let k = i; k <= j; k++) status[k] = "probable-stockout";
          }
        }
        i = j + 1;
      }
    }

    const weightOf = (st: StockDayStatus): number =>
      st === "refill-day" ? o.refillDayShareBp : LOST.has(st) ? 10_000 : 0;
    for (let i = 0; i < rangeDays; i++) {
      const st = status[i]!;
      if (!LOST.has(st)) continue;
      stockoutDays.push({
        machineId: s.machineId,
        titleId: s.titleId,
        date: dates[i]!,
        status: st as StockoutDay["status"],
        weightBp: weightOf(st),
      });
    }

    // Pass 3: perioder.
    let i = 0;
    while (i < rangeDays) {
      const st = status[i]!;
      if (!LOST.has(st)) {
        i += 1;
        continue;
      }
      const source = st === "probable-stockout" ? "heuristic" : "stock";
      let j = i;
      while (
        j + 1 < rangeDays &&
        status[j] !== "refill-day" &&
        LOST.has(status[j + 1]!) &&
        (status[j + 1] === "probable-stockout" ? "heuristic" : "stock") === source
      ) {
        j += 1;
      }
      const startDate = dates[i]!;
      const endDate = dates[j]!;
      const clip = intersectPeriods({ start: startDate, end: endDate }, period);
      if (clip) {
        periods.push(
          buildPeriod({
            s,
            startDate,
            endDate,
            source,
            statuses: status.slice(i, j + 1),
            rate: rateBefore(i),
            ongoing: j === rangeDays - 1 && endDate === end && status[j] !== "refill-day",
          }),
        );
      }
      i = j + 1;
    }
  }

  function buildPeriod(a: {
    s: Series;
    startDate: IsoDate;
    endDate: IsoDate;
    source: "stock" | "heuristic";
    statuses: StockDayStatus[];
    rate: PreStockoutRate & { orders: OrderLine[] };
    ongoing: boolean;
  }): StockoutPeriod {
    const { s, rate } = a;
    const days = a.statuses.length;
    const capped = days > o.maxOpenDays;
    const monthWeights = new Map<IsoMonth, number>();
    const costDates: IsoDate[] = [];
    let weight = 0;
    a.statuses.forEach((st, k) => {
      const date = addDays(a.startDate, k);
      if (k >= o.maxOpenDays || date < period.start || date > period.end) return;
      const w = st === "refill-day" ? o.refillDayShareBp : 10_000;
      weight += w;
      costDates.push(date);
      const m = monthOf(date);
      monthWeights.set(m, (monthWeights.get(m) ?? 0) + w);
    });

    // Snittpris.
    let avgPriceOre: number | null = null;
    let priceSource: StockoutPeriod["priceSource"] = "none";
    const windowStart = rate.window.start;
    const avg = (list: readonly OrderLine[]): number | null =>
      list.length > 0
        ? roundHalfUp(
            list.reduce((sum, x) => sum + net(x), 0),
            list.length,
          )
        : null;
    const seriesWindow = avg(rate.orders);
    if (seriesWindow !== null) {
      avgPriceOre = seriesWindow;
      priceSource = "series";
    } else {
      const titleWindow = avg(
        (titleOrders.get(s.titleId) ?? []).filter(
          (x) => x.businessDate >= windowStart && x.businessDate < a.startDate,
        ),
      );
      if (titleWindow !== null) {
        avgPriceOre = titleWindow;
        priceSource = "title";
      } else {
        const earlier = avg(s.orders.filter((x) => x.businessDate < a.startDate));
        if (earlier !== null) {
          avgPriceOre = earlier;
          priceSource = "series-history";
        }
      }
    }

    const den = BigInt(Math.max(1, rate.days)) * 10_000n;
    const factor = BigInt(rate.days > 0 ? rate.units : 0) * BigInt(weight);
    const lostUnitsMilli = roundHalfUp(factor * 1_000n, den);
    const lostRevenueOre =
      avgPriceOre === null ? 0 : roundHalfUp(factor * BigInt(avgPriceOre), den);
    const firstCostDate = costDates[0] ?? a.startDate;
    const unitCost = prices.priceOn(s.titleId, firstCostDate);
    const lostGrossProfitOre =
      unitCost === null || avgPriceOre === null
        ? null
        : lostRevenueOre - roundHalfUp(factor * BigInt(unitCost.unitCostOre), den);

    const months = [...monthWeights.keys()].sort();
    const shares = allocateLargestRemainder(
      lostRevenueOre,
      months.map((m) => monthWeights.get(m)!),
    );
    const byMonth = months.map((month, k) => ({
      month,
      lostRevenueOre: shares[k]!,
      weightBp: monthWeights.get(month)!,
    }));

    const tName = titleName(s.titleId);
    const mName = machineName(s.machineId);
    const span: Period = { start: a.startDate, end: a.endDate };
    const rateText = `${packsOneDecimal(rate.perDayMilli)} pack/dag`;
    const priceText = avgPriceOre === null ? "pris saknas" : krExact(avgPriceOre);
    let text: string;
    if (a.source === "stock") {
      text = a.ongoing
        ? `${tName} i ${mName} är slutsåld sedan ${periodText({ start: a.startDate, end: a.startDate })} (${plural(days, "dag", "dagar")})`
        : `${tName} i ${mName} var slutsåld ${periodText(span)} (${daysText(a.statuses.reduce((sum, st) => sum + (st === "refill-day" ? o.refillDayShareBp : 10_000), 0))})`;
    } else {
      text =
        `${tName} i ${mName} var troligen slutsåld ${periodText(span)}: ingen försäljning på ` +
        `${plural(days, "dag", "dagar")} trots ${rateText} innan, medan automaten sålde andra titlar`;
    }
    text +=
      lostRevenueOre > 0
        ? `: ${approxKr(lostRevenueOre)} i förlorad försäljning (${rateText} × ${daysText(weight)} × ${priceText}).`
        : rate.days === 0 || rate.units === 0
          ? ". Ingen takt före, så kostnaden räknas som 0."
          : ". Snittpris saknas, så kostnaden räknas som 0.";
    if (capped)
      text += ` Räknat på de första ${o.maxOpenDays} dagarna; titeln antas sedan vara borttagen.`;
    if (rate.lowData && rate.days > 0)
      text += ` Takten bygger på bara ${plural(rate.days, "dag", "dagar")}.`;

    const eventIds: string[] = [];
    for (let k = 0; k < days; k++) {
      for (const id of s.stock.get(addDays(a.startDate, k))?.eventIds ?? []) eventIds.push(id);
    }
    const evidence = planEvidence({
      rule:
        a.source === "stock"
          ? "Slutsåld = saldo 0 vid dagens början enligt lagerhändelserna (påfyllningsdagen räknas som en halv dag). " +
            "Kostnad = takt före × slutsålda dagar × snittpris exkl. moms."
          : "Troligen slutsåld = saldot okänt, ingen försäljning flera dagar i rad trots väntad försäljning, " +
            "medan automaten sålde andra titlar. Kostnad = takt före × dagar × snittpris exkl. moms.",
      period: span,
      orderIds: rate.orders.map((x) => x.id),
      dates: costDates,
      titleIds: [s.titleId],
      machineIds: [s.machineId],
      stockEventIds: eventIds,
      figures: [
        fig("rateUnits", "Sålda pack före", rate.units, "packs"),
        fig("rateDays", "Dagar med data före", rate.days, "days"),
        fig("ratePerDayMilli", "Takt före, pack per dag", rate.perDayMilli, "milli"),
        fig("lostDayWeightBp", "Slutsålda dagar som kostar (bp av dag)", weight, "bp"),
        fig("avgPriceOre", "Snittpris exkl. moms", avgPriceOre ?? 0, "ore"),
        fig("lostUnitsMilli", "Förlorade pack", lostUnitsMilli, "milli"),
        fig("lostRevenueOre", "Förlorad intäkt", lostRevenueOre, "ore"),
        ...(lostGrossProfitOre !== null
          ? [fig("lostGrossProfitOre", "Förlorad intäkt minus inköp", lostGrossProfitOre, "ore")]
          : []),
        ...(eventIds.length > 0
          ? [fig("stockEvents", "Lagerhändelser i perioden", eventIds.length, "count")]
          : []),
      ],
    });

    return {
      key: `stockout:${s.machineId}:${s.titleId}:${a.startDate}`,
      machineId: s.machineId,
      titleId: s.titleId,
      start: a.startDate,
      end: a.endDate,
      days,
      source: a.source,
      ongoing: a.ongoing,
      capped,
      lostDayWeightBp: weight,
      rate: {
        window: rate.window,
        units: rate.units,
        days: rate.days,
        perDayMilli: rate.perDayMilli,
        lowData: rate.lowData,
      },
      avgPriceOre,
      priceSource,
      lostUnitsMilli,
      lostRevenueOre,
      lostGrossProfitOre,
      byMonth,
      text,
      evidence,
    };
  }

  periods.sort(
    (x, y) => y.lostRevenueOre - x.lostRevenueOre || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0),
  );

  // Månader.
  const months: LostSalesMonth[] = eachMonth(period.start, period.end).map((month) => {
    const mp = intersectPeriods(monthPeriod(month), period)!;
    const partial = mp.start !== monthPeriod(month).start || mp.end !== monthPeriod(month).end;
    let revenue = 0;
    let gp = 0;
    let withoutCost = 0;
    let units = 0;
    let weight = 0;
    let heuristicRevenue = 0;
    const keys: string[] = [];
    const machineIds = new Set<string>();
    const titleIds = new Set<string>();
    const dates: IsoDate[] = [];
    const orderIds: string[] = [];
    const eventIds: string[] = [];
    let top: { p: StockoutPeriod; revenue: number; weight: number } | null = null;
    for (const p of periods) {
      const share = p.byMonth.find((b) => b.month === month);
      if (!share) continue;
      revenue += share.lostRevenueOre;
      weight += share.weightBp;
      keys.push(p.key);
      machineIds.add(p.machineId);
      titleIds.add(p.titleId);
      if (p.source === "heuristic") heuristicRevenue += share.lostRevenueOre;
      for (const d of p.evidence.dates) if (monthOf(d) === month) dates.push(d);
      orderIds.push(...p.evidence.orderIds);
      eventIds.push(...(p.evidence.stockEventIds ?? []));
      // Pack och bruttoresultat fördelas på samma sätt som intäkten (efter dagar).
      const ms = [...p.byMonth];
      const idx = ms.findIndex((b) => b.month === month);
      const weights = ms.map((b) => b.weightBp);
      units += allocateLargestRemainder(p.lostUnitsMilli, weights)[idx]!;
      if (p.lostGrossProfitOre !== null)
        gp += allocateLargestRemainder(p.lostGrossProfitOre, weights)[idx]!;
      if (p.lostRevenueOre === 0 || p.lostGrossProfitOre === null) withoutCost += 1;
      if (
        top === null ||
        share.lostRevenueOre > top.revenue ||
        (share.lostRevenueOre === top.revenue && p.key < top.p.key)
      ) {
        top = { p, revenue: share.lostRevenueOre, weight: share.weightBp };
      }
    }
    const when = partial ? `i ${monthName(month)} (${periodText(mp)})` : `i ${monthName(month)}`;
    let text: string;
    let detail: string;
    if (keys.length === 0) {
      text = `Inget slutsålt ${when}.`;
      detail = "Ingen titel var slutsåld enligt lagret eller försäljningen.";
    } else {
      text =
        revenue > 0
          ? `Slutsålt kostade ${approxKr(revenue)} ${when}.`
          : `Slutsålt ${daysText(weight)} ${when}; kostnaden kan inte räknas (takt eller pris saknas).`;
      detail =
        `${plural(keys.length, "period", "perioder")} i ${plural(machineIds.size, "automat", "automater")}, ` +
        `${daysText(weight)} totalt.`;
      if (top && top.revenue > 0) {
        detail +=
          ` Störst: ${titleName(top.p.titleId)} i ${machineName(top.p.machineId)}, ` +
          `${approxKr(top.revenue)} (${daysText(top.weight)}).`;
      }
      if (heuristicRevenue > 0) {
        detail += ` Varav ${approxKr(heuristicRevenue)} bedömt ur försäljningen (lagret okänt).`;
      }
    }
    return {
      month,
      period: mp,
      partial,
      lostRevenueOre: revenue,
      lostGrossProfitOre: gp,
      periodsWithoutCost: withoutCost,
      lostUnitsMilli: units,
      stockoutDayWeightBp: weight,
      heuristicLostRevenueOre: heuristicRevenue,
      periodKeys: [...keys].sort(),
      text,
      detail,
      evidence: planEvidence({
        rule: "Summan av slutsålda perioder i månaden; en period som går över månadsskiftet delas efter slutsålda dagar.",
        period: mp,
        orderIds,
        dates,
        titleIds,
        machineIds,
        stockEventIds: eventIds,
        figures: [
          fig("periods", "Perioder", keys.length, "count"),
          fig("stockoutDayWeightBp", "Slutsålda dagar (bp av dag)", weight, "bp"),
          fig("lostUnitsMilli", "Förlorade pack", units, "milli"),
          fig("lostRevenueOre", "Förlorad intäkt", revenue, "ore"),
          fig("lostGrossProfitOre", "Förlorad intäkt minus inköp", gp, "ore"),
          fig("heuristicLostRevenueOre", "Varav bedömt ur försäljningen", heuristicRevenue, "ore"),
        ],
      }),
    };
  });

  const totalRevenue = months.reduce((sum, m) => sum + m.lostRevenueOre, 0);
  const totalGp = months.reduce((sum, m) => sum + m.lostGrossProfitOre, 0);
  const totalUnits = months.reduce((sum, m) => sum + m.lostUnitsMilli, 0);
  const totalWeight = months.reduce((sum, m) => sum + m.stockoutDayWeightBp, 0);
  const totalHeuristic = months.reduce((sum, m) => sum + m.heuristicLostRevenueOre, 0);
  const costing = periods.filter((p) => p.lostDayWeightBp > 0 || p.lostRevenueOre > 0).length;

  stockoutDays.sort((x, y) =>
    x.machineId !== y.machineId
      ? x.machineId < y.machineId
        ? -1
        : 1
      : x.titleId !== y.titleId
        ? x.titleId < y.titleId
          ? -1
          : 1
        : x.date < y.date
          ? -1
          : x.date > y.date
            ? 1
            : 0,
  );
  mismatches.sort((x, y) =>
    `${x.machineId}\u0000${x.titleId}\u0000${x.date}` <
    `${y.machineId}\u0000${y.titleId}\u0000${y.date}`
      ? -1
      : 1,
  );

  return {
    period,
    periods,
    months,
    total: {
      lostRevenueOre: totalRevenue,
      lostGrossProfitOre: totalGp,
      lostUnitsMilli: totalUnits,
      stockoutDayWeightBp: totalWeight,
      heuristicLostRevenueOre: totalHeuristic,
      // Perioder som varken kostar dagar eller kronor i analysperioden (titlar som togs ur
      // sortimentet före den) räknas inte i texten; de visas inte heller på Prognos.
      text:
        costing === 0
          ? `Inget slutsålt ${periodText(period)}`.replace(/\.?$/, ".")
          : // Kort (visas på Hem och Prognos); perioder och titeldagar står i underlaget.
            // periodText slutar ofta med punkt ("3 nov."): ingen dubbelpunkt.
            `Slutsålt kostade ${approxKr(totalRevenue)} ${periodText(period)}`.replace(/\.?$/, "."),
      evidence: planEvidence({
        rule: "Summan av månaderna, som är summan av de slutsålda perioderna.",
        period,
        orderIds: months.flatMap((m) => m.evidence.orderIds),
        dates: months.flatMap((m) => m.evidence.dates),
        titleIds: periods.map((p) => p.titleId),
        machineIds: periods.map((p) => p.machineId),
        stockEventIds: months.flatMap((m) => m.evidence.stockEventIds ?? []),
        figures: [
          fig("periods", "Perioder", periods.length, "count"),
          fig("stockoutDayWeightBp", "Slutsålda dagar (bp av dag)", totalWeight, "bp"),
          fig("lostUnitsMilli", "Förlorade pack", totalUnits, "milli"),
          fig("lostRevenueOre", "Förlorad intäkt", totalRevenue, "ore"),
          fig("lostGrossProfitOre", "Förlorad intäkt minus inköp", totalGp, "ore"),
          fig("heuristicLostRevenueOre", "Varav bedömt ur försäljningen", totalHeuristic, "ore"),
        ],
      }),
    },
    stockoutDays,
    mismatches,
  };
}
