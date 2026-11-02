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
import type { LostSalesSummary } from "@/server/purchasing/types";
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
  readonly rest: {
    readonly titles: number;
    readonly orders: number;
    readonly revenueOre: number;
    /** Andel av periodens intäkt i bp. */
    readonly shareBp: number;
    /** Antal av de sammanslagna titlarna som har order utan inköpspris. */
    readonly unpricedTitles: number;
  } | null;
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
  /** Punkten gäller hela organisationen fast sidan är filtrerad på butik eller automat. */
  readonly orgWide: boolean;
}

export interface HomeModel {
  readonly headline: HomeHeadline;
  /** Perioden i skalet. Nyckeltal, vinst och marginal gäller hela den (som på Lönsamhet). */
  readonly period: Period;
  /** Skalets jämförelseperiod när den ligger helt inom datan, annars null. */
  readonly compare: Period | null;
  /**
   * Dagarna som diagrammet och dagserierna visar: från första ordern och, när perioden
   * slutar i dag utan order ännu, t.o.m. i går. null = inga sådana dagar.
   */
  readonly coverage: Period | null;
  /** Jämförelseperioden ligger helt inom data, så att förändringar är meningsfulla. */
  readonly comparable: boolean;
  readonly dataStart: IsoDate | null;
  /** I dag ingår i perioden men har inga order ännu (och visas därför inte i diagrammet). */
  readonly todayPending: boolean;
  readonly kpis: HomeKpi[];
  readonly daily: HomeDaily | null;
  readonly unpriced: HomeUnpriced | null;
  readonly topTitles: HomeTopTitles;
  readonly insights: HomeInsight[];
  /** De viktigaste punkterna i Att göra, eller null när rollen inte har Att göra. */
  readonly todos: HomeTodo[] | null;
  /** Antal punkter i Att göra totalt (efter filter). */
  readonly todoCount: number;
  /** Antal av dem som gäller nu (nivå "now"). */
  readonly todoNowCount: number;
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
 * Dagarna som diagrammet visar: från första ordern (organisationens) och, om perioden
 * slutar i dag och ingen order kommit i dag, bara t.o.m. i går. null om inga dagar återstår.
 * Bara visning: nyckeltalen gäller hela perioden.
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
      .filter((m) => (scope.machineId ? m.id === scope.machineId : m.storeId === scope.storeId))
      .map((m) => m.id),
  );
  // Som Att göra: punkter med automat följer automaten, punkter om en butik (rapport,
  // avtal) följer butiksfiltret, och resten gäller hela organisationen.
  return todos.filter((t) => {
    if (t.evidence.machineIds.length > 0)
      return t.evidence.machineIds.some((id) => inScope.has(id));
    if (scope.storeId && t.evidence.storeIds.length > 0) {
      return t.evidence.storeIds.includes(scope.storeId);
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Delar
// ---------------------------------------------------------------------------

function buildKpis(args: {
  km: KeyMetrics;
  prev: KeyMetrics | null;
  /** Det finns order med inköpspris, så att vinsten går att räkna. */
  priced: boolean;
  days: ProfitabilityRow[];
  prevDays: ProfitabilityRow[];
  compareDays: number;
  unpriced: HomeUnpriced | null;
}): HomeKpi[] {
  const { km, prev, priced, days, prevDays, compareDays, unpriced } = args;
  const revenueTrend = days.map(rowRevenue);
  const marginTrend = carryForward(days.map((r) => r.marginBp));
  const aovTrend = carryForward(
    days.map((r) => (r.orders > 0 ? roundHalfUp(rowRevenue(r), r.orders) : null)),
  );
  const prevMargin = prev?.marginBp ?? null;
  const marginDelta =
    km.marginBp !== null && prevMargin !== null ? (km.marginBp - prevMargin) / 100 : null;
  const hasPrev = prev !== null && compareDays > 0;
  // Dagsraderna saknar hyra som ingen order bär (raden "ej fördelad"); referensen räknas
  // därför ur jämförelseperiodens dagsrader, så att linje och referens jämför samma sak.
  const prevDailyProfit = prevDays.reduce((n, r) => n + r.profitOre, 0);

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
      value: priced ? km.profitOre : null,
      delta: hasPrev && priced ? relative(km.profitOre, prev.profitOre) : null,
      deltaKind: "relative",
      trend: priced ? days.map((r) => r.profitOre) : [],
      reference: hasPrev && priced ? perDay(prevDailyProfit, compareDays) : null,
      alertText:
        unpriced && unpriced.orders > 0
          ? `${unpricedShareText(unpriced.shareBp)} av intäkten saknar inköpspris`
          : null,
    },
    {
      id: "margin",
      label: "Marginal",
      unit: "bp",
      value: km.marginBp,
      delta: hasPrev ? marginDelta : null,
      deltaKind: "absolute",
      trend: priced ? marginTrend : [],
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
  ].map((k) => ({ ...k, trend: days.length > 1 ? k.trend : [] })) as HomeKpi[];
}

/** Andel i bp som procent: hela procent, en decimal under 1 %. */
export function shareText(bp: number): string {
  return formatPercent(bp / 10_000, bp < 100 ? 1 : 0);
}

/** Andelen utan inköpspris, med en decimal som på Lönsamhet ("4,8 %"). */
export function unpricedShareText(bp: number): string {
  return formatPercent(bp / 10_000, 1);
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
        b.revenueOre - a.revenueOre || b.orders - a.orders || a.name.localeCompare(b.name, "sv-SE"),
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
            shareBp: share(others.reduce((n, r) => n + r.revenueOre, 0)),
            unpricedTitles: others.filter((r) => r.unpriced).length,
          }
        : null,
    totalTitles: items.length,
  };
}

/**
 * Regler vars iakttagelse redan står på Hem: intäkten i rubriken, bästa dagen i diagrammet
 * och mest sålda titel i topplistan. De visas inte i Värt att veta, så att samma uppgift
 * inte står flera gånger på sidan.
 */
function shownElsewhere(kind: Insight["kind"], hasChart: boolean): boolean {
  if (kind === "period-summary" || kind === "top-title") return true;
  return kind === "best-day" && hasChart;
}

function buildInsights(
  input: HomeModelInput,
  scope: DataScope,
  period: Period,
  compare: Period | null,
  hasChart: boolean,
): HomeInsight[] {
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
    period,
    compare,
    {
      now: input.now,
      timeZone: input.timeZone,
      // Hämta fler än som visas: de som redan står på sidan tas bort nedan.
      maxCount: HOME_INSIGHT_COUNT + 3,
      minCount: HOME_INSIGHT_COUNT + 3,
    },
  );
  return insights
    .filter((i) => !shownElsewhere(i.kind, hasChart))
    .slice(0, HOME_INSIGHT_COUNT)
    .map((i) => {
      const titleId = i.kind === "concentration" ? i.evidence.titleIds[0] : undefined;
      return {
        key: i.key,
        tone: i.tone,
        text: i.text,
        detail: i.detail,
        href: appHref(i.link, scope, titleId ? { titel: titleId } : {}),
      };
    });
}

/** Ett fel i en regel för Värt att veta får inte stoppa Hem: då visas inga iakttagelser. */
function safeInsights(
  input: HomeModelInput,
  period: Period,
  compare: Period | null,
  hasChart: boolean,
): HomeInsight[] {
  try {
    return buildInsights(input, input.scope, period, compare, hasChart);
  } catch (error) {
    console.error("[hem] Värt att veta kunde inte räknas:", error);
    return [];
  }
}

function buildTodos(
  todos: readonly TodoItem[] | null,
  scope: DataScope,
  machines: readonly MachineRecord[],
): { todos: HomeTodo[] | null; count: number; nowCount: number } {
  if (todos === null) return { todos: null, count: 0, nowCount: 0 };
  const relevant = todosInScope(todos, scope, machines);
  const filtered = Boolean(scope.machineId || scope.storeId);
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
      orgWide: filtered && t.evidence.machineIds.length === 0 && t.evidence.storeIds.length === 0,
    }));
  return {
    todos: top,
    count: relevant.length,
    nowCount: relevant.filter((t) => t.level === "now").length,
  };
}

// ---------------------------------------------------------------------------
// Modellen
// ---------------------------------------------------------------------------

export function buildHomeModel(input: HomeModelInput): HomeModel {
  const { period, dataStart, today } = input;
  const titleName = (() => {
    const map = new Map(input.titles.map((t) => [t.id, t.name.trim() || t.id]));
    return (id: string) => map.get(id) ?? "Okänd titel";
  })();

  // Nyckeltal, vinst och marginal gäller hela perioden i skalet, som på Lönsamhet: hyran
  // räknas för varje dag automaten står i butiken, oavsett om den sålde (berakningar.md §4).
  // Jämförelsen gäller skalets jämförelseperiod, och bara när den ligger helt inom datan:
  // dagar före första ordern har ingen försäljning att jämföra med.
  const current = input.current;
  const comparable =
    input.compare !== null &&
    input.previous !== null &&
    dataStart !== null &&
    input.compare.start >= dataStart;
  const compare = comparable ? input.compare : null;
  const previous = comparable ? input.previous : null;

  const hasOrdersToday = current.orders.some((o) => o.businessDate === today);
  const coverage = coverageOf(period, dataStart, today, hasOrdersToday);
  const todayPending =
    period.start <= today && period.end >= today && !hasOrdersToday && periodDays(period) > 1;

  const km = keyMetrics(current);
  const prevKm = previous ? keyMetrics(previous) : null;

  const byTitle = profitability(current, "title");
  const priced = byTitle.totals.pricedOrders > 0;
  const unpricedSummary = byTitle.unpriced;
  const unpriced: HomeUnpriced | null =
    unpricedSummary.orders > 0
      ? {
          orders: unpricedSummary.orders,
          revenueOre: unpricedSummary.revenueOre,
          shareBp: unpricedSummary.shareBp,
          titles: unpricedSummary.byTitle.map((t) => ({
            id: t.titleId,
            name: titleName(t.titleId),
          })),
          href:
            unpricedSummary.titleIds.length === 1 && unpricedSummary.titleIds[0]
              ? `/inkopspriser?titel=${encodeURIComponent(unpricedSummary.titleIds[0])}`
              : "/inkopspriser?saknar=pris",
        }
      : null;

  // Dagserierna (diagram och sparklines) visar dagarna med data; jämförelsen dag för dag
  // från jämförelseperiodens början (den ligger då helt inom datan, så täckningen börjar
  // samma dag som perioden).
  const days = coverage && km.orderCount > 0 ? rowsIn(dayRows(current), coverage) : [];
  const prevDays = previous && compare ? rowsIn(dayRows(previous), compare) : [];
  const compareDays = compare ? periodDays(compare) : 0;

  const kpis = buildKpis({
    km,
    prev: prevKm,
    priced,
    days,
    prevDays,
    compareDays,
    unpriced,
  });

  let daily: HomeDaily | null = null;
  if (days.length > 0) {
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
      compareOre: prevDays.length > 0 ? prevDays.slice(0, days.length).map(rowRevenue) : null,
      peakIndex,
      peakRatioTenths:
        averageOre > 0 && peakIndex !== null ? roundHalfUp(peakValue * 10, averageOre) : null,
      averageOre,
    };
  }

  const topTitles = buildTopTitles(byTitle.rows, km.revenueOre, titleName);
  // Iakttagelserna räknas från första dagen med data, så att snitt per dag och antal
  // veckodagar inte späds ut av dagar före datan.
  let insights: HomeInsight[] = [];
  if (coverage && km.orderCount > 0) {
    insights = safeInsights(
      input,
      { start: coverage.start, end: period.end },
      compare,
      daily !== null,
    );
  }
  const { todos, count, nowCount } = buildTodos(input.todos, input.scope, input.machines);

  return {
    headline: homeHeadline({
      revenueOre: km.revenueOre,
      orders: km.orderCount,
      pricedOrders: byTitle.totals.pricedOrders,
      profitOre: km.profitOre,
      marginBp: km.marginBp,
      unpricedShareBp: unpriced?.shareBp ?? 0,
      revenueChangeBp:
        prevKm && prevKm.revenueOre > 0 ? changeBp(km.revenueOre, prevKm.revenueOre) : null,
      period,
      today,
      dataStart,
    }),
    period,
    compare,
    coverage,
    comparable,
    dataStart,
    todayPending,
    kpis,
    daily,
    unpriced,
    topTitles,
    insights,
    todos,
    todoCount: count,
    todoNowCount: nowCount,
  };
}

/** Veckodagens namn för ett affärsdatum (1 = måndag). */
export function weekdayOf(date: IsoDate): string {
  return (
    ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"][dayOfWeek(date) - 1] ??
    ""
  );
}

/** Förlorad försäljning som Hem visar den: texten och länken till underlaget. */
export interface HomeLostSales {
  /** T.ex. "Slutsålt kostade ca 3 200 kr i oktober." */
  readonly text: string;
  readonly href: string;
  readonly lostRevenueOre: number;
  /** Titlar × automater som är slut just nu (perioden pågår). */
  readonly ongoing: number;
}

/** Förlorad försäljning som Hem visar den, eller null när inget förlorats. */
export function homeLostSales(summary: LostSalesSummary | null): HomeLostSales | null {
  if (!summary || summary.lostRevenueOre <= 0) return null;
  return {
    text: summary.text,
    href: summary.href,
    lostRevenueOre: summary.lostRevenueOre,
    ongoing: summary.series.filter((x) => x.ongoing).length,
  };
}
