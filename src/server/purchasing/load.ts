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
import type { HistoryWeek, PrognosData, PurchaseOrderRecord } from "./types";

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

/** Automaterna som filtret omfattar (null = alla). */
function machinesInScope(input: DomainInput, scope: DataScope): Set<string> | null {
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

  const fRange = forecastRange(asOf);
  const lostPeriod = lostPeriodOf(args.period, asOf);
  const ordersFrom = minDate(fRange.start, addDays(lostPeriod.start, -LOST_LOOKBACK_DAYS));
  const orderRange: Period = { start: ordersFrom, end: asOf };

  const all = await loadDomainInputFor(viewer, { period: orderRange }, now);
  const inScope = scoped
    ? await loadDomainInputFor(viewer, { period: orderRange, ...scope }, now)
    : all;

  const db = await withUserDbFor(viewer.user, async (tx) => {
    const [events, suppliers, items, purchaseOrders, stock, central] = await Promise.all([
      queryMachineStockEvents(tx, orgId, ordersFrom, asOf),
      querySuppliers(tx, orgId),
      querySupplierItems(tx, orgId),
      queryPurchaseOrders(tx, orgId),
      queryStock(tx, orgId),
      queryCentralLocation(tx, orgId),
    ]);
    return { events, suppliers, items, purchaseOrders, stock, central };
  });

  const settings = all.settings;
  const titles = all.titles.map((t) => ({ id: t.id, name: t.name, archived: t.archived }));
  const machines = all.machines.map((m) => ({
    id: m.id,
    name: m.name,
    code: m.code,
    activeFrom: m.activeFrom,
    activeTo: m.activeTo,
    archived: m.archived,
  }));

  // Slutsålda dagar under prognosens historik räknas inte som efterfrågan 0.
  const lostForForecast = lostSales({
    orders: all.current.orders,
    stockEvents: db.events,
    period: fRange,
    settings,
    prices: all.sources.prices,
    titles,
    machines,
  });
  const unavailable: UnavailableDay[] = lostForForecast.stockoutDays.map((d) => ({
    machineId: d.machineId,
    titleId: d.titleId,
    date: d.date,
  }));

  const forecastFor = (orders: DomainInput["current"]["orders"]): ForecastResult =>
    forecastSales({ orders, asOf, settings, titles, machines, unavailable });
  const forecastAll = forecastFor(all.current.orders);
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

  // Inköp: hela organisationen (centrallagret är gemensamt).
  const activeSuppliers = new Set(db.suppliers.filter((s) => !s.archived).map((s) => s.id));
  const supplierItems: SupplierItemRef[] = db.items.filter((i) =>
    activeSuppliers.has(i.supplierId),
  );
  const purchasing: PurchasingInput = {
    today,
    titles,
    suppliers: db.suppliers
      .filter((s) => !s.archived)
      .map((s) => ({ id: s.id, name: s.name, defaultLeadTimeDays: s.defaultLeadTimeDays })),
    supplierItems,
    warehouseStock: db.stock
      .filter((r) => r.isCentral)
      .map((r) => ({ titleId: r.titleId, onHand: r.onHand })),
    machineStock: db.stock
      .filter((r) => r.locationKind === "machine" && r.machineId !== null)
      .map((r) => ({ machineId: r.machineId as string, titleId: r.titleId, onHand: r.onHand })),
    openPurchaseOrders: db.purchaseOrders
      .filter((po) => (OPEN_STATUSES as readonly string[]).includes(po.status))
      .map(toPurchaseOrderRef),
    prices: all.sources.prices,
    demand: demandFromForecast(forecastAll, today),
    // Ett utkast är en beställning som ska läggas: räknas som beställt, så att förslaget
    // inte föreslår samma sak två gånger.
    options: { includeDraftOrders: true },
  };

  return {
    today,
    asOf,
    lostPeriod,
    scope,
    canEdit: (OPERATOR_ROLES as readonly MemberRole[]).includes(role),
    titles: all.titles.map((t) => ({ id: t.id, name: t.name })),
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
