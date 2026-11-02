/**
 * Hem: allt sidan visar, räknat ur beräkningslagret (@/domain, @/analytics).
 *
 * Ren funktion utan databas och utan React: laddaren (load.ts) hämtar indata via de
 * gemensamma laddarna och anropar buildHomeModel. Resultatet är serialiserbart (bara
 * tal, strängar och listor), så att klientkomponenterna kan få det rakt av. Belopp i
 * öre, andelar i bp, affärsdatum 'ÅÅÅÅ-MM-DD'. Ingen ekonomi räknas här: nyckeltal,
 * vinst, marginal, dagserier och titlar kommer från keyMetrics/profitability, och
 * iakttagelserna från computeInsights. Här väljs, ordnas och formuleras bara.
 */

import { computeInsights, type Insight } from "@/analytics/insights";
import type { AnalyticsOrder, TodoItem, TodoLevel } from "@/analytics/todos";
import {
  addDays,
  changeBp,
  dayOfWeek,
  keyMetrics,
  maxDate,
  periodDays,
  profitability,
  roundHalfUp,
  type IsoDate,
  type KeyMetrics,
  type Period,
  type ProfitabilityInput,
  type ProfitabilityRow,
} from "@/domain";
import type { DataScope, MachineRecord, TitleRecord } from "@/server/data/core/types";
import type { EconomicsSources } from "@/domain";
import { formatPercent } from "@/lib/format";

import { homeHeadline, type HomeHeadline } from "./headline";
import { appHref } from "./links";

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

export type HomeKpiId = "revenue" | "profit" | "margin" | "orders" | "aov";

/** Ett nyckeltal i remsan. */
export interface HomeKpi {
  readonly id: HomeKpiId;
  readonly label: string;
  /** 'ore' = öre, 'bp' = baspunkter, 'count' = antal. */
  readonly unit: "ore" | "bp" | "count";
  /** Värdet, eller null när det inte är definierat (marginal utan intäkt, snitt utan order). */
  readonly value: number | null;
  /**
   * Förändring mot jämförelseperioden. Relativ: andel (0,12 = +12 %). Absolut (marginal):
   * procentenheter (2,5 = +2,5 p.e.). null utan jämförbar period.
   */
  readonly delta: number | null;
  readonly deltaKind: "relative" | "absolute";
  /** Dagsserie för de dagar som har data, i samma enhet som värdet. */
  readonly trend: number[];
  /** Jämförelseperiodens snitt per dag (för hjälplinjen), i samma enhet. */
  readonly reference: number | null;
  /** Text när nyckeltalet kräver åtgärd (bara vinsten, när order saknar inköpspris). */
  readonly alertText: string | null;
}

/** Intäkt per dag för huvuddiagrammet. */
export interface HomeDaily {
  readonly dates: IsoDate[];
  readonly revenueOre: number[];
  /** Jämförelseperiodens intäkt dag för dag (samma längd), eller null. */
  readonly compareOre: number[] | null;
  /** Index för bästa dagen (högst intäkt), null utan försäljning. */
  readonly peakIndex: number | null;
  /** Bästa dagens intäkt i förhållande till snittdagen, i tiondelar (21 = 2,1 ×). */
  readonly peakRatioTenths: number | null;
  /** Snitt per dag i öre. */
  readonly averageOre: number;
}

/** Order utan inköpspris: de ingår inte i vinsten. */
export interface HomeUnpriced {
  readonly orders: number;
  readonly revenueOre: number;
  /** Andel av intäkten i bp. */
  readonly shareBp: number;
  readonly titles: { readonly id: string; readonly name: string }[];
  readonly href: string;
}

/** En rad i topplistan. */
export interface HomeTitleRow {
  readonly id: string;
  readonly name: string;
  readonly orders: number;
  /** Nettointäkt, alla order (även utan inköpspris). */
  readonly revenueOre: number;
  /** Andel av periodens intäkt i bp. */
  readonly shareBp: number;
  /** Titeln har order utan inköpspris i perioden. */
  readonly unpriced: boolean;
}

export interface HomeTopTitles {
  readonly rows: HomeTitleRow[];
  /** Övriga titlar sammanslagna, eller null om alla visas. */
  readonly rest: { readonly titles: number; readonly orders: number; readonly revenueOre: number } | null;
  readonly totalTitles: number;
}

export interface HomeInsight {
  readonly key: string;
  readonly tone: Insight["tone"];
  readonly text: string;
  readonly detail: string;
  readonly href: string;
}

export interface HomeTodo {
  readonly key: string;
  readonly level: TodoLevel;
  readonly title: string;
  readonly detail: string;
  readonly href: string;
}

export interface HomeModel {
  readonly headline: HomeHeadline;
  readonly period: Period;
  readonly compare: Period | null;
  /** Dagarna i perioden som har data (från första ordern, utan en tom dag i dag). null = ingen data. */
  readonly coverage: Period | null;
  /** Jämförelseperioden ligger helt inom data, så att förändringar är meningsfulla. */
  readonly comparable: boolean;
  readonly dataStart: IsoDate | null;
  readonly kpis: HomeKpi[];
  readonly daily: HomeDaily | null;
  readonly unpriced: HomeUnpriced | null;
  readonly topTitles: HomeTopTitles;
  readonly insights: HomeInsight[];
  /** De viktigaste punkterna i Att göra, eller null när rollen inte har Att göra. */
  readonly todos: HomeTodo[] | null;
  /** Antal punkter i Att göra totalt (efter filter). */
  readonly todoCount: number;
}

export interface HomeModelInput {
  readonly current: ProfitabilityInput & { readonly orders: readonly AnalyticsOrder[] };
  readonly previous: (ProfitabilityInput & { readonly orders: readonly AnalyticsOrder[] }) | null;
  readonly sources: EconomicsSources;
  readonly titles: readonly TitleRecord[];
  readonly machines: readonly MachineRecord[];
  /** Order efter perioden fram till i dag (samma filter), så att "har inte sålt" blir rätt. */
  readonly laterOrders?: readonly AnalyticsOrder[];
  readonly period: Period;
  readonly compare: Period | null;
  readonly dataStart: IsoDate | null;
  readonly today: IsoDate;
  /** Tidpunkten förfrågan räknar från (ISO 8601). */
  readonly now: string;
  readonly timeZone: string;
  readonly scope: DataScope;
  /** Punkterna i Att göra, eller null om rollen inte har Att göra. */
  readonly todos: readonly TodoItem[] | null;
}

// ---------------------------------------------------------------------------
// Gränser
// ---------------------------------------------------------------------------

/** Antal punkter från Att göra. */
export const HOME_TODO_COUNT = 3;
/** Antal iakttagelser i Värt att veta. */
export const HOME_INSIGHT_COUNT = 4;
/** Antal titlar i topplistan innan resten slås ihop. */
export const HOME_TOP_TITLES = 8;

// ---------------------------------------------------------------------------
// Hjälp
// ---------------------------------------------------------------------------

/** Nettointäkt för en rad, alla order (prissatta + utan pris). */
function rowRevenue(row: ProfitabilityRow): number {
  return row.revenueOre + row.unpricedRevenueOre;
}

/**
 * Dagarna i perioden som har data: från första ordern (organisationens) och, om perioden
 * slutar i dag och ingen order kommit i dag, bara t.o.m. i går. null om inga dagar återstår.
 */
export function coverageOf(
  period: Period,
  dataStart: IsoDate | null,
  today: IsoDate,
  hasOrdersToday: boolean,
): Period | null {
  if (dataStart === null) return null;
  const start = maxDate(period.start, dataStart);
  let end = period.end;
  if (end >= today && !hasOrdersToday) end = addDays(today, -1);
  if (end > period.end) end = period.end;
  return start <= end ? { start, end } : null;
}

/** Fyller luckor (null) med närmast föregående värde; inledande luckor blir första kända. */
function carryForward(values: readonly (number | null)[]): number[] {
  const first = values.find((v) => v !== null) ?? 0;
  let last = first;
  return values.map((v) => {
    if (v !== null) last = v;
    return last;
  });
}

function dayRows(input: ProfitabilityInput): ProfitabilityRow[] {
  return profitability(input, "day").rows.filter((r) => r.kind === "time");
}

/** Raderna inom `range`, i datumordning. */
function rowsIn(rows: readonly ProfitabilityRow[], range: Period): ProfitabilityRow[] {
  return rows.filter((r) => r.key >= range.start && r.key <= range.end);
}

function relative(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  const bp = changeBp(current, previous);
  return bp === null ? null : bp / 10_000;
}

function perDay(total: number, days: number): number {
  return days > 0 ? roundHalfUp(total, days) : 0;
}

const LEVEL_ORDER: Record<TodoLevel, number> = { now: 0, soon: 1, later: 2 };

/** Punkter i Att göra som gäller filtret (punkter utan automat gäller alltid). */
function todosInScope(
  todos: readonly TodoItem[],
  scope: DataScope,
  machines: readonly MachineRecord[],
): TodoItem[] {
  if (!scope.machineId && !scope.storeId) return [...todos];
  const inScope = new Set(
    machines
      .filter((m) =>
        scope.machineId ? m.id === scope.machineId : m.storeId === scope.storeId,
      )
      .map((m) => m.id),
  );
  return todos.filter(
    (t) => t.evidence.machineIds.length === 0 || t.evidence.machineIds.some((id) => inScope.has(id)),
  );
}

// ---------------------------------------------------------------------------
// Delar
// ---------------------------------------------------------------------------

function buildKpis(args: {
  km: KeyMetrics;
  prev: KeyMetrics | null;
  days: ProfitabilityRow[];
  prevDays: ProfitabilityRow[];
  coverageDays: number;
  compareDays: number;
  unpriced: HomeUnpriced | null;
}): HomeKpi[] {
  const { km, prev, days, prevDays, coverageDays, compareDays, unpriced } = args;
  const revenueTrend = days.map(rowRevenue);
  const marginTrend = carryForward(days.map((r) => r.marginBp));
  const aovTrend = carryForward(
    days.map((r) => (r.orders > 0 ? roundHalfUp(rowRevenue(r), r.orders) : null)),
  );
  const prevMargin = prev?.marginBp ?? null;
  const marginDelta =
    km.marginBp !== null && prevMargin !== null ? (km.marginBp - prevMargin) / 100 : null;
  const hasPrev = prev !== null && prevDays.length > 0;

  return [
    {
      id: "revenue",
      label: "Intäkt",
      unit: "ore",
      value: km.revenueOre,
      delta: hasPrev ? relative(km.revenueOre, prev.revenueOre) : null,
      deltaKind: "relative",
      trend: revenueTrend,
      reference: hasPrev ? perDay(prev.revenueOre, compareDays) : null,
      alertText: null,
    },
    {
      id: "profit",
      label: "Vinst efter alla kostnader",
      unit: "ore",
      value: km.profitOre,
      delta: hasPrev ? relative(km.profitOre, prev.profitOre) : null,
      deltaKind: "relative",
      trend: days.map((r) => r.profitOre),
      reference: hasPrev ? perDay(prev.profitOre, compareDays) : null,
      alertText:
        unpriced && unpriced.orders > 0
          ? `Utan ${shareText(unpriced.shareBp)} av intäkten`
          : null,
    },
    {
      id: "margin",
      label: "Marginal",
      unit: "bp",
      value: km.marginBp,
      delta: hasPrev ? marginDelta : null,
      deltaKind: "absolute",
      trend: marginTrend,
      reference: hasPrev ? prevMargin : null,
      alertText: null,
    },
    {
      id: "orders",
      label: "Betalda order",
      unit: "count",
      value: km.orderCount,
      delta: hasPrev ? relative(km.orderCount, prev.orderCount) : null,
      deltaKind: "relative",
      trend: days.map((r) => r.orders),
      reference: hasPrev && compareDays > 0 ? prev.orderCount / compareDays : null,
      alertText: null,
    },
    {
      id: "aov",
      label: "Snitt per order",
      unit: "ore",
      value: km.averageOrderValueOre,
      delta: hasPrev ? relative(km.averageOrderValueOre, prev.averageOrderValueOre) : null,
      deltaKind: "relative",
      trend: aovTrend,
      reference: hasPrev ? prev.averageOrderValueOre : null,
      alertText: null,
    },
  ].map((k) => ({ ...k, trend: coverageDays > 1 ? k.trend : [] })) as HomeKpi[];
}

/** Andel i bp som procent: hela procent, en decimal under 1 %. */
export function shareText(bp: number): string {
  return formatPercent(bp / 10_000, bp < 100 ? 1 : 0);
}

function buildTopTitles(
  rows: readonly ProfitabilityRow[],
  totalRevenue: number,
  titleName: (id: string) => string,
): HomeTopTitles {
  const items = rows
    .filter((r) => r.kind === "item" && r.orders > 0)
    .map((r) => ({
      id: r.key,
      name: titleName(r.key),
      orders: r.orders,
      revenueOre: rowRevenue(r),
      unpriced: r.unpricedOrders > 0,
    }))
    .sort(
      (a, b) =>
        b.revenueOre - a.revenueOre ||
        b.orders - a.orders ||
        a.name.localeCompare(b.name, "sv-SE"),
    );
  const share = (v: number) => (totalRevenue > 0 ? roundHalfUp(v * 10_000, totalRevenue) : 0);
  // Slå inte ihop en enda titel till "övriga": visa den hellre.
  const cut = items.length > HOME_TOP_TITLES + 1 ? HOME_TOP_TITLES : items.length;
  const shown = items.slice(0, cut).map((r) => ({ ...r, shareBp: share(r.revenueOre) }));
  const others = items.slice(cut);
  return {
    rows: shown,
    rest:
      others.length > 0
        ? {
            titles: others.length,
            orders: others.reduce((n, r) => n + r.orders, 0),
            revenueOre: others.reduce((n, r) => n + r.revenueOre, 0),
          }
        : null,
    totalTitles: items.length,
  };
}

function buildInsights(input: HomeModelInput, scope: DataScope): HomeInsight[] {
  const orders: AnalyticsOrder[] = [
    ...input.current.orders,
    ...(input.previous?.orders ?? []),
    ...(input.laterOrders ?? []),
  ];
  const insights = computeInsights(
    {
      ...input.sources,
      orders,
      titles: input.titles,
      machines: input.machines,
    },
    input.period,
    input.compare,
    {
      now: input.now,
      timeZone: input.timeZone,
      // Hämta en extra: intäkten i perioden står redan i rubriken och tas bort nedan.
      maxCount: HOME_INSIGHT_COUNT + 1,
      minCount: HOME_INSIGHT_COUNT + 1,
    },
  );
  return insights
    .filter((i) => i.kind !== "period-summary")
    .slice(0, HOME_INSIGHT_COUNT)
    .map((i) => ({
      key: i.key,
      tone: i.tone,
      text: i.text,
      detail: i.detail,
      href: appHref(i.link, scope),
    }));
}

function buildTodos(
  todos: readonly TodoItem[] | null,
  scope: DataScope,
  machines: readonly MachineRecord[],
): { todos: HomeTodo[] | null; count: number } {
  if (todos === null) return { todos: null, count: 0 };
  const relevant = todosInScope(todos, scope, machines);
  // computeTodos sorterar redan efter brådska; nivån går ändå först om listan kommer osorterad.
  const top = relevant
    .map((t, i) => ({ t, i }))
    .sort((a, b) => LEVEL_ORDER[a.t.level] - LEVEL_ORDER[b.t.level] || a.i - b.i)
    .slice(0, HOME_TODO_COUNT)
    .map(({ t }) => ({
      key: t.key,
      level: t.level,
      title: t.title,
      detail: t.detail,
      href: appHref(t.link),
    }));
  return { todos: top, count: relevant.length };
}

// ---------------------------------------------------------------------------
// Modellen
// ---------------------------------------------------------------------------

export function buildHomeModel(input: HomeModelInput): HomeModel {
  const { current, previous, period, compare, dataStart, today } = input;
  const titleName = (() => {
    const map = new Map(input.titles.map((t) => [t.id, t.name.trim() || t.id]));
    return (id: string) => map.get(id) ?? "Okänd titel";
  })();

  const hasOrdersToday = current.orders.some((o) => o.businessDate === today);
  const coverage = coverageOf(period, dataStart, today, hasOrdersToday);
  const comparable =
    compare !== null && previous !== null && dataStart !== null && compare.start >= dataStart;

  const km = keyMetrics(current);
  const prevKm = comparable && previous ? keyMetrics(previous) : null;

  const byTitle = profitability(current, "title");
  const unpricedSummary = byTitle.unpriced;
  const unpriced: HomeUnpriced | null =
    unpricedSummary.orders > 0
      ? {
          orders: unpricedSummary.orders,
          revenueOre: unpricedSummary.revenueOre,
          shareBp: unpricedSummary.shareBp,
          titles: unpricedSummary.byTitle.map((t) => ({ id: t.titleId, name: titleName(t.titleId) })),
          href:
            unpricedSummary.titleIds.length === 1 && unpricedSummary.titleIds[0]
              ? `/inkopspriser?titel=${encodeURIComponent(unpricedSummary.titleIds[0])}`
              : "/inkopspriser?saknar=pris",
        }
      : null;

  const allDays = dayRows(current);
  const days = coverage ? rowsIn(allDays, coverage) : [];
  const coverageDays = coverage ? periodDays(coverage) : 0;

  // Jämförelsen dag för dag: dag i i perioden mot dag i i jämförelseperioden.
  let prevDays: ProfitabilityRow[] = [];
  let compareDays = 0;
  if (comparable && previous && compare && coverage) {
    const all = dayRows(previous);
    const offset = periodDays({ start: period.start, end: coverage.start }) - 1;
    prevDays = all.slice(offset, offset + coverageDays);
    compareDays = periodDays(compare);
  }

  const kpis = buildKpis({
    km,
    prev: prevKm,
    days,
    prevDays,
    coverageDays,
    compareDays,
    unpriced,
  });

  let daily: HomeDaily | null = null;
  if (coverage && days.length > 0) {
    const revenueOre = days.map(rowRevenue);
    const total = revenueOre.reduce((a, b) => a + b, 0);
    let peakIndex: number | null = null;
    revenueOre.forEach((v, i) => {
      if (v > 0 && (peakIndex === null || v > (revenueOre[peakIndex] ?? 0))) peakIndex = i;
    });
    const averageOre = perDay(total, days.length);
    const peakValue = peakIndex === null ? 0 : (revenueOre[peakIndex] ?? 0);
    daily = {
      dates: days.map((r) => r.key),
      revenueOre,
      compareOre: prevDays.length === days.length ? prevDays.map(rowRevenue) : null,
      peakIndex,
      peakRatioTenths: averageOre > 0 && peakIndex !== null ? roundHalfUp(peakValue * 10, averageOre) : null,
      averageOre,
    };
  }

  const topTitles = buildTopTitles(byTitle.rows, km.revenueOre, titleName);
  const insights = coverage ? buildInsights(input, input.scope) : [];
  const { todos, count } = buildTodos(input.todos, input.scope, input.machines);

  const peakDate =
    daily && daily.peakIndex !== null ? (daily.dates[daily.peakIndex] ?? null) : null;

  return {
    headline: homeHeadline({
      revenueOre: km.revenueOre,
      orders: km.orderCount,
      profitOre: km.profitOre,
      marginBp: km.marginBp,
      unpricedShareBp: unpriced?.shareBp ?? 0,
      revenueChangeBp:
        prevKm && prevKm.revenueOre > 0 ? changeBp(km.revenueOre, prevKm.revenueOre) : null,
      coverage,
      period,
      today,
      dataStart,
      peak:
        peakDate && daily && daily.peakIndex !== null
          ? { date: peakDate, revenueOre: daily.revenueOre[daily.peakIndex] ?? 0 }
          : null,
    }),
    period,
    compare,
    coverage,
    comparable,
    dataStart,
    kpis,
    daily,
    unpriced,
    topTitles,
    insights,
    todos,
    todoCount: count,
  };
}

/** Veckodagens namn för ett affärsdatum (1 = måndag). */
export function weekdayOf(date: IsoDate): string {
  return ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"][dayOfWeek(date) - 1] ?? "";
}
