/**
 * Lönsamhet: allt sidan visar, räknat ur beräkningslagret (@/domain).
 *
 * Ren funktion utan databas och utan React. Sidan hämtar indata med de gemensamma
 * laddarna (loadDomainInput) och anropar buildLonsamhetModel. Resultatet är
 * serialiserbart (tal, strängar, listor), så att klientkomponenterna kan få det rakt av.
 * Belopp i öre, andelar i bp, affärsdatum 'ÅÅÅÅ-MM-DD'.
 *
 * Ingen ekonomi räknas här: vinst, marginal, avdrag, ej fördelad hyra och order utan
 * inköpspris kommer från profitabilityViews, största bidragsgivaren från topContributor
 * och förändringen från changeBp. Här väljs, namnges och formuleras bara.
 */

import {
  changeBp,
  monthEnd,
  monthStart,
  NO_MACHINE_KEY,
  NO_STORE_KEY,
  periodDays,
  profitability,
  profitabilityViews,
  ratioBp,
  topContributor,
  UNALLOCATED_KEY,
  weekOf,
  type IsoDate,
  type Period,
  type ProfitabilityInput,
  type ProfitabilityResult,
  type ProfitabilityRow,
} from "@/domain";
import { formatDay, formatMonth, formatPeriodShort, formatWeekdayDay } from "@/lib/format";
import type { DataScope, MachineRecord, StoreRecord, TitleRecord } from "@/server/data/core/types";
import { coverageDays, isoDateToShellDate } from "@/server/data/core/period";

import {
  lonsamhetHeadline,
  trendTitle,
  viewTitle,
  type Headline,
  type SectionTitle,
  type TrendTitleInput,
} from "./headline";

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

export type ViewKey = "title" | "machine" | "store";
export type TrendKey = "day" | "week" | "month";

export const VIEW_KEYS: readonly ViewKey[] = ["title", "machine", "store"];
export const TREND_KEYS: readonly TrendKey[] = ["day", "week", "month"];

/** Vad en rad i tabellen är. */
export type LineKind = "item" | "unallocated" | "no-machine" | "no-store";

/** En rad i tabellen (per titel, automat eller butik). Belopp i öre. */
export interface ProfitLine {
  readonly key: string;
  readonly kind: LineKind;
  /** Visningsnamn: titelns namn, automatens namn, butikens namn eller den särskilda radens namn. */
  readonly name: string;
  /** Automatens kod ("BL-001"), annars null. */
  readonly code: string | null;
  readonly orders: number;
  /** Intäkt för order med inköpspris (det som ingår i vinsten). */
  readonly revenueOre: number;
  readonly costOre: number;
  readonly feesOre: number;
  readonly compensationOre: number;
  readonly profitOre: number;
  /** Marginal i bp, null när intäkten med pris är 0. */
  readonly marginBp: number | null;
  /** Order utan inköpspris och deras intäkt (ingår inte i vinsten). */
  readonly unpricedOrders: number;
  readonly unpricedRevenueOre: number;
  /** Länk till inköpspriset för titeln, när titeln har order utan pris. */
  readonly priceHref: string | null;
}

/** En dag, vecka eller månad i utvecklingen. */
export interface TrendBucket {
  readonly key: string;
  /** Kort etikett för axeln: "26 okt", "V42", "okt.". */
  readonly axis: string;
  /** Rubrik i läsrutan: "Vecka 42 · 13–18 okt.", "okt. · 13–31 okt.". */
  readonly name: string;
  /** I löptext: "26 okt.", "vecka 42", "oktober". */
  readonly shortName: string;
  readonly start: IsoDate;
  readonly end: IsoDate;
  /** Bara en del av veckan/månaden ligger i perioden. */
  readonly partial: boolean;
  readonly orders: number;
  readonly revenueOre: number;
  readonly profitOre: number;
  readonly marginBp: number | null;
  readonly unpricedOrders: number;
  readonly unpricedRevenueOre: number;
}

export interface TrendSeries {
  readonly buckets: TrendBucket[];
  /** Sektionsrubriken för upplösningen. */
  readonly heading: SectionTitle;
  /**
   * Hyra som inte bärs av någon order och därför inte ligger på någon dag eller vecka
   * (i månadsvyn ligger den på månadens rad). Ingår i totalen.
   */
  readonly unallocatedProfitOre: number;
}

/** En titel med order utan inköpspris. */
export interface UnpricedTitleLine {
  readonly titleId: string;
  readonly name: string;
  readonly orders: number;
  readonly revenueOre: number;
  /** Andel av periodens intäkt (alla order) i bp. */
  readonly shareBp: number;
  readonly firstDate: IsoDate;
  readonly lastDate: IsoDate;
  readonly href: string;
}

export interface UnpricedBlock {
  readonly orders: number;
  readonly revenueOre: number;
  /** Andel av periodens intäkt (alla order) som saknar inköpspris, i bp. */
  readonly shareBp: number;
  readonly titles: UnpricedTitleLine[];
}

/** Vattenfallet: Intäkt → Inköp → Avgifter → Butiksersättning → Vinst (prissatta order). */
export interface Bridge {
  readonly revenueOre: number;
  readonly costOre: number;
  readonly feesOre: number;
  readonly compensationOre: number;
  readonly commissionOre: number;
  readonly rentOre: number;
  /** Del av hyran som inte bärs av någon prissatt order (ingår i rentOre). */
  readonly unallocatedRentOre: number;
  readonly profitOre: number;
  readonly marginBp: number | null;
  readonly unpricedRevenueOre: number;
}

/** Ett nyckeltal i remsan. */
export interface Kpi {
  readonly id: "profit" | "margin" | "revenue" | "compensation" | "orders";
  readonly label: string;
  readonly unit: "ore" | "bp" | "count";
  readonly value: number | null;
  /** Relativ förändring som andel (0,12 = +12 %), eller p.e. för marginalen. null utan jämförelse. */
  readonly delta: number | null;
  readonly deltaKind: "relative" | "absolute";
  /** Minskning är bra. */
  readonly invert: boolean;
  readonly primary: boolean;
}

export interface LonsamhetModel {
  readonly period: Period;
  readonly compare: Period | null;
  /** "13 okt. – 1 nov." */
  readonly periodLabel: string;
  /** "Jämfört med 14 sep. – 3 okt.", eller null utan jämförbar period med order. */
  readonly comparisonLabel: string | null;
  readonly days: number;
  readonly scope: DataScope;
  /** Beskrivning av filtret ("BL-001 Automat 1"), eller null utan filter. */
  readonly scopeLabel: string | null;
  readonly orders: number;
  readonly pricedOrders: number;
  readonly headline: Headline;
  readonly kpis: Kpi[];
  readonly bridge: Bridge;
  readonly views: Record<ViewKey, ProfitLine[]>;
  /** Sektionsrubrik per vy: vem som gav mest vinst. */
  readonly viewTitles: Record<ViewKey, SectionTitle>;
  readonly totals: ProfitLine;
  readonly trend: Record<TrendKey, TrendSeries>;
  /** Förvald upplösning: vecka upp till ~26 veckor, annars månad. Dag väljs av användaren. */
  readonly defaultTrend: TrendKey;
  readonly unpriced: UnpricedBlock;
  readonly calcVersion: string;
}

/** Det modellen behöver av DomainInput (så att testerna kan bygga den utan databas). */
export interface LonsamhetInput {
  readonly current: ProfitabilityInput;
  readonly previous: ProfitabilityInput | null;
  readonly titles: readonly TitleRecord[];
  readonly machines: readonly MachineRecord[];
  readonly stores: readonly StoreRecord[];
  readonly scope: DataScope;
}

export interface LonsamhetOptions {
  /** I dag (organisationens affärsdatum), för att utelämna innevarande år i etiketter. */
  readonly today: IsoDate;
  /** Skalets parametrar som bärs med i länkar (t.ex. "period=30d"), utan "?". */
  readonly carry?: string;
  /** Senaste orderns affärsdatum i urvalet (för tomt läge), eller null utan order alls. */
  readonly lastOrderDate?: IsoDate | null;
  /** Första dagen med data (organisationen). Med den räknas dagarna som på övriga sidor. */
  readonly dataStart?: IsoDate | null;
  /** Om organisationen har order i dag (dagen räknas då med). */
  readonly hasOrdersToday?: boolean;
}

// ---------------------------------------------------------------------------
// Namn och länkar
// ---------------------------------------------------------------------------

const SPECIAL_NAMES: Record<Exclude<LineKind, "item">, string> = {
  unallocated: "Ej fördelad hyra",
  "no-machine": "Utan kopplad automat",
  "no-store": "Utan butik",
};

function lineKind(row: ProfitabilityRow): LineKind {
  if (row.key === UNALLOCATED_KEY || row.kind === "unallocated") return "unallocated";
  if (row.key === NO_MACHINE_KEY || row.kind === "no-machine") return "no-machine";
  if (row.key === NO_STORE_KEY || row.kind === "no-store") return "no-store";
  return "item";
}

/**
 * Länk till inköpspriserna för en titel, med skalets period och filter. Ankaret #titel
 * leder till formuläret, som sidans egna länkar.
 */
export function priceHref(titleId: string, carry?: string): string {
  const q = new URLSearchParams(carry ?? "");
  q.delete("titel");
  const rest = q.toString();
  return `/inkopspriser?titel=${encodeURIComponent(titleId)}${rest ? `&${rest}` : ""}#titel`;
}

interface Names {
  title(id: string): string;
  machine(id: string): { name: string; code: string | null };
  store(id: string): string;
}

function namesFor(input: LonsamhetInput): Names {
  const titles = new Map(input.titles.map((t) => [t.id, t]));
  const machines = new Map(input.machines.map((m) => [m.id, m]));
  const stores = new Map(input.stores.map((s) => [s.id, s]));
  return {
    title: (id) => titles.get(id)?.name ?? "Okänd titel",
    machine: (id) => {
      const m = machines.get(id);
      return m ? { name: m.name, code: m.code || null } : { name: "Okänd automat", code: null };
    },
    store: (id) => stores.get(id)?.name ?? "Okänd butik",
  };
}

function toLine(
  row: ProfitabilityRow,
  view: ViewKey | "total",
  names: Names,
  carry: string | undefined,
): ProfitLine {
  const kind = row.kind === "total" ? "item" : lineKind(row);
  let name = "Totalt";
  let code: string | null = null;
  if (view !== "total") {
    if (kind !== "item") name = SPECIAL_NAMES[kind];
    else if (view === "title") name = names.title(row.key);
    else if (view === "machine") ({ name, code } = names.machine(row.key));
    else name = names.store(row.key);
  }
  return {
    key: row.key,
    kind,
    name,
    code,
    orders: row.orders,
    revenueOre: row.revenueOre,
    costOre: row.costOre,
    feesOre: row.feesOre,
    compensationOre: row.compensationOre,
    profitOre: row.profitOre,
    marginBp: row.marginBp,
    unpricedOrders: row.unpricedOrders,
    unpricedRevenueOre: row.unpricedRevenueOre,
    priceHref:
      view === "title" && kind === "item" && row.unpricedOrders > 0
        ? priceHref(row.key, carry)
        : null,
  };
}

// ---------------------------------------------------------------------------
// Etiketter för perioder
// ---------------------------------------------------------------------------

function shellPeriod(p: Period): { start: Date; end: Date } {
  return { start: isoDateToShellDate(p.start), end: isoDateToShellDate(p.end) };
}

/** "13 okt. – 1 nov." (året utelämnas när allt ligger i innevarande år). */
export function periodText(p: Period, today: IsoDate): string {
  return formatPeriodShort(shellPeriod(p), isoDateToShellDate(today));
}

function trendBucket(row: ProfitabilityRow, groupBy: TrendKey, today: IsoDate): TrendBucket {
  const range = row.range ?? { start: row.key, end: row.key };
  const rangeText = periodText(range, today);
  let axis: string;
  let name: string;
  let shortName: string;
  if (groupBy === "day") {
    const d = isoDateToShellDate(range.start);
    axis = formatDay(d);
    name = formatWeekdayDay(d);
    shortName = periodText(range, today);
  } else if (groupBy === "week") {
    const w = weekOf(range.start);
    axis = `V${w.week}`;
    name = `Vecka ${w.week} · ${rangeText}`;
    shortName = `vecka ${w.week}`;
  } else {
    const month = range.start.slice(0, 7);
    const full = periodText({ start: monthStart(month), end: monthEnd(month) }, today);
    axis = full;
    name = row.partial ? `${full} · ${rangeText}` : full;
    shortName = formatMonth(isoDateToShellDate(range.start), { year: "never" });
  }
  return {
    key: row.key,
    axis,
    name,
    shortName,
    start: range.start,
    end: range.end,
    partial: row.partial,
    orders: row.orders,
    revenueOre: row.revenueOre,
    profitOre: row.profitOre,
    marginBp: row.marginBp,
    unpricedOrders: row.unpricedOrders,
    unpricedRevenueOre: row.unpricedRevenueOre,
  };
}

function trendSeries(result: ProfitabilityResult, groupBy: TrendKey, today: IsoDate): TrendSeries {
  const buckets: TrendBucket[] = [];
  let unallocated = 0;
  for (const row of result.rows) {
    if (row.kind === "time") buckets.push(trendBucket(row, groupBy, today));
    else unallocated += row.profitOre;
  }
  buckets.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  // Bara fakta ur raderna: bästa perioden och den senaste hela perioden med order.
  // Inget snitt: delvisa veckor och månader skulle dra ned det.
  let best: TrendBucket | null = null;
  let latestFull: TrendBucket | null = null;
  for (const b of buckets) {
    if (b.orders === 0) continue;
    if (best === null || b.profitOre > best.profitOre) best = b;
    if (!b.partial) latestFull = b;
  }
  const heading = trendTitle({
    unit: TREND_UNIT[groupBy],
    buckets: buckets.filter((b) => b.orders > 0).length,
    best: best ? { name: best.shortName, profitOre: best.profitOre } : null,
    latestFull:
      latestFull && latestFull !== best && groupBy !== "day"
        ? { profitOre: latestFull.profitOre }
        : null,
    losses: buckets.filter((b) => b.orders > b.unpricedOrders && b.profitOre < 0).length,
  });
  return { buckets, heading, unallocatedProfitOre: unallocated };
}

const TREND_UNIT: Record<TrendKey, TrendTitleInput["unit"]> = {
  day: "dag",
  week: "vecka",
  month: "månad",
};

// ---------------------------------------------------------------------------
// Modellen
// ---------------------------------------------------------------------------

const NOUNS: Record<ViewKey, { noun: string; plural: string; definite: string }> = {
  title: { noun: "titel", plural: "titlar", definite: "titeln" },
  machine: { noun: "automat", plural: "automater", definite: "automaten" },
  store: { noun: "butik", plural: "butiker", definite: "butiken" },
};

function viewHeading(result: ProfitabilityResult, lines: readonly ProfitLine[], view: ViewKey) {
  const items = lines.filter((l) => l.kind === "item");
  const top = topContributor(result);
  const topLine = top ? items.find((l) => l.key === top.key) : undefined;
  return viewTitle({
    ...NOUNS[view],
    items: items.length,
    top: topLine
      ? {
          name: topLine.name || topLine.code || "",
          profitOre: topLine.profitOre,
          marginBp: topLine.marginBp,
        }
      : null,
    losses: items.filter((l) => l.orders > l.unpricedOrders && l.profitOre < 0).length,
  });
}

function relative(current: number, previous: number): number | null {
  const bp = changeBp(current, previous);
  return bp === null ? null : bp / 10_000;
}

/** Den vy som bäst svarar på "var tjänar vi": automat om det finns flera, annars butik, annars titel. */
function headlineView(views: Record<ViewKey, ProfitabilityResult>): ViewKey {
  const items = (v: ViewKey) => views[v].rows.filter((r) => r.kind === "item").length;
  if (items("machine") > 1) return "machine";
  if (items("store") > 1) return "store";
  return "title";
}

function scopeLabel(input: LonsamhetInput): string | null {
  const names = namesFor(input);
  if (input.scope.machineId) {
    const m = names.machine(input.scope.machineId);
    return m.code ? `${m.code} ${m.name}` : m.name;
  }
  if (input.scope.storeId) return names.store(input.scope.storeId);
  return null;
}

export function buildLonsamhetModel(
  input: LonsamhetInput,
  options: LonsamhetOptions,
): LonsamhetModel {
  const { today, carry } = options;
  const names = namesFor(input);
  const period = input.current.period;

  const all = profitabilityViews(input.current, [
    "title",
    "machine",
    "store",
    "day",
    "week",
    "month",
  ] as const);
  const views: Record<ViewKey, ProfitabilityResult> = {
    title: all.title,
    machine: all.machine,
    store: all.store,
  };
  const totalsRow = all.title.totals;
  const unpriced = all.title.unpriced;
  const allRevenue = totalsRow.revenueOre + totalsRow.unpricedRevenueOre;

  const prevTotals =
    input.previous && input.previous.orders.length > 0
      ? profitability(input.previous, "title").totals
      : null;

  // Rubriken: andel kvar och största bidragsgivaren, i den vy som har flest poster.
  const hv = headlineView(views);
  const top = topContributor(views[hv]);
  const topMachine = top && hv === "machine" ? names.machine(top.key) : null;
  // Bara namnet i rubriken (koden står i tabellen): "Automat 03 står för …", inte "NA-03 Automat 03".
  const topName = top
    ? topMachine
      ? topMachine.name || topMachine.code
      : hv === "store"
        ? names.store(top.key)
        : names.title(top.key)
    : null;

  const lastOrderDate = options.lastOrderDate ?? null;
  // Samma dagräkning som Hem, Butiker och Automater: dagarna med data (dataCoverage).
  const days =
    options.dataStart !== undefined
      ? coverageDays(period, options.dataStart, today, options.hasOrdersToday ?? false) ||
        periodDays(period)
      : periodDays(period);
  const headline = lonsamhetHeadline({
    days,
    periodLabel: periodText(period, today),
    lastOrderLabel: lastOrderDate
      ? periodText({ start: lastOrderDate, end: lastOrderDate }, today)
      : null,
    scopeLabel: scopeLabel(input),
    orders: totalsRow.orders,
    pricedOrders: totalsRow.pricedOrders,
    profitOre: totalsRow.profitOre,
    marginBp: totalsRow.marginBp,
    revenueOre: totalsRow.revenueOre,
    costOre: totalsRow.costOre,
    feesOre: totalsRow.feesOre,
    compensationOre: totalsRow.compensationOre,
    unpricedShareBp: unpriced.shareBp,
    top:
      top && topName
        ? { name: topName, profitOre: top.profitOre, shareOfProfitBp: top.shareOfProfitBp }
        : null,
    previous: prevTotals
      ? { profitOre: prevTotals.profitOre, marginBp: prevTotals.marginBp }
      : null,
  });

  const kpis: Kpi[] = [
    {
      id: "profit",
      label: totalsRow.profitOre < 0 ? "Förlust" : "Vinst",
      unit: "ore",
      value: totalsRow.profitOre,
      delta: prevTotals ? relative(totalsRow.profitOre, prevTotals.profitOre) : null,
      deltaKind: "relative",
      invert: false,
      primary: true,
    },
    {
      id: "margin",
      label: "Marginal",
      unit: "bp",
      value: totalsRow.marginBp,
      delta:
        prevTotals && prevTotals.marginBp !== null && totalsRow.marginBp !== null
          ? (totalsRow.marginBp - prevTotals.marginBp) / 100
          : null,
      deltaKind: "absolute",
      invert: false,
      primary: false,
    },
    {
      id: "revenue",
      label: "Intäkt",
      unit: "ore",
      value: allRevenue,
      delta: prevTotals
        ? relative(allRevenue, prevTotals.revenueOre + prevTotals.unpricedRevenueOre)
        : null,
      deltaKind: "relative",
      invert: false,
      primary: false,
    },
    {
      id: "compensation",
      label: "Butiksersättning",
      unit: "ore",
      value: totalsRow.compensationOre,
      delta: prevTotals ? relative(totalsRow.compensationOre, prevTotals.compensationOre) : null,
      deltaKind: "relative",
      invert: true,
      primary: false,
    },
    {
      id: "orders",
      label: "Order",
      unit: "count",
      value: totalsRow.orders,
      delta: prevTotals ? relative(totalsRow.orders, prevTotals.orders) : null,
      deltaKind: "relative",
      invert: false,
      primary: false,
    },
  ];

  const bridge: Bridge = {
    revenueOre: totalsRow.revenueOre,
    costOre: totalsRow.costOre,
    feesOre: totalsRow.feesOre,
    compensationOre: totalsRow.compensationOre,
    commissionOre: totalsRow.commissionOre,
    rentOre: totalsRow.rentOre,
    unallocatedRentOre: totalsRow.unallocatedRentOre,
    profitOre: totalsRow.profitOre,
    marginBp: totalsRow.marginBp,
    unpricedRevenueOre: totalsRow.unpricedRevenueOre,
  };

  const unpricedBlock: UnpricedBlock = {
    orders: unpriced.orders,
    revenueOre: unpriced.revenueOre,
    shareBp: unpriced.shareBp,
    titles: unpriced.byTitle.map((t) => ({
      titleId: t.titleId,
      name: names.title(t.titleId),
      orders: t.orders,
      revenueOre: t.revenueOre,
      shareBp: ratioBp(t.revenueOre, allRevenue) ?? 0,
      firstDate: t.firstDate,
      lastDate: t.lastDate,
      href: priceHref(t.titleId, carry),
    })),
  };

  const lines: Record<ViewKey, ProfitLine[]> = {
    title: views.title.rows.map((r) => toLine(r, "title", names, carry)),
    machine: views.machine.rows.map((r) => toLine(r, "machine", names, carry)),
    store: views.store.rows.map((r) => toLine(r, "store", names, carry)),
  };

  const day = trendSeries(all.day, "day", today);
  const week = trendSeries(all.week, "week", today);
  const month = trendSeries(all.month, "month", today);

  return {
    period,
    compare: input.previous?.period ?? null,
    periodLabel: periodText(period, today),
    comparisonLabel:
      prevTotals && input.previous
        ? `Jämfört med ${periodText(input.previous.period, today)}`
        : null,
    days,
    scope: input.scope,
    scopeLabel: scopeLabel(input),
    orders: totalsRow.orders,
    pricedOrders: totalsRow.pricedOrders,
    headline,
    kpis,
    bridge,
    views: lines,
    viewTitles: {
      title: viewHeading(views.title, lines.title, "title"),
      machine: viewHeading(views.machine, lines.machine, "machine"),
      store: viewHeading(views.store, lines.store, "store"),
    },
    totals: toLine(totalsRow, "total", names, carry),
    trend: { day, week, month },
    defaultTrend: week.buckets.length > 26 ? "month" : "week",
    unpriced: unpricedBlock,
    calcVersion: all.title.calcVersion,
  };
}
