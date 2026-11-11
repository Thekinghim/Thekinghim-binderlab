/**
 * Laddaren för Lager. Alla roller får se sidan; inget här innehåller belopp.
 *
 * Rollen kontrolleras mot databasen (requireRoleFor) och allt läses som användaren med
 * RLS (withUserDbFor). Saldon, stamdata och försäljning i antal kommer från de gemensamma
 * laddarna (src/server/data/core), historiken och namnen läses här.
 */

import "server-only";

import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from "drizzle-orm";

import { addDays, type IsoDate, type Period } from "@/domain";
import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import {
  businessToday,
  loadMasterDataFor,
  loadSalesCountsFor,
  loadStockFor,
  type Viewer,
} from "@/server/data/core/loaders";
import { ALL_ROLES, type DataScope } from "@/server/data/core/types";

import { querySlotPeriods } from "@/server/data/assortment";
import { loadMachineHealthFor } from "@/server/data/health";
import { querySlotAlerts, SLOT_ALERT_ROLES } from "@/server/data/core/slot-alerts";
import { querySlotCapacities } from "@/server/data/core/slot-capacity";
import { weekShapesInRequest } from "@/server/data/week-shapes";

import { buildLagerModel, WINDOW_DAYS } from "./model";
import {
  HISTORY_LIMIT,
  type HistoryEntry,
  type HistoryKind,
  type LagerTitle,
  type LagerView,
  type WarehouseRow,
} from "./types";

/** Roller som får registrera påfyllning och inventering (RLS och register_refill). */
export const REGISTER_ROLES = ["owner", "admin", "refiller"] as const;

export interface LagerArgs {
  /** Perioden för historiken. */
  readonly period: Period;
  readonly scope: DataScope;
}

interface HistoryResult {
  readonly entries: HistoryEntry[];
  readonly total: number;
}

/** Ett eget lager (Hemma, Kontoret …). */
export interface OwnPlace {
  readonly id: string;
  readonly name: string;
  /** Standardlagret (is_central): används när inget annat är valt. */
  readonly isDefault: boolean;
}

/** Organisationens aktiva egna lager: standardlagret först, sedan i den ordning de skapades. */
export async function queryOwnPlaces(tx: Tx, orgId: string): Promise<OwnPlace[]> {
  const rows = await tx
    .select({
      id: s.stockLocations.id,
      name: s.stockLocations.name,
      isDefault: s.stockLocations.isCentral,
    })
    .from(s.stockLocations)
    .where(
      and(
        eq(s.stockLocations.organizationId, orgId),
        eq(s.stockLocations.kind, "warehouse"),
        isNull(s.stockLocations.archivedAt),
      ),
    )
    .orderBy(desc(s.stockLocations.isCentral), s.stockLocations.createdAt, s.stockLocations.id);
  return rows;
}

/** Senaste läsningen av automatens fack från Awish, per automat. */
async function queryAwishSynced(tx: Tx, orgId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ machineId: s.stockLocations.machineId, at: s.stockLocations.awishSyncedAt })
    .from(s.stockLocations)
    .where(
      and(
        eq(s.stockLocations.organizationId, orgId),
        sql`${s.stockLocations.machineId} is not null`,
        sql`${s.stockLocations.awishSyncedAt} is not null`,
      ),
    );
  return new Map(rows.map((r) => [r.machineId as string, new Date(r.at!).toISOString()]));
}

async function queryPerformers(tx: Tx, orgId: string): Promise<Map<string, string | null>> {
  const result = await tx.execute(
    sql`select user_id::text as user_id, display_name from public.lager_performers(${orgId}::uuid)`,
  );
  const map = new Map<string, string | null>();
  for (const r of Array.from(result) as { user_id: string; display_name: string | null }[]) {
    map.set(r.user_id, r.display_name?.trim() || null);
  }
  return map;
}

async function queryHistory(
  tx: Tx,
  orgId: string,
  period: Period,
  machineIds: readonly string[] | null,
  selfId: string,
  names: { title: (id: string) => string; machineCode: (id: string) => string | null },
): Promise<HistoryResult> {
  const where = and(
    eq(s.stockEvents.organizationId, orgId),
    ne(s.stockEvents.kind, "sale"),
    // Uttaget ur vårt lager vid en påfyllning visas på påfyllningsraden (fromWarehouse).
    sql`not (${s.stockEvents.kind} = 'adjustment' and coalesce(${s.stockEvents.note}, '') like 'Uttag till påfyllning%')`,
    gte(s.stockEvents.businessDate, period.start),
    lte(s.stockEvents.businessDate, period.end),
    machineIds === null
      ? undefined
      : machineIds.length === 0
        ? eq(s.stockLocations.kind, "warehouse")
        : sql`(${s.stockLocations.kind} = 'warehouse' or ${inArray(s.stockLocations.machineId, [...machineIds])})`,
  );
  const base = tx
    .select({
      id: s.stockEvents.id,
      kind: s.stockEvents.kind,
      quantity: s.stockEvents.quantity,
      occurredAt: s.stockEvents.occurredAt,
      titleId: s.stockEvents.titleId,
      machineId: s.stockLocations.machineId,
      performedBy: s.stockEvents.performedBy,
      // register_refill (och seed-datan) drar uttaget ur centrallagret i samma transaktion:
      // samma titel, tidpunkt och antal, med noteringen "Uttag till påfyllning av <kod>".
      // Koden kopplar uttaget till just den här automaten.
      fromWarehouse: sql<boolean>`(${s.stockEvents.kind} = 'refill' and exists (
        select 1 from public.stock_events w
        where w.organization_id = ${s.stockEvents.organizationId}
          and w.kind = 'adjustment'
          and w.title_id = ${s.stockEvents.titleId}
          and w.occurred_at = ${s.stockEvents.occurredAt}
          and w.quantity = -${s.stockEvents.quantity}
          and w.note = 'Uttag till påfyllning av ' || (
            select m.code from public.machines m
            where m.id = ${s.stockLocations.machineId}
              and m.organization_id = ${s.stockEvents.organizationId})))`,
    })
    .from(s.stockEvents)
    .innerJoin(
      s.stockLocations,
      and(
        eq(s.stockLocations.id, s.stockEvents.locationId),
        eq(s.stockLocations.organizationId, s.stockEvents.organizationId),
      ),
    )
    .where(where);
  const [rows, totalRows, performers] = await Promise.all([
    base.orderBy(desc(s.stockEvents.occurredAt), desc(s.stockEvents.seq)).limit(HISTORY_LIMIT),
    tx
      .select({ n: sql<number>`count(*)::int` })
      .from(s.stockEvents)
      .innerJoin(
        s.stockLocations,
        and(
          eq(s.stockLocations.id, s.stockEvents.locationId),
          eq(s.stockLocations.organizationId, s.stockEvents.organizationId),
        ),
      )
      .where(where),
    queryPerformers(tx, orgId),
  ]);
  return {
    total: totalRows[0]?.n ?? 0,
    entries: rows.map((r) => ({
      id: r.id,
      kind: r.kind as HistoryKind,
      quantity: r.quantity,
      occurredAt: new Date(r.occurredAt).toISOString(),
      titleId: r.titleId,
      titleName: names.title(r.titleId),
      machineId: r.machineId,
      machineCode: r.machineId ? names.machineCode(r.machineId) : null,
      performer: r.performedBy ? (performers.get(r.performedBy) ?? null) : null,
      isSelf: r.performedBy === selfId,
      fromWarehouse: Boolean(r.fromWarehouse),
    })),
  };
}

/** Lagermodellen (utan historik) för vyn och för Vårt lager under Prognos & inköp. */
async function modelFor(viewer: Viewer, scope: DataScope, now: Date) {
  const role = await requireRoleFor(viewer.user, viewer.organization.id, ALL_ROLES);
  const orgId = viewer.organization.id;
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);
  // Fönstret slutar i går (matrisen, Att göra och besöksplanen via weeklyVisitPlan). Dagens
  // försäljning läses också men räknas inte i takten; saldot är alltid dagens.
  const salesFrom: IsoDate = addDays(today, -(WINDOW_DAYS + 1));

  const [
    master,
    stock,
    sales,
    health,
    slotPeriods,
    slotAlerts,
    awishSyncedAt,
    places,
    capacities,
    weekShares,
  ] = await Promise.all([
    loadMasterDataFor(viewer, now),
    loadStockFor(viewer),
    loadSalesCountsFor(viewer, { period: { start: salesFrom, end: today } }),
    // Samma maskinhälsa som Drift: automater med fel får besök i dag i veckoplanen.
    loadMachineHealthFor(viewer, now),
    withUserDbFor(viewer.user, (tx) => querySlotPeriods(tx, orgId)),
    withUserDbFor(viewer.user, (tx) => querySlotAlerts(tx, orgId)),
    withUserDbFor(viewer.user, (tx) => queryAwishSynced(tx, orgId)),
    withUserDbFor(viewer.user, (tx) => queryOwnPlaces(tx, orgId)),
    withUserDbFor(viewer.user, (tx) => querySlotCapacities(tx, orgId, now)),
    // Veckans form per automat: samma karta som Att göra och Besök (samma slutdag).
    weekShapesInRequest(viewer, today),
  ]);

  const model = buildLagerModel({
    now,
    timeZone,
    today,
    master,
    stock: stock.rows,
    sales: sales.rows,
    scope,
    hasCentral: places.length > 0,
    health,
    slotPeriods,
    slotAlerts,
    awishSyncedAt,
    capacities,
    weekShares,
  });
  return { model, master, role, orgId, timeZone, today, places, stock };
}

/**
 * Allt Lager visar: matrisen, påfyllningslistorna och historiken (och centrallagret för
 * registreringsdialogen). Alla roller; inga belopp. `now` är tidpunkten förfrågan räknar från.
 */
export async function loadLagerFor(
  viewer: Viewer,
  args: LagerArgs,
  now: Date = new Date(),
): Promise<LagerView> {
  const { model, master, role, orgId, timeZone, today } = await modelFor(viewer, args.scope, now);

  const titleName = new Map(master.titles.map((t) => [t.id, t.name]));
  const machineCode = new Map(master.machines.map((m) => [m.id, m.code]));
  const filtered = args.scope.machineId !== null || args.scope.storeId !== null;
  const history = await withUserDbFor(viewer.user, (tx) =>
    queryHistory(
      tx,
      orgId,
      args.period,
      filtered ? model.machines.map((m) => m.id) : null,
      viewer.user.userId,
      {
        title: (id) => titleName.get(id) ?? "Okänd titel",
        machineCode: (id) => machineCode.get(id) ?? null,
      },
    ),
  );

  return {
    today,
    now: now.toISOString(),
    timeZone,
    window: model.window,
    lowThresholdTenths: model.lowThresholdTenths,
    machines: model.machines,
    titles: model.titles,
    cells: model.cells,
    hasWarehouse: model.hasWarehouse,
    warehouse: model.warehouse,
    packLists: model.packLists,
    history: history.entries,
    historyTotal: history.total,
    counts: model.counts,
    unknownCount: model.unknownCount,
    retiredTitles: model.retiredTitles,
    canRegister: (REGISTER_ROLES as readonly string[]).includes(role),
    canSetAlert: (SLOT_ALERT_ROLES as readonly string[]).includes(role),
    packListFirst: role === "refiller" || args.scope.machineId !== null,
  };
}

/**
 * Vårt lager (alla egna lager tillsammans) för Prognos & inköp och Vårt lager: alltid hela
 * organisationen. `rows` är summan per titel; `byPlace` saldot per lager och titel.
 */
export interface OurStockView {
  readonly now: string;
  readonly timeZone: string;
  readonly windowDays: number;
  readonly hasWarehouse: boolean;
  readonly rows: WarehouseRow[];
  /** De egna lagren, standardlagret först. */
  readonly places: OwnPlace[];
  /** Saldot per lager: platsens id → titelns id → pack. */
  readonly byPlace: Record<string, Record<string, number>>;
  /** Alla aktiva titler (för att inventera en titel som inte står i listan). */
  readonly titles: LagerTitle[];
  readonly canRegister: boolean;
}

export async function loadOurStockFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<OurStockView> {
  const { model, master, role, timeZone, places, stock } = await modelFor(
    viewer,
    { storeId: null, machineId: null },
    now,
  );
  const byPlace: Record<string, Record<string, number>> = Object.fromEntries(
    places.map((p) => [p.id, {}]),
  );
  for (const r of stock.rows) {
    const place = byPlace[r.locationId];
    if (r.locationKind === "warehouse" && place) place[r.titleId] = r.onHand;
  }
  return {
    now: now.toISOString(),
    timeZone,
    windowDays: model.window.days,
    hasWarehouse: model.hasWarehouse,
    rows: model.warehouse,
    places,
    byPlace,
    titles: master.titles
      .filter((t) => !t.archived)
      .map((t) => ({ id: t.id, name: t.name }))
      .sort((a, b) => a.name.localeCompare(b.name, "sv", { sensitivity: "base", numeric: true })),
    canRegister: (REGISTER_ROLES as readonly string[]).includes(role),
  };
}
