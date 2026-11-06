/**
 * Laddarna för Automaters sidor: de gemensamma laddarna (RLS, rollkontroll, cache per
 * förfrågan) plus automatens order, sammansatta till vymodeller med ./model.
 */

import "server-only";

import {
  carriedQuery,
  describePeriod,
  type SearchParamsInput,
} from "@/components/shell/period-state";
import { addDays, type IsoDate, type Period } from "@/domain";
import {
  loadDomainInput,
  loadMasterData,
  loadPeriod,
  loadStock,
  requireRoute,
  type AppContext,
  type AppPeriod,
  type MachineRecord,
} from "@/server/data/core";
import { storeShareLabel, storeShareTerms } from "@/lib/store-share";
import { isUuid } from "@/server/access";
import type { DomainInput, MasterData } from "@/server/data/core/types";
import { loadMachineHealth } from "@/server/data/health";

import {
  buildOverview,
  coverageOf,
  dailyRevenue,
  lifecycleOf,
  machineFigures,
  machineHeadline,
  machineKpis,
  machineSignals,
  machineSpan,
  startedOn,
  machineUnitEconomics,
  placementLines,
  recentWindow,
  machineUnpriced,
  salesHeatmap,
  spanOf,
  statusOf,
  stockLines,
  titleShares,
  type Span,
} from "./model";
import { loadLastOrderAtFor, loadMachineOrdersFor } from "./service";
import { currentViewer } from "./session";
import type {
  DailyPoint,
  HeatmapView,
  KpiView,
  MachineEditable,
  MachinesOverview,
  MachineStatusView,
  PlacementLine,
  RecentOrder,
  StockLine,
  StoreOption,
  TitleShare,
  UnitEconomicsView,
  UnpricedView,
} from "./types";

export interface PeriodInfo {
  /** Dagar i den valda perioden. */
  readonly days: number;
  /**
   * Dagarna med data som rubriker, etiketter och snitt per dag räknas på: från första
   * ordern (för en automat från driftstarten) t.o.m. i går om dagens order inte kommit.
   * Utan data: perioden.
   */
  readonly span: Span;
  /** Samma dagar som period, eller null utan data. */
  readonly coverage: Period | null;
  /** Perioden är bara i dag och dagens order har inte kommit än: inga tal att visa. */
  readonly pendingToday: boolean;
  readonly rangeLabel: string;
  readonly comparisonLabel: string | null;
  readonly start: IsoDate;
  readonly end: IsoDate;
}

function periodInfo(
  p: AppPeriod,
  today: IsoDate,
  coverage: Period | null,
  hasComparison: boolean,
): PeriodInfo {
  const d = describePeriod(p.resolved);
  return {
    days: p.days,
    span: spanOf(coverage ?? p.period, today),
    coverage,
    pendingToday: p.period.start === today && p.period.end === today && coverage === null,
    rangeLabel: d.rangeLabel,
    comparisonLabel: p.compare && hasComparison ? d.comparisonLabel : null,
    start: p.period.start,
    end: p.period.end,
  };
}

/**
 * Jämförelsen gäller bara när jämförelseperioden ligger helt inom datan (som på Hem):
 * dagar före första ordern (eller automatens driftstart) har ingen försäljning att
 * jämföra med, och en halv jämförelseperiod ger skenbara ökningar.
 */
function comparable(
  p: AppPeriod,
  previous: { orders: readonly unknown[] } | null,
  activeFrom: IsoDate | null = null,
): boolean {
  return (
    previous !== null &&
    previous.orders.length > 0 &&
    p.compare !== null &&
    p.dataStart !== null &&
    p.compare.start >= p.dataStart &&
    (activeFrom === null || p.compare.start >= activeFrom)
  );
}

function hasOrdersOn(orders: readonly { businessDate: IsoDate }[], day: IsoDate): boolean {
  return orders.some((o) => o.businessDate === day);
}

async function signalsFor(ctx: AppContext) {
  const [recent, stock, master, health] = await Promise.all([
    loadDomainInput({ period: recentWindow(ctx.today) }),
    loadStock(),
    loadMasterData(),
    // Samma status som Drift (försäljningens täckning räknas med). Ett fel här ska inte
    // stoppa sidan: då räknas hälsan på orderna som förut.
    loadMachineHealth().catch((error: unknown) => {
      console.error("[automater] Maskinhälsan kunde inte läsas:", error);
      return null;
    }),
  ]);
  return {
    recent,
    stock,
    master,
    signals: machineSignals({
      recent,
      stock,
      master,
      now: new Date(ctx.now),
      timeZone: ctx.timeZone,
      health,
    }),
  };
}

function storeOptions(master: Awaited<ReturnType<typeof loadMasterData>>): StoreOption[] {
  return master.stores
    .filter((s) => !s.archived)
    .map((s) => ({ id: s.id, name: s.name }))
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
}

// ---------------------------------------------------------------------------
// Listan
// ---------------------------------------------------------------------------

export interface OverviewData {
  readonly ctx: AppContext;
  readonly period: PeriodInfo;
  readonly overview: MachinesOverview;
  /** Automatfiltret är satt (summan är automatens rad). */
  readonly focused: boolean;
  readonly stores: StoreOption[];
  /** Butiksfiltrets namn, om filtret är satt. */
  readonly scopeLabel: string | null;
}

export async function loadOverview(searchParams: SearchParamsInput): Promise<OverviewData> {
  const ctx = await requireRoute("automater");
  const p = await loadPeriod(searchParams);
  // Vid automatfilter läses hela organisationen: butikens hyra delas då mellan butikens
  // automater, som på automatens sida, i stället för att hela hyran hamnar på automaten.
  const focused = p.scope.machineId !== null;
  const [loaded, base, lastOrderAt] = await Promise.all([
    loadDomainInput({ period: p.period, compare: p.compare, ...(focused ? {} : p.scope) }),
    signalsFor(ctx),
    currentViewer().then(loadLastOrderAtFor),
  ]);
  const input = comparable(p, loaded.previous) ? loaded : { ...loaded, previous: null };
  const coverage = coverageOf(
    p.period,
    p.dataStart,
    ctx.today,
    hasOrdersOn(input.current.orders, ctx.today),
  );
  const period = periodInfo(p, ctx.today, coverage, input.previous !== null);
  const overview = buildOverview({
    input,
    master: base.master,
    stock: base.stock,
    signals: base.signals,
    lastOrderAt,
    today: ctx.today,
    scope: p.scope,
    coverage,
    pendingToday: period.pendingToday,
    query: carriedQuery(searchParams),
  });
  const scopeLabel = p.scope.machineId
    ? (base.master.machines.find((m) => m.id === p.scope.machineId)?.code ?? null)
    : p.scope.storeId
      ? (base.master.stores.find((s) => s.id === p.scope.storeId)?.name ?? null)
      : null;
  return {
    ctx,
    period,
    overview,
    focused,
    stores: storeOptions(base.master),
    scopeLabel,
  };
}

// ---------------------------------------------------------------------------
// En automat
// ---------------------------------------------------------------------------

export interface MachineDetailData {
  readonly ctx: AppContext;
  readonly period: PeriodInfo;
  readonly machine: MachineRecord;
  readonly editable: MachineEditable;
  readonly headline: { readonly title: string; readonly aside: string };
  readonly status: MachineStatusView;
  readonly store: { readonly id: string; readonly name: string; readonly since: IsoDate } | null;
  /** Faktisk driftstart: registrerad driftstart, första placering eller första order (tidigast). */
  readonly startedOn: IsoDate | null;
  /** Vinsten (nyckeltal, enhetsekonomi) är efter butikernas andel (vyknappen). */
  readonly storeShareDeducted: boolean;
  readonly kpis: KpiView[];
  readonly daily: DailyPoint[];
  readonly dailyCompare: number[] | null;
  readonly titles: TitleShare[];
  /** Order utan inköpspris i automaten (utanför vinsten), eller null. */
  readonly unpriced: UnpricedView | null;
  readonly heatmap: HeatmapView;
  readonly stock: StockLine[];
  /** Senaste registrerade påfyllning (påfyllning eller flytt in), aldrig en inventering. */
  readonly lastRestockedAt: string | null;
  readonly recentOrders: RecentOrder[];
  readonly placements: PlacementLine[];
  readonly unitEconomics: UnitEconomicsView | null;
  readonly stores: StoreOption[];
  /** Query-strängen med period och filter (utan automatfilter), för länkar. */
  readonly query: string;
}

/** Sant om sökvägen är automatens id (uuid) och inte koden. */
export function isMachineId(slug: string): boolean {
  return isUuid(slug);
}

/** Hittar automaten på id (uuid, som i länkar från Att göra) eller kod (bl-001). */
export function findMachine(
  machines: readonly MachineRecord[],
  slug: string,
): MachineRecord | undefined {
  const key = decodeURIComponent(slug).trim();
  if (isMachineId(key)) return machines.find((m) => m.id === key.toLowerCase());
  const code = key.toUpperCase();
  return machines.find((m) => m.code === code);
}

/** Automatens kod för en sökväg (id eller kod), eller null. Kräver rätt roll. */
export async function resolveMachineCode(slug: string): Promise<string | null> {
  await requireRoute("automater");
  return findMachine((await loadMasterData()).machines, slug)?.code ?? null;
}

export async function loadMachineDetail(
  slug: string,
  searchParams: SearchParamsInput,
): Promise<MachineDetailData | null> {
  const ctx = await requireRoute("automater");
  const master = await loadMasterData();
  const machine = findMachine(master.machines, slug);
  if (!machine) return null;

  const p = await loadPeriod(searchParams);
  const [input, base, orders] = await Promise.all([
    // Hela organisationens indata: butikens hyra fördelas då mellan butikens automater.
    loadDomainInput({ period: p.period, compare: p.compare }),
    signalsFor(ctx),
    currentViewer().then((v) => loadMachineOrdersFor(v, machine.id)),
  ]);

  const today = ctx.today;
  const lifecycle = lifecycleOf(machine, today);
  const figures = machineFigures(input.current, machine.id);
  const placements = placementLines(master, machine.id, today);
  const firstPlacement = placements.at(-1) ?? null;
  const started = startedOn(
    machine.activeFrom,
    firstPlacement?.from ?? null,
    orders.firstOrderDate,
  );
  // Jämförelse bara när jämförelseperioden ligger inom datan och automatens drift, och
  // automaten sålde något då.
  const prevFigures =
    input.previous && comparable(p, input.previous, started)
      ? machineFigures(input.previous, machine.id)
      : null;
  const previous = prevFigures && prevFigures.orders > 0 ? prevFigures : null;
  // Dagarna med data för automaten: organisationens första order, driftstarten, sista
  // dagen i drift, och t.o.m. i går om dagens order inte kommit.
  const coverage = machineSpan(
    coverageOf(p.period, p.dataStart, today, hasOrdersOn(input.current.orders, today)),
    started,
    machine.activeTo,
  );
  const period = periodInfo(p, today, coverage, previous !== null);
  const fullDaily = dailyRevenue(input.current, machine.id);
  const skip = coverage ? fullDaily.filter((d) => d.date < coverage.start).length : 0;
  const daily = coverage
    ? fullDaily.filter((d) => d.date >= coverage.start && d.date <= coverage.end)
    : [];
  const dailyCompare =
    previous && input.previous && daily.length > 0
      ? dailyRevenue(input.previous, machine.id)
          .map((d) => d.value)
          .slice(skip, skip + daily.length)
      : null;
  const currentPlacement = placements.find((x) => x.current) ?? null;
  // Första placeringen gäller också försäljningen före den (placedInStore).
  const store = currentPlacement
    ? {
        id: currentPlacement.storeId,
        name: currentPlacement.storeName,
        since:
          currentPlacement === firstPlacement && started !== null && started < currentPlacement.from
            ? started
            : currentPlacement.from,
      }
    : null;
  const refill = base.signals.refill.get(machine.id) ?? [];
  const stockRows = base.stock.rows.filter(
    (r) => r.locationKind === "machine" && r.machineId === machine.id,
  );
  // Senaste registrerade påfyllning (refill eller flytt in), inte inventeringen.
  const lastRestockedAt =
    stockRows
      .map((r) => r.lastRefilledAt ?? null)
      .filter((x): x is string => x !== null)
      .sort()
      .at(-1) ?? null;

  return {
    ctx,
    period,
    machine,
    editable: {
      id: machine.id,
      code: machine.code,
      name: machine.name,
      serial: machine.serial,
      activeFrom: machine.activeFrom,
      activeTo: machine.activeTo,
      storeId: store?.id ?? null,
      lifecycle,
      firstOrderDate: orders.firstOrderDate,
      lastOrderDate: orders.lastOrderDate,
      lastPlacementFrom: placements[0]?.from ?? null,
      firstPlacementFrom: placements.at(-1)?.from ?? null,
    },
    headline: machineHeadline({
      code: machine.code,
      lifecycle,
      activeFrom: machine.activeFrom,
      activeTo: machine.activeTo,
      figures,
      previous,
      span: period.span,
      pendingToday: period.pendingToday,
      store: store ? { name: store.name, since: store.since } : null,
      today,
    }),
    status: statusOf({
      lifecycle,
      activeFrom: machine.activeFrom,
      activeTo: machine.activeTo,
      today,
      health: base.signals.health.get(machine.id),
      refill,
    }),
    store,
    startedOn: started,
    storeShareDeducted: figures.storeShareDeducted === true,
    kpis: machineKpis(
      figures,
      previous,
      daily,
      machineShareLabel(input.current, master, machine.id),
    ),
    daily,
    dailyCompare,
    titles: titleShares(input.current, machine.id, master),
    unpriced: machineUnpriced(input.current, machine.id, master),
    heatmap: salesHeatmap(
      input.current.orders.filter((o) => o.machineId === machine.id),
      ctx.timeZone,
    ),
    stock: stockLines({
      machine,
      rows: stockRows,
      recentOrders: base.recent.current.orders.filter((o) => o.businessDate >= addDays(today, -15)),
      refill,
      master,
      today,
    }),
    lastRestockedAt,
    recentOrders: orders.recent,
    placements,
    unitEconomics: machineUnitEconomics(input, machine.id),
    stores: storeOptions(master),
    query: carriedQuery(searchParams),
  };
}

/**
 * Andelens etikett på automatens sida: stod automaten i en enda butik under perioden,
 * butikens namn och villkor ("Sega gubben 50 % av vinsten"), annars "Butikernas andel".
 */
function machineShareLabel(
  input: DomainInput["current"],
  master: MasterData,
  machineId: string,
): string {
  const stores = new Set(
    master.placements
      .filter(
        (pl) =>
          pl.machineId === machineId &&
          pl.from <= input.period.end &&
          (pl.to === null || pl.to >= input.period.start),
      )
      .map((pl) => pl.storeId),
  );
  if (stores.size !== 1) return storeShareLabel(null);
  const storeId = [...stores][0]!;
  const name = master.stores.find((st) => st.id === storeId)?.name ?? "butiken";
  return storeShareLabel({ name, terms: storeShareTerms(input.agreements, storeId, input.period) });
}
