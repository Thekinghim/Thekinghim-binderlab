/**
 * Lagersidans vymodell: ren funktion från saldon, försäljning i antal och stamdata.
 *
 * Alla tal kommer från beräkningslagret:
 *   - takt, dagar kvar och slutdatum: @/domain (salesVelocity, daysOfStockLeft, stockoutDate)
 *     över samma fönster som Att göra (14 hela dagar t.o.m. i går, TODO_DEFAULTS),
 *   - status Kritisk/Låg: påfyllningsregeln i @/analytics/todos (refillTodos), så att
 *     Lager och Att göra alltid säger samma sak. Ett tomt fack är alltid Kritisk,
 *   - påfyllningslista och centrallagrets veckobehov: besöksplanen i @/analytics/visits.
 *
 * Inga belopp: försäljningen kommer som antal (lagerhändelser av typen sale) och görs om
 * till order med beloppet 0, bara för att räkna takt.
 */

import { createTodoContext } from "@/analytics/todos/context";
import { isMachineActive } from "@/analytics/todos/common";
import { refillTodos } from "@/analytics/todos/refill";
import { TODO_DEFAULTS, type AnalyticsOrder, type StockLevelRef } from "@/analytics/todos";
import { planVisits, type VisitPlan } from "@/analytics/visits";
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
  StockCell,
  StockStatus,
  WarehouseRow,
} from "./types";

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

/** Bygger vymodellen. Ren funktion; `now` är den enda tidskällan. */
export function buildLagerModel(input: LagerModelInput): LagerModel {
  const { now, timeZone, today, master, stock, sales, scope, hasCentral } = input;
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

  // Påfyllningslista per automat: ett besök i dag, oberoende av de andra automaterna.
  const packLists: PackList[] = [];
  const suggestedByPair = new Map<string, number>();
  const weekly: VisitPlan = planVisits(
    {
      orders,
      machines: activeMachines,
      titles: master.titles,
      stock: machineStock,
      ...(hasWarehouse ? { warehouseStock } : {}),
      options: { timeZone },
    },
    now,
  );
  const weeklyStop = new Map(
    weekly.days.flatMap((d) =>
      d.stops.map((s) => [s.machineId, { day: d.date, stop: s }] as const),
    ),
  );
  const weeklyNeedBy = new Map(weekly.notNeeded.map((n) => [n.machineId, n.needBy]));
  for (const m of machines) {
    const plan = planVisits(
      {
        orders,
        machines: [m],
        titles: master.titles,
        stock: machineStock.filter((s) => s.machineId === m.id),
        ...(hasWarehouse ? { warehouseStock } : {}),
        extraVisits: [{ machineId: m.id, reason: "", needBy: today }],
        options: {
          timeZone,
          start: today,
          visitWeekdays: [1, 2, 3, 4, 5, 6, 7],
          maxStopsPerDay: 1,
          minStopsPerTrip: 1,
        },
      },
      now,
    );
    const stop = plan.days.find((d) => d.date === today)?.stops.find((s) => s.machineId === m.id);
    const lines = (stop?.packs ?? []).map((p) => {
      suggestedByPair.set(pairKey(m.id, p.titleId), p.quantity);
      return {
        titleId: p.titleId,
        titleName: p.titleName,
        quantity: p.quantity,
        onHand: p.onHandNow,
        target: p.target,
        shortBy: p.shortBy,
      };
    });
    const planned = weeklyStop.get(m.id);
    packLists.push({
      machineId: m.id,
      lines,
      totalPacks: lines.reduce((s, l) => s + l.quantity, 0),
      shortBy: lines.reduce((s, l) => s + l.shortBy, 0),
      needBy: planned ? planned.stop.needBy : (weeklyNeedBy.get(m.id) ?? null),
      plannedDay: planned ? planned.day : null,
      reasons: planned
        ? planned.stop.reasons.filter((r) => r.trim() !== "")
        : (stop?.reasons ?? []).filter((r) => r.trim() !== ""),
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
    const recent =
      row !== undefined &&
      (row.onHand > 0 || (row.lastEventAt !== null && row.lastEventAt.slice(0, 10) >= windowStart));
    const stocked = recent || v.units > 0;
    const level = refillLevel.get(`refill:${m.id}:${titleId}`);
    const status: StockStatus = !stocked ? "ok" : onHand === 0 ? "critical" : (level ?? "ok");
    return {
      machineId: m.id,
      titleId,
      stocked,
      onHand,
      perDayTenths: perDayTenths(v),
      daysLeft: daysOfStockLeft(onHand, v),
      stockoutDate: stockoutDate(asOf, onHand, v),
      status,
      suggested: suggestedByPair.get(k) ?? 0,
      lastRestockedAt: row?.lastRestockedAt ?? null,
    };
  };

  const candidateTitles = master.titles.filter((t) => !t.archived);
  const rows = candidateTitles
    .map((t) => ({ title: t, cells: machines.map((m) => cellFor(m, t.id)) }))
    .filter(
      (r) =>
        r.cells.some((c) => c.stocked) ||
        (machines.length > 0 && (centralRows.get(r.title.id)?.onHand ?? 0) > 0),
    )
    .sort((a, b) => {
      const worst = (cells: StockCell[]) =>
        Math.min(...cells.filter((c) => c.stocked).map((c) => STATUS_RANK[c.status]), 3);
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
        .map((titleId) => {
          const row = centralRows.get(titleId);
          const onHand = row?.onHand ?? 0;
          const v = salesVelocity(dailyUnits(ordersByTitle.get(titleId) ?? []), {
            asOf,
            days: WINDOW_DAYS,
          });
          const need = weekNeed.get(titleId) ?? { need: 0, short: 0 };
          const status: StockStatus = need.short > 0 ? (onHand <= 0 ? "critical" : "low") : "ok";
          return {
            titleId,
            onHand,
            perDayTenths: perDayTenths(v),
            daysLeft: daysOfStockLeft(Math.max(0, onHand), v),
            weekNeed: need.need,
            shortBy: need.short,
            status,
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
  for (const r of rows) for (const c of r.cells) if (c.stocked) counts[c.status] += 1;

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
  };
}
