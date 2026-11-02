import { describePeriod, type ResolvedPeriod } from "@/components/shell/period-state";
import { addDays, daysInPeriod, type Period as DateRange } from "@/lib/period";
import {
  byMachine,
  byTitle,
  daysOf,
  emptySlotsByDay,
  machines,
  ordersByHour,
  ordersIn,
  revenueByDay,
  scopedMachines,
  totals,
  type Order,
  type Scope,
  type Totals,
} from "./sample-data";

/**
 * Allt som sektionerna visar för ett periodval och filter. Samma ordrar
 * ger nyckeltal, tabell, diagram och orderlista, så att summorna stämmer.
 */
export type Model = {
  period: ResolvedPeriod;
  range: DateRange;
  previous: DateRange | null;
  days: number;
  rangeLabel: string;
  comparisonLabel: string | null;
  machineIdx: number[];
  orders: Order[];
  prevOrders: Order[];
  t: Totals;
  prev: Totals | null;
  machines: ReturnType<typeof byMachine>;
  titles: ReturnType<typeof byTitle>;
  /** Linjediagrammet: minst 14 dagar så att formen syns även för "I dag". */
  chart: { range: DateRange; dates: Date[]; values: number[]; compare: number[] | null };
  heat: number[][];
  emptyByDay: number[];
};

export function buildModel(period: ResolvedPeriod, scope: Scope, fallback: DateRange): Model {
  const range = period.range ?? fallback;
  const previous = period.previous;
  const machineIdx = scopedMachines(scope);
  const orders = ordersIn(range, machineIdx);
  const prevOrders = previous ? ordersIn(previous, machineIdx) : [];
  const desc = describePeriod(period);

  const days = daysInPeriod(range);
  const chartRange = days >= 7 ? range : { start: addDays(range.end, -13), end: range.end };
  const chartOrders = chartRange === range ? orders : ordersIn(chartRange, machineIdx);
  const chartDays = daysInPeriod(chartRange);
  const chartPrev = {
    start: addDays(chartRange.start, -chartDays),
    end: addDays(chartRange.start, -1),
  };
  const comparable = machineIdx.some((i) => {
    const m = machines[i];
    return m ? m.installed <= chartPrev.start : false;
  });

  return {
    period,
    range,
    previous,
    days,
    rangeLabel: desc.rangeLabel,
    comparisonLabel: desc.comparisonLabel,
    machineIdx,
    orders,
    prevOrders,
    t: totals(orders, range, machineIdx),
    prev: previous ? totals(prevOrders, previous, machineIdx) : null,
    machines: byMachine(orders, range, machineIdx),
    titles: byTitle(orders),
    chart: {
      range: chartRange,
      dates: daysOf(chartRange),
      values: revenueByDay(chartOrders, chartRange),
      compare: comparable ? revenueByDay(ordersIn(chartPrev, machineIdx), chartPrev) : null,
    },
    heat: ordersByHour(orders),
    emptyByDay: emptySlotsByDay(range, machineIdx),
  };
}

export const sum = (a: ReadonlyArray<number>) => a.reduce((s, v) => s + v, 0);
export const mean = (a: ReadonlyArray<number>) => (a.length ? sum(a) / a.length : 0);

/** Avslutar en mening utan att dubblera punkten efter en förkortning ("3 okt."). */
export const sentence = (text: string) => (text.endsWith(".") ? text : `${text}.`);
