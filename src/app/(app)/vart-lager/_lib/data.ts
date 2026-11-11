/**
 * Laddaren för Vårt lager. Ägare, admin och läsare (samma som Prognos & inköp: sidan visar
 * värdet till inköpspris). Rollen kontrolleras mot databasen och allt läses som användaren
 * med RLS. Saldon, dagar kvar och status kommer från Lagers laddare (loadOurStockFor),
 * försäljningen från de gemensamma laddarna; här läses priserna och senaste händelsen.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { purchaseQtyByTitle } from "@/analytics/purchasing";
import { onTheWay } from "@/analytics/purchasing/on-the-way";
import { addDays, DomainError } from "@/domain";
import type { Tx } from "@/db/client";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import {
  businessToday,
  loadMasterDataFor,
  loadSalesCountsFor,
  loadStockFor,
  type Viewer,
} from "@/server/data/core/loaders";
import { queryPrices } from "@/server/data/core/queries";
import { loadSlotPeriodsFor } from "@/server/data/assortment";
import { retiredTitles } from "@/analytics/todos/assortment";
import { sumOwnStock } from "@/server/data/core/own-stock";
import { ECONOMY_ROLES } from "@/server/data/core/types";
import { loadPurchasePlanFor } from "@/server/purchasing/load";

import { loadOurStockFor } from "../../lager/_lib/data";
import { buildVartLagerModel, type VartLagerModel, type WarehouseEvent } from "./model";

/** Roller som får skriva antal, inköp, flytt och ändra lagren (RLS: ägare och admin). */
export const EDIT_ROLES = ["owner", "admin"] as const;

/**
 * Senaste händelsen (inte försäljning) per titel och eget lager (aktiva lager), nyast
 * först per titel. Vid en flytt följer det andra lagrets namn med.
 */
async function queryLatest(tx: Tx, orgId: string): Promise<Map<string, WarehouseEvent[]>> {
  const result = await tx.execute(sql`
    select * from (
      select distinct on (e.location_id, e.title_id)
        e.title_id::text as title_id, e.location_id::text as location_id, e.kind::text as kind,
        e.quantity, e.occurred_at, e.seq, e.note, e.source,
        (select o.name from public.stock_events t
         join public.stock_locations o on o.organization_id = t.organization_id and o.id = t.location_id
         where t.organization_id = e.organization_id
           and t.transfer_group_id = e.transfer_group_id
           and t.location_id <> e.location_id
         limit 1) as counterpart
      from public.stock_events e
      join public.stock_locations l
        on l.organization_id = e.organization_id and l.id = e.location_id
      where e.organization_id = ${orgId}::uuid and l.kind = 'warehouse'
        and l.archived_at is null and e.kind <> 'sale'
      order by e.location_id, e.title_id, e.occurred_at desc, e.seq desc
    ) x
    order by x.title_id, x.occurred_at desc, x.seq desc`);
  const map = new Map<string, WarehouseEvent[]>();
  for (const r of Array.from(result) as {
    title_id: string;
    location_id: string;
    kind: string;
    quantity: number;
    occurred_at: Date | string;
    note: string | null;
    source: string | null;
    counterpart: string | null;
  }[]) {
    const list = map.get(r.title_id) ?? [];
    list.push({
      titleId: r.title_id,
      locationId: r.location_id,
      counterpart: r.counterpart,
      kind: r.kind,
      quantity: Number(r.quantity),
      occurredAt: new Date(r.occurred_at).toISOString(),
      note: r.note,
      source: r.source,
    });
    map.set(r.title_id, list);
  }
  return map;
}

/** "På väg" för en titel: beställt och inte framme än (inköpslistan). */
export interface WayView {
  readonly titleId: string;
  readonly name: string;
  readonly qty: number;
  readonly expectedOn: string;
  readonly late: boolean;
  readonly unitCostOre: number | null;
}

export interface VartLagerView extends VartLagerModel {
  /** Dagens affärsdatum. */
  readonly today: string;
  /** Det som är beställt och på väg, per titel (namnordning). */
  readonly onTheWay: readonly WayView[];
  readonly hasWarehouse: boolean;
  /** Ägare och admin: får skapa ett lager (även när inget finns än). */
  readonly canAddPlace: boolean;
}

export async function loadVartLagerFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<VartLagerView> {
  const role = await requireRoleFor(viewer.user, viewer.organization.id, ECONOMY_ROLES);
  const orgId = viewer.organization.id;
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);

  const [our, master, stock, sales, prices, latest, slotPeriods, plan] = await Promise.all([
    loadOurStockFor(viewer, now),
    loadMasterDataFor(viewer, now),
    loadStockFor(viewer),
    loadSalesCountsFor(viewer, { period: { start: addDays(today, -6), end: today } }),
    withUserDbFor(viewer.user, (tx) => queryPrices(tx, orgId)),
    withUserDbFor(viewer.user, (tx) => queryLatest(tx, orgId)),
    loadSlotPeriodsFor(viewer),
    // Inköps plan: "Beställ X st" med samma antal som /prognos. Kan den inte räknas
    // (för lite data) visas titlarna som tar slut utan antal.
    loadPurchasePlanFor(viewer, now).catch((error: unknown) => {
      if (error instanceof DomainError) return null;
      throw error;
    }),
  ]);

  // Vårt lager: summan av alla egna lager per titel.
  const home = new Map(sumOwnStock(stock.rows).map((r) => [r.titleId, r.onHand]));
  const inMachines = new Map<string, number>();
  for (const r of stock.rows) {
    if (r.locationKind === "machine" && (r.lastCountedAt || r.lastRestockedAt)) {
      inMachines.set(r.titleId, (inMachines.get(r.titleId) ?? 0) + Math.max(0, r.onHand));
    }
  }
  const sold7 = new Map<string, number>();
  for (const r of sales.rows) sold7.set(r.titleId, (sold7.get(r.titleId) ?? 0) + r.units);

  const storeName = new Map(master.stores.map((s) => [s.id, s.name]));
  const model = buildVartLagerModel({
    now,
    timeZone,
    today,
    titles: master.titles
      .filter((t) => !t.archived && t.mergedIntoId === null)
      .map((t) => ({
        id: t.id,
        name: t.name,
        ownProduct: t.ownProduct === true,
        mysteryBatchSize: t.mysteryBatchSize ?? null,
      })),
    // Samma antal som Inköp räknar med (aktiva automater): "i automaten" med en.
    machineCount: master.machines.filter((m) => !m.archived).length,
    warehouse: our.rows,
    home,
    places: our.places,
    byPlace: our.byPlace,
    inMachines,
    sold7,
    prices,
    latest,
    machines: master.machines.map((m) => ({
      code: m.code,
      name: m.name,
      storeName: m.storeId ? (storeName.get(m.storeId) ?? null) : null,
    })),
    canEdit: (EDIT_ROLES as readonly string[]).includes(role) && our.hasWarehouse,
    // Samma utgår-regel som Lager, Drift och Prognos.
    retired: retiredTitles(slotPeriods, today),
    purchase: plan ? purchaseQtyByTitle(plan) : null,
  });
  const rowOf = new Map(model.rows.map((r) => [r.titleId, r]));
  const way: WayView[] = (plan ? onTheWay(plan) : [])
    .flatMap((w) => {
      const r = rowOf.get(w.titleId);
      return r
        ? [
            {
              titleId: w.titleId,
              name: r.name,
              qty: w.quantity,
              expectedOn: w.expectedOn,
              late: w.late,
              unitCostOre: r.unitCostOre,
            },
          ]
        : [];
    })
    .sort((a, b) => a.name.localeCompare(b.name, "sv"));
  return {
    ...model,
    today,
    onTheWay: way,
    hasWarehouse: our.hasWarehouse,
    canAddPlace: (EDIT_ROLES as readonly string[]).includes(role),
  };
}
