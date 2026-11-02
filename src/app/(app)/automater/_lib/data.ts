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
import { addDays, daysBetween, type IsoDate } from "@/domain";
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
import { isUuid } from "@/server/access";

import {
  buildOverview,
  dailyRevenue,
  lifecycleOf,
  machineFigures,
  machineHeadline,
  machineKpis,
  machineSignals,
  machineUnitEconomics,
  placementLines,
  recentWindow,
  salesHeatmap,
  statusOf,
  stockLines,
  titleShares,
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
} from "./types";

export interface PeriodInfo {
  /** Dagar i den valda perioden. */
  readonly days: number;
  /** Dagar med data: från första ordern om perioden börjar före den. */
  readonly dataDays: number;
  readonly rangeLabel: string;
  readonly comparisonLabel: string | null;
  readonly start: IsoDate;
  readonly end: IsoDate;
}

function periodInfo(p: AppPeriod, hasComparison: boolean): PeriodInfo {
  const d = describePeriod(p.resolved);
  const dataDays =
    p.dataStart && p.dataStart > p.period.start && p.dataStart <= p.period.end
      ? daysBetween(p.dataStart, p.period.end) + 1
      : p.days;
  return {
    days: p.days,
    dataDays,
    rangeLabel: d.rangeLabel,
    comparisonLabel: p.compare && hasComparison ? d.comparisonLabel : null,
    start: p.period.start,
    end: p.period.end,
  };
}

function withoutEmptyComparison<T extends { previous: { orders: readonly unknown[] } | null }>(
  input: T,
): T {
  return input.previous && input.previous.orders.length === 0
    ? { ...input, previous: null }
    : input;
}

async function signalsFor(ctx: AppContext) {
  const [recent, stock, master] = await Promise.all([
    loadDomainInput({ period: recentWindow(ctx.today) }),
    loadStock(),
    loadMasterData(),
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
  readonly stores: StoreOption[];
  /** Butiksfiltrets namn, om filtret är satt. */
  readonly scopeLabel: string | null;
}

export async function loadOverview(searchParams: SearchParamsInput): Promise<OverviewData> {
  const ctx = await requireRoute("automater");
  const p = await loadPeriod(searchParams);
  const [loaded, base, lastOrderAt] = await Promise.all([
    loadDomainInput({ period: p.period, compare: p.compare, ...p.scope }),
    signalsFor(ctx),
    currentViewer().then(loadLastOrderAtFor),
  ]);
  // En jämförelseperiod utan order (före första ordern) jämförs inte.
  const input = withoutEmptyComparison(loaded);
  const overview = buildOverview({
    input,
    master: base.master,
    stock: base.stock,
    signals: base.signals,
    lastOrderAt,
    today: ctx.today,
    days: periodInfo(p, false).dataDays,
    query: carriedQuery(searchParams),
  });
  const scopeLabel = p.scope.machineId
    ? (base.master.machines.find((m) => m.id === p.scope.machineId)?.code ?? null)
    : p.scope.storeId
      ? (base.master.stores.find((s) => s.id === p.scope.storeId)?.name ?? null)
      : null;
  return {
    ctx,
    period: periodInfo(p, input.previous !== null),
    overview,
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
  readonly kpis: KpiView[];
  readonly daily: DailyPoint[];
  readonly dailyCompare: number[] | null;
  readonly titles: TitleShare[];
  readonly heatmap: HeatmapView;
  readonly stock: StockLine[];
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
  // Ingen jämförelse om automaten inte sålde något i jämförelseperioden (t.ex. före start).
  const prevFigures = input.previous ? machineFigures(input.previous, machine.id) : null;
  const previous = prevFigures && prevFigures.orders > 0 ? prevFigures : null;
  // Dagarna före första ordern (eller driftstarten) ritas inte som nollor.
  const firstDay = [p.dataStart, machine.activeFrom]
    .filter((d): d is IsoDate => d !== null)
    .reduce<IsoDate | null>((a, b) => (a === null || b > a ? b : a), null);
  const fullDaily = dailyRevenue(input.current, machine.id);
  const skip = firstDay ? fullDaily.filter((d) => d.date < firstDay).length : 0;
  const daily = skip < fullDaily.length ? fullDaily.slice(skip) : fullDaily;
  const dailyCompare =
    previous && input.previous
      ? dailyRevenue(input.previous, machine.id)
          .map((d) => d.value)
          .slice(daily === fullDaily ? 0 : skip)
      : null;
  const placements = placementLines(master, machine.id, today);
  const currentPlacement = placements.find((x) => x.current) ?? null;
  const store = currentPlacement
    ? {
        id: currentPlacement.storeId,
        name: currentPlacement.storeName,
        since: currentPlacement.from,
      }
    : null;
  const refill = base.signals.refill.get(machine.id) ?? [];
  const stockRows = base.stock.rows.filter(
    (r) => r.locationKind === "machine" && r.machineId === machine.id,
  );
  const lastRestockedAt =
    stockRows
      .map((r) => r.lastRestockedAt)
      .filter((x): x is string => x !== null)
      .sort()
      .at(-1) ?? null;

  return {
    ctx,
    period: periodInfo(p, previous !== null),
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
    },
    headline: machineHeadline({
      code: machine.code,
      lifecycle,
      activeFrom: machine.activeFrom,
      activeTo: machine.activeTo,
      figures,
      previous,
      days: periodInfo(p, false).dataDays,
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
    kpis: machineKpis(figures, previous, daily),
    daily,
    dailyCompare,
    titles: titleShares(input.current, machine.id, master),
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
