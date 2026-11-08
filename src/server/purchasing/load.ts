/**
 * Laddaren för Prognos & inköp: läser allt som användaren (RLS), kör @/analytics
 * (förlorad försäljning, prognos, inköpsplan, lagervärde) och returnerar ett
 * serialiserbart resultat. Ingen egen ekonomilogik: här väljs bara indata och perioder.
 *
 * Bara ägare, admin och läsare (ekonomi). Påfyllaren får AuthorizationError.
 */

import "server-only";

import { demandFromForecast, inventoryValuation, purchasePlan } from "@/analytics/purchasing";
import type {
  PurchaseOrderRef,
  PurchasePlan,
  PurchasingInput,
  SupplierItemRef,
} from "@/analytics/purchasing/types";
import { forecastSales, resolveForecastOptions } from "@/analytics/forecast";
import type { ForecastResult, UnavailableDay } from "@/analytics/forecast/types";
import { lostSales } from "@/analytics/lost-sales";
import type { StockEventRef } from "@/analytics/lost-sales/stock";
import type { MemberRole } from "@/db/schema";
import { addDays, minDate, revenue, type IsoDate, type Period } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";
import { queryStock } from "@/server/data/core/queries";
import {
  ECONOMY_ROLES,
  OPERATOR_ROLES,
  type DataScope,
  type DomainInput,
} from "@/server/data/core/types";

import {
  queryCentralLocation,
  queryMachineStockEvents,
  queryPurchaseOrders,
  querySupplierItems,
  querySuppliers,
} from "./queries";
import { retiredSeries, seriesStartsFromStock } from "./series-start";
import type { HistoryWeek, PrognosData, PurchaseOrderRecord } from "./types";
import { ownStockTotals } from "@/server/data/core/own-stock";
import { querySlotPeriods } from "@/server/data/assortment";

export type { Viewer };

/** Dagar före förlorad försäljnings period som ordern läses för (takten före och långa perioder). */
const LOST_LOOKBACK_DAYS = 60;
/** Veckor utfall som visas före prognosen. */
export const HISTORY_WEEKS = 8;

/** Inköpsorder som ännu inte är helt mottagna eller avbrutna. */
export const OPEN_STATUSES = ["draft", "ordered", "partially_received"] as const;

export interface PrognosArgs {
  /** Periodvalet (förlorad försäljning räknas för det, högst t.o.m. i går). */
  readonly period: Period;
  readonly scope?: DataScope;
}

/** Hur långt bakåt prognosen (historik + backtest) behöver order. */
export function forecastRange(asOf: IsoDate): Period {
  const o = resolveForecastOptions();
  const length =
    7 * o.historyWeeks +
    o.backtestHorizonDays +
    Math.max(0, o.backtestOrigins - 1) * o.backtestStepDays;
  return { start: addDays(asOf, -(length - 1)), end: asOf };
}

/** Förlorad försäljnings period: periodvalet, men inte efter `asOf` (i dag är inte slut). */
export function lostPeriodOf(period: Period, asOf: IsoDate): Period {
  const end = minDate(period.end, asOf);
  const start = minDate(period.start, end);
  return { start, end };
}

/**
 * Första dagen med order och lagerhändelser för prognosen och inköpsplanen: prognosens
 * historik (forecastRange) och LOST_LOOKBACK_DAYS före den (takten före en slutsåld dag).
 * Beror bara på `asOf`, aldrig på periodvalet, så att Inköp och Vårt lager
 * (loadPurchasePlanFor) räknar på exakt samma underlag och visar samma antal.
 */
export function planFrom(asOf: IsoDate): IsoDate {
  return addDays(forecastRange(asOf).start, -LOST_LOOKBACK_DAYS);
}

/** Automaterna som filtret omfattar (null = alla). */
export function machinesInScope(input: DomainInput, scope: DataScope): Set<string> | null {
  if (scope.machineId) return new Set([scope.machineId]);
  if (scope.storeId) {
    return new Set(
      input.placements.filter((p) => p.storeId === scope.storeId).map((p) => p.machineId),
    );
  }
  return null;
}

/** Utfall per vecka (sju dagar, sista veckan slutar `asOf`), äldst först. */
export function historyWeeks(
  orders: DomainInput["current"]["orders"],
  asOf: IsoDate,
  settings: DomainInput["settings"],
  weeks: number = HISTORY_WEEKS,
): HistoryWeek[] {
  const out: HistoryWeek[] = [];
  for (let j = weeks - 1; j >= 0; j--) {
    const period = { start: addDays(asOf, -6 - 7 * j), end: addDays(asOf, -7 * j) };
    const inWeek = orders.filter(
      (o) => o.businessDate >= period.start && o.businessDate <= period.end,
    );
    out.push({ period, units: inWeek.length, revenueOre: revenue(inWeek, settings) });
  }
  return out;
}

function toPurchaseOrderRef(po: PurchaseOrderRecord): PurchaseOrderRef {
  return {
    id: po.id,
    supplierId: po.supplierId,
    status: po.status,
    orderedOn: po.orderedOn,
    expectedOn: po.expectedOn,
    lines: po.lines.map((l) => ({
      id: l.id,
      titleId: l.titleId,
      quantity: l.quantity,
      receivedQuantity: l.receivedQuantity,
      unitCostOre: l.unitCostOre,
    })),
  };
}

/** Underlaget för prognosen och inköpsplanen (order och händelser från planFrom(asOf)). */
interface PlanSources {
  readonly today: IsoDate;
  readonly asOf: IsoDate;
  /** Hela organisationens order från planFrom(asOf) t.o.m. asOf. */
  readonly orders: DomainInput["current"]["orders"];
  /** queryMachineStockEvents(planFrom(asOf), asOf). */
  readonly events: readonly StockEventRef[];
  readonly settings: DomainInput["settings"];
  readonly prices: DomainInput["sources"]["prices"];
  readonly titles: readonly {
    id: string;
    name: string;
    archived: boolean;
    /** Mystery pack: pack per omgång (packas i hela omgångar). */
    mysteryBatchSize?: number | null;
  }[];
  readonly machines: readonly {
    id: string;
    name: string;
    code: string;
    activeFrom: IsoDate | null;
    activeTo: IsoDate | null;
    archived: boolean;
  }[];
  readonly suppliers: Awaited<ReturnType<typeof querySuppliers>>;
  readonly items: Awaited<ReturnType<typeof querySupplierItems>>;
  readonly purchaseOrders: readonly PurchaseOrderRecord[];
  readonly stock: Awaited<ReturnType<typeof queryStock>>;
  readonly slots: Awaited<ReturnType<typeof querySlotPeriods>>;
}

/**
 * Prognosen för hela organisationen och inköpsplanen ur den. Samma funktion för Inköp
 * (loadPrognosFor) och Vårt lager (loadPurchasePlanFor): samma underlag ger samma antal.
 */
function forecastAndPlan(src: PlanSources): {
  forecastAll: ForecastResult;
  unavailable: UnavailableDay[];
  seriesStarts: ReturnType<typeof seriesStartsFromStock>;
  excludeSeries: ReturnType<typeof retiredSeries>;
  purchasing: PurchasingInput;
} {
  const { today, asOf, settings, titles, machines } = src;
  const fRange = forecastRange(asOf);
  // Slutsålda dagar under prognosens historik räknas inte som efterfrågan 0.
  const lostForForecast = lostSales({
    orders: src.orders,
    stockEvents: src.events,
    period: fRange,
    settings,
    prices: src.prices,
    titles,
    machines,
  });
  const unavailable: UnavailableDay[] = lostForForecast.stockoutDays.map((d) => ({
    machineId: d.machineId,
    titleId: d.titleId,
    date: d.date,
  }));

  // En titel som legat i automaten utan att sälja räknas från första kända saldo, inte
  // från första försäljningen (annars överskattas nya och svaga serier).
  // Dagar före första ordern i datan saknar orderdata och räknas inte som försäljning 0.
  let firstOrder: IsoDate | null = null;
  for (const o of src.orders) {
    if (firstOrder === null || o.businessDate < firstOrder) firstOrder = o.businessDate;
  }
  const seriesStarts = seriesStartsFromStock(src.events, asOf, firstOrder);

  // Titlar som gått ur automaten (Utgår på Lager) får ingen prognos och köps inte in:
  // samma utgår-regel som Lager, Drift och Vårt lager.
  const excludeSeries = retiredSeries(src.slots, today);

  const forecastAll = forecastSales({
    orders: src.orders,
    asOf,
    settings,
    titles,
    machines,
    unavailable,
    seriesStarts,
    excludeSeries,
    // Intervallet tar med att nivån är osäker när den skattats på få dagar. Prognosen
    // sänks när testveckorna visar att den legat för högt (startpuckeln efter en ny
    // automat bärs annars med i snittet: +21 % i november 2026).
    options: { levelUncertainty: true, biasCorrection: true },
  });

  // Inköp: hela organisationen (vårt lager = alla egna lager tillsammans).
  const activeSuppliers = new Set(src.suppliers.filter((s) => !s.archived).map((s) => s.id));
  const supplierItems: SupplierItemRef[] = src.items.filter((i) =>
    activeSuppliers.has(i.supplierId),
  );
  const purchasing: PurchasingInput = {
    today,
    titles,
    suppliers: src.suppliers
      .filter((s) => !s.archived)
      .map((s) => ({ id: s.id, name: s.name, defaultLeadTimeDays: s.defaultLeadTimeDays })),
    supplierItems,
    warehouseStock: ownStockTotals(src.stock),
    machineStock: src.stock
      .filter((r) => r.locationKind === "machine" && r.machineId !== null)
      .map((r) => ({ machineId: r.machineId as string, titleId: r.titleId, onHand: r.onHand })),
    openPurchaseOrders: src.purchaseOrders
      .filter((po) => (OPEN_STATUSES as readonly string[]).includes(po.status))
      .map(toPurchaseOrderRef),
    prices: src.prices,
    demand: demandFromForecast(forecastAll, today),
    // Utkast räknas inte som beställt (de kan glömmas och skulle då dölja behovet för
    // alltid). Sidan visar i stället "utkast finns" på förslagets rader.
    options: { includeDraftOrders: false },
  };
  return { forecastAll, unavailable, seriesStarts, excludeSeries, purchasing };
}

const titleRefs = (input: DomainInput) =>
  input.titles.map((t) => ({
    id: t.id,
    name: t.name,
    archived: t.archived,
    mysteryBatchSize: t.mysteryBatchSize ?? null,
  }));
const machineRefs = (input: DomainInput) =>
  input.machines.map((m) => ({
    id: m.id,
    name: m.name,
    code: m.code,
    activeFrom: m.activeFrom,
    activeTo: m.activeTo,
    archived: m.archived,
  }));

/**
 * Bara inköpsplanen (för Vårt lager): samma underlag och samma funktion som Inköp på
 * /prognos, så att "Beställ 36 st" står på båda sidorna. Ägare, admin och läsare.
 */
export async function loadPurchasePlanFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<PurchasePlan> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const today = businessToday(now, viewer.organization.timezone);
  const asOf = addDays(today, -1);
  const from = planFrom(asOf);
  const all = await loadDomainInputFor(viewer, { period: { start: from, end: asOf } }, now);
  const db = await withUserDbFor(viewer.user, async (tx) => {
    const [events, suppliers, items, purchaseOrders, stock, slots] = await Promise.all([
      queryMachineStockEvents(tx, orgId, from, asOf),
      querySuppliers(tx, orgId),
      querySupplierItems(tx, orgId),
      queryPurchaseOrders(tx, orgId),
      queryStock(tx, orgId),
      querySlotPeriods(tx, orgId),
    ]);
    return { events, suppliers, items, purchaseOrders, stock, slots };
  });
  const { purchasing } = forecastAndPlan({
    today,
    asOf,
    orders: all.current.orders,
    settings: all.settings,
    prices: all.sources.prices,
    titles: titleRefs(all),
    machines: machineRefs(all),
    ...db,
  });
  return purchasePlan(purchasing);
}

/**
 * Allt sidan behöver. `now` styr "i dag" (prognosen börjar i dag, i går är sista dagen
 * med data). Kastar AuthorizationError("forbidden") för påfyllare.
 */
export async function loadPrognosFor(
  viewer: Viewer,
  args: PrognosArgs,
  now: Date = new Date(),
): Promise<PrognosData> {
  const orgId = viewer.organization.id;
  const role: MemberRole = await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const today = businessToday(now, viewer.organization.timezone);
  const asOf = addDays(today, -1);
  const scope: DataScope = args.scope ?? { storeId: null, machineId: null };
  const scoped = Boolean(scope.storeId || scope.machineId);

  const lostPeriod = lostPeriodOf(args.period, asOf);
  // Prognosen och inköpsplanen räknas alltid från planFrom (oberoende av periodvalet);
  // förlorad försäljning för en lång period kan behöva order längre bakåt.
  const fromPlan = planFrom(asOf);
  const ordersFrom = minDate(fromPlan, addDays(lostPeriod.start, -LOST_LOOKBACK_DAYS));
  const orderRange: Period = { start: ordersFrom, end: asOf };

  const all = await loadDomainInputFor(viewer, { period: orderRange }, now);
  const inScope = scoped
    ? await loadDomainInputFor(viewer, { period: orderRange, ...scope }, now)
    : all;

  const db = await withUserDbFor(viewer.user, async (tx) => {
    const [events, planEvents, suppliers, items, purchaseOrders, stock, central, slots] =
      await Promise.all([
        queryMachineStockEvents(tx, orgId, ordersFrom, asOf),
        // Samma händelser som Vårt lager läser (från planFrom); samma lista när perioden
        // inte kräver äldre data.
        ordersFrom === fromPlan ? null : queryMachineStockEvents(tx, orgId, fromPlan, asOf),
        querySuppliers(tx, orgId),
        querySupplierItems(tx, orgId),
        queryPurchaseOrders(tx, orgId),
        queryStock(tx, orgId),
        queryCentralLocation(tx, orgId),
        querySlotPeriods(tx, orgId),
      ]);
    return {
      events,
      planEvents: planEvents ?? events,
      suppliers,
      items,
      purchaseOrders,
      stock,
      central,
      slots,
    };
  });

  const settings = all.settings;
  const titles = titleRefs(all);
  const machines = machineRefs(all);
  const { forecastAll, unavailable, seriesStarts, excludeSeries, purchasing } = forecastAndPlan({
    today,
    asOf,
    orders:
      ordersFrom === fromPlan
        ? all.current.orders
        : all.current.orders.filter((o) => o.businessDate >= fromPlan),
    events: db.planEvents,
    settings,
    prices: all.sources.prices,
    titles,
    machines,
    suppliers: db.suppliers,
    items: db.items,
    purchaseOrders: db.purchaseOrders,
    stock: db.stock,
    slots: db.slots,
  });

  const forecastFor = (orders: DomainInput["current"]["orders"]): ForecastResult =>
    forecastSales({
      orders,
      asOf,
      settings,
      titles,
      machines,
      unavailable,
      seriesStarts,
      excludeSeries,
      // Samma val som forecastAndPlan.
      options: { levelUncertainty: true, biasCorrection: true },
    });
  const forecast = scoped ? forecastFor(inScope.current.orders) : forecastAll;

  // Förlorad försäljning för periodvalet och filtret.
  const scopeMachines = machinesInScope(all, scope);
  const scopedEvents: StockEventRef[] = scopeMachines
    ? db.events.filter((e) => e.machineId !== null && scopeMachines.has(e.machineId))
    : db.events;
  const lost = lostSales({
    orders: inScope.current.orders,
    stockEvents: scopedEvents,
    period: lostPeriod,
    settings,
    prices: all.sources.prices,
    titles,
    machines,
  });

  // Hur säker efterfrågan i inköpsplanen är: serier med lite data per titel (hela org.).
  const basis = new Map<
    string,
    { series: number; lowData: number; lowDataMilli: number; unitsMilli: number }
  >();
  for (const sf of forecastAll.series) {
    const b = basis.get(sf.titleId) ?? { series: 0, lowData: 0, lowDataMilli: 0, unitsMilli: 0 };
    b.series += 1;
    b.unitsMilli += sf.total.unitsMilli;
    if (sf.status === "low-data") {
      b.lowData += 1;
      b.lowDataMilli += sf.total.unitsMilli;
    }
    basis.set(sf.titleId, b);
  }

  return {
    today,
    asOf,
    forecastHistory: {
      start: addDays(asOf, -(7 * resolveForecastOptions().historyWeeks - 1)),
      end: asOf,
    },
    demandBasis: [...basis.entries()].map(([titleId, b]) => ({
      titleId,
      series: b.series,
      lowDataSeries: b.lowData,
      lowDataUnitsMilli: b.lowDataMilli,
      unitsMilli: b.unitsMilli,
    })),
    lostPeriod,
    scope,
    canEdit: (OPERATOR_ROLES as readonly MemberRole[]).includes(role),
    titles: all.titles.map((t) => ({ id: t.id, name: t.name, ownProduct: t.ownProduct === true })),
    machines: all.machines.map((m) => ({ id: m.id, name: m.name, code: m.code })),
    lostSales: lost,
    forecast,
    history: historyWeeks(inScope.current.orders, asOf, settings),
    plan: purchasePlan(purchasing),
    valuation: inventoryValuation(purchasing),
    suppliers: db.suppliers,
    supplierItems: db.items,
    purchaseOrders: db.purchaseOrders,
    hasCentralWarehouse: db.central !== null,
  };
}
