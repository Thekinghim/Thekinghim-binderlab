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
import { todoInScope, type AnalyticsOrder, type TodoItem, type TodoLevel } from "@/analytics/todos";
import type { LostSalesSummary } from "@/server/purchasing/types";
import {
  addDays,
  changeBp,
  dayOfWeek,
  keyMetrics,
  maxDate,
  periodDays,
  profitability,
  vmbPreliminary,
  roundHalfUp,
  type IsoDate,
  type KeyMetrics,
  type Period,
  type ProfitabilityInput,
  type ProfitabilityRow,
} from "@/domain";
import { todayIn, toIsoDate } from "@/components/shell/period-state";
import type { DataScope, MachineRecord, SyncInfo, TitleRecord } from "@/server/data/core/types";
import type { EconomicsSources } from "@/domain";
import { ALL_COST_LINES, type CostLines } from "@/lib/cost-lines";
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
  /** Grunden när den inte är hela intäkten: marginalen gäller bara order med inköpspris. */
  readonly note: string | null;
  /** Vinstens delar under talet (bara vinsten): "Vår del · Butikernas del". Annars tom. */
  readonly parts?: readonly HomeKpiPart[];
}

/** En del av ett nyckeltal, i samma enhet (öre). */
export interface HomeKpiPart {
  readonly id: "ours" | "stores";
  readonly label: string;
  readonly value: number;
}

/**
 * Hela vinsten och hur den delas: vår vinst (som på Lönsamhet) plus butikernas del
 * (butiksersättningen: vinstandel eller provision och hyra, på order med inköpspris).
 * Med butiksfilter gäller den butiken. Efter VMB-moms med vyknappen "Med VMB".
 */
export interface HomeProfitSplit {
  /** Vår vinst + butikernas del (öre). */
  readonly totalOre: number;
  /** Vår vinst, samma som Lönsamhetens vinst (öre). */
  readonly ourOre: number;
  /** Butikernas (med filter: butikens) del, samma som Lönsamhetens butiksersättning (öre). */
  readonly storesOre: number;
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
  /** I dag ingår i perioden och har order, men dagen pågår och visas inte i diagrammet. */
  readonly todayPartial: boolean;
  readonly kpis: HomeKpi[];
  /** Hela vinsten och delningen, eller null när vinsten inte går att räkna (inga inköpspriser). */
  readonly profitSplit: HomeProfitSplit | null;
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
  /** Hyra och fasta kostnader finns (annars döljs "före fasta kostnader"). Saknas = finns. */
  readonly costLines?: CostLines;
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
 * slutar i dag, bara t.o.m. i går (dagen pågår, eller har inga order än). Bara en period
 * som är just i dag visar dagen. null om inga dagar återstår.
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
  // Dagen som pågår är bara delvis med: i en period på flera dagar slutar diagrammet i går,
  // så att den halva dagen inte ritas som ett ras och inte drar ned snittet per dag.
  if (end >= today && (!hasOrdersToday || start < today)) end = addDays(today, -1);
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

/**
 * Hela vinsten för en rad: vår vinst + butiksersättningen. Liggaren drar ersättningen
 * (och VMB-momsen) från vinsten, så summan är vinsten före butikernas del (berakningar.md).
 */
function totalProfit(row: Pick<ProfitabilityRow, "profitOre" | "compensationOre">): number {
  return row.profitOre + row.compensationOre;
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
  // Samma regel som Att göra (todoInScope): automaten och butiken; punkter om en butik
  // (rapport, avtal) följer butiken, med bara automatfilter automatens butik.
  return todos.filter((t) => todoInScope(t, scope, machines));
}

// ---------------------------------------------------------------------------
// Delar
// ---------------------------------------------------------------------------

function buildKpis(args: {
  km: KeyMetrics;
  prev: KeyMetrics | null;
  /** Hela vinsten och delningen i perioden (null utan order med inköpspris). */
  split: HomeProfitSplit | null;
  /** Hela vinsten i jämförelseperioden. */
  prevTotalOre: number | null;
  /** Med butiks- eller automatfilter: delen heter "Butikens del". */
  filtered: boolean;
  days: ProfitabilityRow[];
  prevDays: ProfitabilityRow[];
  compareDays: number;
  unpriced: HomeUnpriced | null;
  /** Vinsten bär VMB-moms; `preliminary` när perioden inte är avslutade hela månader. */
  vmb: { readonly applies: boolean; readonly preliminary: boolean };
  /** Det finns fasta kostnader: vinsten heter "Vinst före fasta kostnader". */
  fixedCosts: boolean;
}): HomeKpi[] {
  const { km, prev, split, prevTotalOre, filtered, days, prevDays, compareDays, unpriced, vmb } =
    args;
  const priced = split !== null;
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
  const prevDailyProfit = prevDays.reduce((n, r) => n + totalProfit(r), 0);
  const parts: HomeKpiPart[] =
    split && (filtered || split.storesOre !== 0)
      ? filtered
        ? [
            { id: "stores", label: "Butikens del", value: split.storesOre },
            { id: "ours", label: "Vår del", value: split.ourOre },
          ]
        : [
            { id: "ours", label: "Vår del", value: split.ourOre },
            { id: "stores", label: "Butikernas del", value: split.storesOre },
          ]
      : [];

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
      label: args.fixedCosts ? "Vinst före fasta kostnader" : "Vinst",
      unit: "ore",
      value: split ? split.totalOre : null,
      delta: hasPrev && split ? relative(split.totalOre, prevTotalOre) : null,
      deltaKind: "relative",
      trend: priced ? days.map(totalProfit) : [],
      reference: hasPrev && priced ? perDay(prevDailyProfit, compareDays) : null,
      alertText:
        unpriced && unpriced.orders > 0
          ? `${unpricedShareText(unpriced.shareBp)} av intäkten saknar inköpspris`
          : null,
      note:
        priced && vmb.applies
          ? vmb.preliminary
            ? "efter VMB-moms (preliminär)"
            : "efter VMB-moms"
          : null,
      parts,
    },
    {
      id: "margin",
      // Vår vinst / intäkt, som på Lönsamhet (inte hela vinsten ovan).
      label: "Vår marginal",
      unit: "bp",
      value: km.marginBp,
      delta: hasPrev ? marginDelta : null,
      deltaKind: "absolute",
      trend: priced ? marginTrend : [],
      reference: hasPrev ? prevMargin : null,
      alertText: null,
      // Marginalen räknas på order med inköpspris (berakningar.md 6), intäkten bredvid på alla.
      note: unpriced && unpriced.orders > 0 && priced ? "på order med inköpspris" : null,
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
  ].map((k) => ({
    note: null,
    ...k,
    trend: days.length > 1 ? k.trend : [],
  })) as HomeKpi[];
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
function shownElsewhere(
  insight: Insight,
  hasChart: boolean,
  staleTodoMachines: ReadonlySet<string>,
): boolean {
  const { kind } = insight;
  if (kind === "period-summary" || kind === "top-title") return true;
  // En tyst automat som redan står bland punkterna från Att göra (i timmar) upprepas inte
  // här i dagar.
  if (kind === "stale-machine") {
    return insight.evidence.machineIds.some((id) => staleTodoMachines.has(id));
  }
  return kind === "best-day" && hasChart;
}

function buildInsights(
  input: HomeModelInput,
  scope: DataScope,
  period: Period,
  compare: Period | null,
  hasChart: boolean,
  staleTodoMachines: ReadonlySet<string>,
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
    .filter((i) => !shownElsewhere(i, hasChart, staleTodoMachines))
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
  staleTodoMachines: ReadonlySet<string>,
): HomeInsight[] {
  try {
    return buildInsights(input, input.scope, period, compare, hasChart, staleTodoMachines);
  } catch (error) {
    console.error("[hem] Värt att veta kunde inte räknas:", error);
    return [];
  }
}

function buildTodos(
  todos: readonly TodoItem[] | null,
  scope: DataScope,
  machines: readonly MachineRecord[],
): { todos: HomeTodo[] | null; count: number; nowCount: number; staleMachines: Set<string> } {
  if (todos === null) return { todos: null, count: 0, nowCount: 0, staleMachines: new Set() };
  const relevant = todosInScope(todos, scope, machines);
  const filtered = Boolean(scope.machineId || scope.storeId);
  // computeTodos sorterar redan efter brådska; nivån går ändå först om listan kommer osorterad.
  const shown = relevant
    .map((t, i) => ({ t, i }))
    .sort((a, b) => LEVEL_ORDER[a.t.level] - LEVEL_ORDER[b.t.level] || a.i - b.i)
    .slice(0, HOME_TODO_COUNT);
  const staleMachines = new Set(
    shown.filter(({ t }) => t.kind === "stale-machine").flatMap(({ t }) => t.evidence.machineIds),
  );
  const top = shown.map(({ t }) => ({
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
    staleMachines,
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
  const todayPartial =
    period.start <= today && period.end >= today && hasOrdersToday && periodDays(period) > 1;

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

  // Hela vinsten = vår vinst + butikernas del, ur samma liggare som Lönsamhet och Butiker.
  const profitSplit: HomeProfitSplit | null = priced
    ? {
        totalOre: totalProfit(byTitle.totals),
        ourOre: byTitle.totals.profitOre,
        storesOre: byTitle.totals.compensationOre,
      }
    : null;
  const prevTotalOre = previous ? totalProfit(profitability(previous, "title").totals) : null;

  const kpis = buildKpis({
    km,
    prev: prevKm,
    split: profitSplit,
    prevTotalOre,
    filtered: Boolean(input.scope.storeId || input.scope.machineId),
    days,
    prevDays,
    compareDays,
    unpriced,
    vmb: { applies: byTitle.vmb.applies, preliminary: vmbPreliminary(byTitle.vmb, today) },
    fixedCosts: (input.costLines ?? ALL_COST_LINES).fixed,
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
  const { todos, count, nowCount, staleMachines } = buildTodos(
    input.todos,
    input.scope,
    input.machines,
  );
  let insights: HomeInsight[] = [];
  if (coverage && km.orderCount > 0) {
    insights = safeInsights(
      input,
      { start: coverage.start, end: period.end },
      compare,
      daily !== null,
      staleMachines,
    );
  }

  return {
    headline: homeHeadline({
      revenueOre: km.revenueOre,
      orders: km.orderCount,
      pricedOrders: byTitle.totals.pricedOrders,
      profitOre: profitSplit?.totalOre ?? km.profitOre,
      ourProfitOre: profitSplit && profitSplit.storesOre !== 0 ? profitSplit.ourOre : null,
      storesProfitOre: profitSplit && profitSplit.storesOre !== 0 ? profitSplit.storesOre : null,
      filtered: Boolean(input.scope.storeId || input.scope.machineId),
      marginBp: km.marginBp,
      unpricedShareBp: unpriced?.shareBp ?? 0,
      revenueChangeBp:
        prevKm && prevKm.revenueOre > 0 ? changeBp(km.revenueOre, prevKm.revenueOre) : null,
      period,
      today,
      dataStart,
      hasOrdersToday,
      fixedCosts: (input.costLines ?? ALL_COST_LINES).fixed,
    }),
    period,
    compare,
    coverage,
    comparable,
    dataStart,
    todayPending,
    todayPartial,
    kpis,
    profitSplit,
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
  /**
   * Titlar × automater som är slut just nu (som Att göra). 0 när perioden slutar före i går
   * (då gäller inte "just nu" perioden).
   */
  readonly ongoing: number;
}

/**
 * Förlorad försäljning som Hem visar den, eller null när inget förlorats. `today` är
 * dagens affärsdatum: "slut just nu" räknas bara när perioden går fram till i går eller i
 * dag. `emptyNow` är antalet titlar som är slut i en automat enligt Att göra (påfyllnings-
 * punkter med saldo 0, i filtret), så att Hem och Att göra säger samma sak; utan Att göra
 * räknas de perioder som pågår och har kostat något.
 */
export function homeLostSales(
  summary: LostSalesSummary | null,
  today: IsoDate,
  emptyNow: number | null = null,
): HomeLostSales | null {
  if (!summary || summary.lostRevenueOre <= 0) return null;
  const current = summary.period.end >= addDays(today, -1);
  const ongoing =
    emptyNow ?? summary.series.filter((x) => x.ongoing && x.lostRevenueOre > 0).length;
  return {
    text: summary.text,
    href: summary.href,
    lostRevenueOre: summary.lostRevenueOre,
    ongoing: current ? ongoing : 0,
  };
}

/** Titlar som är slut i en automat enligt Att göra (påfyllning med saldo 0), i filtret. */
export function emptyRefillsInScope(
  todos: readonly TodoItem[],
  scope: DataScope,
  machines: readonly MachineRecord[],
): number {
  return todosInScope(todos, scope, machines).filter(
    (t) =>
      t.kind === "refill" && (t.evidence.figures.find((f) => f.key === "onHand")?.value ?? 1) <= 0,
  ).length;
}

// ---------------------------------------------------------------------------
// Inaktuell import
// ---------------------------------------------------------------------------

/** Timmar utan ny import innan Hem varnar (samma gräns som skalets STALE_SYNC_HOURS). */
export const HOME_STALE_IMPORT_HOURS = 26;

/** Senaste importen när den är gammal: affärsdagen den gjordes. */
export interface HomeStaleImport {
  /** Affärsdagen för senaste lyckade import (ÅÅÅÅ-MM-DD). */
  readonly date: IsoDate;
}

/**
 * Varningen om inaktuell import, eller null. Visas bara när det finns en import, den är
 * äldre än HOME_STALE_IMPORT_HOURS och perioden slutar samma dag eller senare (en period
 * som slutade före importen är redan komplett).
 */
export function homeStaleImport(
  sync: SyncInfo | null,
  periodEnd: IsoDate,
  now: Date | string,
  timeZone: string,
): HomeStaleImport | null {
  if (!sync?.syncedAt) return null;
  const at = new Date(sync.syncedAt);
  if (Number.isNaN(at.getTime())) return null;
  if (new Date(now).getTime() - at.getTime() <= HOME_STALE_IMPORT_HOURS * 3_600_000) return null;
  const date = toIsoDate(todayIn(at, timeZone));
  if (periodEnd < date) return null;
  return { date };
}
