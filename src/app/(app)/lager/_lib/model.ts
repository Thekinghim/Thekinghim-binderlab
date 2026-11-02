/**
 * Lagersidans vymodell: ren funktion från saldon, försäljning i antal och stamdata.
 *
 * Alla tal kommer från beräkningslagret:
 *   - takt, dagar kvar och slutdatum: @/domain (salesVelocity, daysOfStockLeft, stockoutDate)
 *     över samma fönster som Att göra (14 hela dagar t.o.m. i går, TODO_DEFAULTS),
 *   - status Kritisk/Låg: påfyllningsregeln i @/analytics/todos (refillTodos), så att
 *     Lager och Att göra alltid säger samma sak. Ett tomt fack är alltid Kritisk,
 *   - påfyllningslista och centrallagrets veckobehov: besöksplanen i @/analytics/visits,
 *     räknad från i går (planNow) så att takt, slutdatum och orsaker är desamma som i matrisen.
 *
 * Inga belopp: försäljningen kommer som antal (lagerhändelser av typen sale) och görs om
 * till order med beloppet 0, bara för att räkna takt.
 */

import { createTodoContext } from "@/analytics/todos/context";
import { isMachineActive } from "@/analytics/todos/common";
import { refillTodos } from "@/analytics/todos/refill";
import { TODO_DEFAULTS, type AnalyticsOrder, type StockLevelRef } from "@/analytics/todos";
import type { MachineHealth } from "@/analytics/health";
import { planVisits, type VisitPlan } from "@/analytics/visits";
import { planNow, weeklyVisitPlan } from "@/server/data/visit-plan";
import {
  addDays,
  dailyUnits,
  daysOfStockLeft,
  roundHalfUp,
  salesVelocity,
  stockoutDate,
  type IsoDate,
  type SalesVelocity,
} from "@/domain";
import type {
  DataScope,
  MachineRecord,
  MasterData,
  SalesCountRow,
  StockRow,
} from "@/server/data/core/types";

import type {
  LagerMachine,
  LagerTitle,
  PackList,
  PackListLine,
  PackListMissing,
  SlotPeriod,
  StockCell,
  StockStatus,
  WarehouseRow,
} from "./types";
import { WAREHOUSE_LOW_DAYS } from "./types";

export interface LagerModelInput {
  readonly now: Date;
  readonly timeZone: string;
  /** Dagens affärsdatum i organisationens tidszon. */
  readonly today: IsoDate;
  readonly master: MasterData;
  readonly stock: readonly StockRow[];
  /** Sålda pack per dag, titel och automat. Minst fönstret plus i dag. */
  readonly sales: readonly SalesCountRow[];
  readonly scope: DataScope;
  /** Sant om organisationen har ett centrallager (stock_locations.is_central). */
  readonly hasCentral: boolean;
  /**
   * Maskinhälsan som på Drift (loadMachineHealthFor). Automater med fel får ett besök i dag
   * i veckoplanen, precis som på Drift. Utelämnad = inga extra besök.
   */
  readonly health?: readonly Pick<MachineHealth, "machineId" | "status">[] | null;
  /**
   * Sortimentets perioder (lager_slot_periods). En titel vars sista period har passerat
   * räknas som utgången i automaten (`StockCell.retired`). Utelämnad = inga utgångna.
   */
  readonly slotPeriods?: readonly SlotPeriod[] | null;
}

export interface LagerModel {
  readonly window: { readonly start: IsoDate; readonly end: IsoDate; readonly days: number };
  readonly lowThresholdTenths: number;
  readonly machines: LagerMachine[];
  readonly titles: LagerTitle[];
  readonly cells: StockCell[][];
  readonly hasWarehouse: boolean;
  readonly warehouse: WarehouseRow[];
  readonly packLists: PackList[];
  readonly counts: { readonly critical: number; readonly low: number; readonly ok: number };
  readonly retiredTitles: LagerTitle[];
}

/** Fönstret för takten (samma som påfyllningsregeln i Att göra). */
export const WINDOW_DAYS = TODO_DEFAULTS.refillWindowDays;

const STATUS_RANK: Record<StockStatus, number> = { critical: 0, low: 1, ok: 2 };

const pairKey = (machineId: string, titleId: string) => `${machineId}\u0000${titleId}`;

/** Försäljning i antal → order med beloppet 0 (en per pack), för takten. */
export function salesAsOrders(sales: readonly SalesCountRow[]): AnalyticsOrder[] {
  const out: AnalyticsOrder[] = [];
  for (const r of sales) {
    for (let i = 0; i < r.units; i++) {
      out.push({
        id: `sale:${r.date}:${r.machineId ?? "-"}:${r.titleId}:${i}`,
        externalId: "",
        titleId: r.titleId,
        machineId: r.machineId,
        businessDate: r.date,
        amountOre: 0,
      });
    }
  }
  return out;
}

function perDayTenths(v: SalesVelocity): number | null {
  return v.units > 0 && v.days > 0 ? roundHalfUp(v.units * 10, v.days) : null;
}

function inScope(m: MachineRecord, scope: DataScope): boolean {
  if (scope.machineId !== null && m.id !== scope.machineId) return false;
  if (scope.storeId !== null && m.storeId !== scope.storeId) return false;
  return true;
}

function compareText(a: string, b: string): number {
  return a.localeCompare(b, "sv", { sensitivity: "base", numeric: true });
}

/** buildStop i besöksplanen lägger underskottet sist med den här inledningen. */
const WAREHOUSE_SHORT_PREFIX = "Centrallagret räcker inte";

/**
 * Centrallagrets status:
 *   Kritisk = slut, och titeln säljer eller behövs i veckan,
 *   Låg     = räcker inte till veckans besök, eller räcker kortare än WAREHOUSE_LOW_DAYS,
 *   OK      = annars.
 */
export function warehouseStatus(
  onHand: number,
  daysLeft: number | null,
  need: { readonly need: number; readonly short: number },
): StockStatus {
  const selling = daysLeft !== null || need.need > 0;
  if (onHand <= 0) return selling ? "critical" : "ok";
  if (need.short > 0) return "low";
  if (daysLeft !== null && daysLeft < WAREHOUSE_LOW_DAYS) return "low";
  return "ok";
}

/**
 * Par (automat, titel) som har gått ur sortimentet: paret har perioder i sortimentet,
 * ingen av dem gäller i dag och ingen börjar senare. Ett par utan perioder räknas aldrig
 * som utgånget (sortimentet är inte registrerat).
 */
export function retiredPairs(periods: readonly SlotPeriod[], today: IsoDate): Set<string> {
  const current = new Set<string>();
  const seen = new Set<string>();
  for (const p of periods) {
    const k = pairKey(p.machineId, p.titleId);
    seen.add(k);
    if (p.validTo === null || p.validTo >= today) current.add(k);
  }
  return new Set([...seen].filter((k) => !current.has(k)));
}

/** Planens tidpunkt (i går mitt på dagen); flyttad till @/server/data/visit-plan. */
export { planNow };

/** Bygger vymodellen. Ren funktion; `now` är den enda tidskällan. */
export function buildLagerModel(input: LagerModelInput): LagerModel {
  const { now, timeZone, today, master, stock, sales, scope, hasCentral } = input;
  const retired = retiredPairs(input.slotPeriods ?? [], today);
  const asOf = addDays(today, -1);
  const windowStart = addDays(asOf, -(WINDOW_DAYS - 1));

  const activeMachines = master.machines.filter((m) => isMachineActive(m, today));
  const machines = activeMachines
    .filter((m) => inScope(m, scope))
    .sort((a, b) => compareText(a.code, b.code));
  const storeName = new Map(master.stores.map((s) => [s.id, s.name]));
  const titleById = new Map(master.titles.map((t) => [t.id, t]));

  const orders = salesAsOrders(sales.filter((r) => r.date <= today));
  const ordersByPair = new Map<string, AnalyticsOrder[]>();
  const ordersByTitle = new Map<string, AnalyticsOrder[]>();
  for (const o of orders) {
    if (o.machineId === null) continue;
    const k = pairKey(o.machineId, o.titleId);
    (ordersByPair.get(k) ?? ordersByPair.set(k, []).get(k)!).push(o);
    (ordersByTitle.get(o.titleId) ?? ordersByTitle.set(o.titleId, []).get(o.titleId)!).push(o);
  }

  const machineRows = new Map<string, StockRow>();
  const centralRows = new Map<string, StockRow>();
  for (const r of stock) {
    if (r.locationKind === "machine" && r.machineId !== null) {
      machineRows.set(pairKey(r.machineId, r.titleId), r);
    } else if (r.isCentral) {
      centralRows.set(r.titleId, r);
    }
  }
  const hasWarehouse = hasCentral || centralRows.size > 0;

  const machineStock: StockLevelRef[] = [...machineRows.values()].map((r) => ({
    machineId: r.machineId as string,
    titleId: r.titleId,
    onHand: r.onHand,
    lastRestockedAt: r.lastRestockedAt,
  }));
  const warehouseStock = [...centralRows.values()].map((r) => ({
    titleId: r.titleId,
    onHand: r.onHand,
  }));

  // Påfyllningsregeln i Att göra avgör Kritisk och Låg.
  const todoCtx = createTodoContext(
    {
      orders,
      prices: [],
      agreements: [],
      placements: master.placements,
      settings: { vatRateBp: 0, cardFeeBp: 0 },
      titles: master.titles,
      machines: master.machines,
      stores: master.stores,
      stock: machineStock,
      reportRecipients: [],
      reportDeliveries: [],
      options: { timeZone },
    },
    now,
  );
  const refillLevel = new Map(
    refillTodos(todoCtx).map((t) => [t.key, t.level === "now" ? "critical" : "low"] as const),
  );

  // Besöksplanen räknar takt och slutdatum från planens "i dag". Med planNow (i går)
  // använder den samma fönster som matrisen och Att göra (14 hela dagar t.o.m. i går)
  // och samma slutdatum (domain.stockoutDate(i går, …)). Saldot är dagens.
  const planAt = planNow(asOf, timeZone, now);
  const planBase = {
    orders,
    titles: master.titles,
    ...(hasWarehouse ? { warehouseStock } : {}),
  };

  // Veckoplanen (alla automater, besöksdagar mån–fre från i dag): planerad dag, senaste
  // dag och centrallagrets veckobehov. Samma funktion och samma indata som Drift
  // (weeklyVisitPlan), inklusive extra besök för automater som Drift visar med fel.
  const weekly: VisitPlan = weeklyVisitPlan({
    orders,
    machines: activeMachines,
    titles: master.titles,
    stock: machineStock,
    warehouseStock: hasWarehouse ? warehouseStock : null,
    health: input.health ?? null,
    today,
    timeZone,
    now,
  });
  const weeklyStop = new Map(
    weekly.days.flatMap((d) =>
      d.stops.map((s) => [s.machineId, { day: d.date, stop: s }] as const),
    ),
  );
  const weeklyNeedBy = new Map(weekly.notNeeded.map((n) => [n.machineId, n.needBy]));

  // Påfyllningslista per automat: ett besök nu, oberoende av de andra automaterna.
  // Besöksdagen är planens första dag (i går enligt planAt) så att inga dagars
  // försäljning dras från dagens saldo: lager vid besöket = saldot nu.
  const packLists: PackList[] = [];
  const suggestedByPair = new Map<string, number>();
  for (const m of machines) {
    const plan = planVisits(
      {
        ...planBase,
        machines: [m],
        stock: machineStock.filter((s) => s.machineId === m.id),
        extraVisits: [{ machineId: m.id, reason: "", needBy: asOf }],
        options: {
          timeZone,
          start: asOf,
          visitWeekdays: [1, 2, 3, 4, 5, 6, 7],
          maxStopsPerDay: 1,
          minStopsPerTrip: 1,
        },
      },
      planAt,
    );
    const stop = plan.days.find((d) => d.date === asOf)?.stops.find((s) => s.machineId === m.id);
    const lines: PackListLine[] = [];
    const missing: PackListMissing[] = [];
    for (const p of stop?.packs ?? []) {
      // En utgången titel fylls inte på (säljs ut).
      if (retired.has(pairKey(m.id, p.titleId))) continue;
      if (p.quantity > 0) {
        suggestedByPair.set(pairKey(m.id, p.titleId), p.quantity);
        lines.push({
          titleId: p.titleId,
          titleName: p.titleName,
          quantity: p.quantity,
          onHand: p.onHandNow,
          target: p.target,
          shortBy: p.shortBy,
        });
      } else if (p.shortBy > 0) {
        missing.push({
          titleId: p.titleId,
          titleName: p.titleName,
          onHand: p.onHandNow,
          target: p.target,
          shortBy: p.shortBy,
        });
      }
    }
    const planned = weeklyStop.get(m.id);
    const needBy = planned ? planned.stop.needBy : (weeklyNeedBy.get(m.id) ?? null);
    const plannedDay = planned ? planned.day : null;
    packLists.push({
      machineId: m.id,
      lines,
      missing,
      totalPacks: lines.reduce((s, l) => s + l.quantity, 0),
      shortBy:
        lines.reduce((s, l) => s + l.shortBy, 0) + missing.reduce((s, l) => s + l.shortBy, 0),
      needBy,
      plannedDay,
      dueToday: lines.length > 0 && (plannedDay === today || (needBy !== null && needBy <= today)),
      // Orsakerna för besöket nu (samma takt som matrisen). Underskottet i centrallagret
      // visas från raderna och `missing`, så buildStops sammanfattning tas bort här.
      reasons: (stop?.reasons ?? []).filter(
        (r) => r.trim() !== "" && !r.startsWith(WAREHOUSE_SHORT_PREFIX),
      ),
    });
  }

  // Celler.
  const cellFor = (m: MachineRecord, titleId: string): StockCell => {
    const k = pairKey(m.id, titleId);
    const row = machineRows.get(k);
    const v = salesVelocity(dailyUnits(ordersByPair.get(k) ?? []), {
      asOf,
      days: WINDOW_DAYS,
      ...(m.activeFrom !== null ? { activeFrom: m.activeFrom } : {}),
    });
    const onHand = Math.max(0, row?.onHand ?? 0);
    // En saldorad finns bara om titeln fyllts på, inventerats eller sålts i automaten.
    // Då är den lagerförd, även med 0 pack och utan försäljning i fönstret (ett fack
    // som varit tomt länge säljer inget och ska ändå stå som Kritisk).
    const stocked = row !== undefined || v.units > 0;
    const level = refillLevel.get(`refill:${m.id}:${titleId}`);
    const isRetired = stocked && retired.has(k);
    const status: StockStatus =
      !stocked || isRetired ? "ok" : onHand === 0 ? "critical" : (level ?? "ok");
    return {
      machineId: m.id,
      titleId,
      stocked,
      onHand,
      perDayTenths: perDayTenths(v),
      daysLeft: daysOfStockLeft(onHand, v),
      stockoutDate: stockoutDate(asOf, onHand, v),
      status,
      suggested: isRetired ? 0 : (suggestedByPair.get(k) ?? 0),
      lastRestockedAt: row?.lastRestockedAt ?? null,
      retired: isRetired,
    };
  };

  const candidateTitles = master.titles.filter((t) => !t.archived);
  const centralOnHand = (titleId: string) => centralRows.get(titleId)?.onHand ?? 0;
  // Utgången överallt: lagerförd någonstans, alla lagerförda platser utgångna, inget kvar.
  const goneEverywhere = (titleId: string, cells: readonly StockCell[]) =>
    cells.some((c) => c.stocked) &&
    cells.every((c) => !c.stocked || (c.retired && c.onHand === 0)) &&
    centralOnHand(titleId) <= 0;
  const allRows = candidateTitles
    .map((t) => ({ title: t, cells: machines.map((m) => cellFor(m, t.id)) }))
    .filter(
      (r) => r.cells.some((c) => c.stocked) || (machines.length > 0 && centralOnHand(r.title.id) > 0),
    );
  const retiredRows = allRows.filter((r) => goneEverywhere(r.title.id, r.cells));
  const hiddenTitles = new Set(retiredRows.map((r) => r.title.id));
  const rows = allRows
    .filter((r) => !hiddenTitles.has(r.title.id))
    .sort((a, b) => {
      const worst = (cells: StockCell[]) =>
        Math.min(
          ...cells.filter((c) => c.stocked && !c.retired).map((c) => STATUS_RANK[c.status]),
          3,
        );
      return worst(a.cells) - worst(b.cells) || compareText(a.title.name, b.title.name);
    });

  // Centrallagret: alla automaters takt och veckoplanens behov.
  const weekNeed = new Map<string, { need: number; short: number }>();
  for (const d of weekly.days) {
    for (const s of d.stops) {
      for (const p of s.packs) {
        const cur = weekNeed.get(p.titleId) ?? { need: 0, short: 0 };
        weekNeed.set(p.titleId, {
          need: cur.need + p.quantity + p.shortBy,
          short: cur.short + p.shortBy,
        });
      }
    }
  }
  const warehouseTitleIds = new Set<string>([...centralRows.keys(), ...weekNeed.keys()]);
  const warehouse: WarehouseRow[] = hasWarehouse
    ? [...warehouseTitleIds]
        .filter((id) => titleById.get(id) && !titleById.get(id)!.archived)
        // Utgången överallt och inget behov: hör inte hemma i lagret längre.
        .filter((id) => !(hiddenTitles.has(id) && (weekNeed.get(id)?.need ?? 0) === 0))
        .map((titleId) => {
          const row = centralRows.get(titleId);
          const onHand = row?.onHand ?? 0;
          const v = salesVelocity(dailyUnits(ordersByTitle.get(titleId) ?? []), {
            asOf,
            days: WINDOW_DAYS,
          });
          const need = weekNeed.get(titleId) ?? { need: 0, short: 0 };
          const daysLeft = daysOfStockLeft(Math.max(0, onHand), v);
          return {
            titleId,
            onHand,
            perDayTenths: perDayTenths(v),
            daysLeft,
            weekNeed: need.need,
            shortBy: need.short,
            status: warehouseStatus(onHand, daysLeft, need),
            lastCountedAt: row?.lastCountedAt ?? null,
          };
        })
        .sort(
          (a, b) =>
            STATUS_RANK[a.status] - STATUS_RANK[b.status] ||
            compareText(titleById.get(a.titleId)!.name, titleById.get(b.titleId)!.name),
        )
    : [];

  const counts = { critical: 0, low: 0, ok: 0 };
  for (const r of rows) for (const c of r.cells) if (c.stocked && !c.retired) counts[c.status] += 1;

  return {
    window: { start: windowStart, end: asOf, days: WINDOW_DAYS },
    lowThresholdTenths: roundHalfUp(TODO_DEFAULTS.refillThresholdCentidays, 10),
    machines: machines.map((m) => ({
      id: m.id,
      code: m.code,
      name: m.name,
      storeName: m.storeId ? (storeName.get(m.storeId) ?? null) : null,
    })),
    titles: rows.map((r) => ({ id: r.title.id, name: r.title.name })),
    cells: rows.map((r) => r.cells),
    hasWarehouse,
    warehouse,
    packLists,
    counts,
    retiredTitles: retiredRows
      .map((r) => ({ id: r.title.id, name: r.title.name }))
      .sort((a, b) => compareText(a.name, b.name)),
  };
}
