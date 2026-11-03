/**
 * Laddaren för Vårt lager. Ägare, admin och läsare (samma som Prognos & inköp: sidan visar
 * värdet till inköpspris). Rollen kontrolleras mot databasen och allt läses som användaren
 * med RLS. Saldon, dagar kvar och status kommer från Lagers laddare (loadOurStockFor),
 * försäljningen från de gemensamma laddarna; här läses priserna och senaste händelsen.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { addDays } from "@/domain";
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
import { ECONOMY_ROLES } from "@/server/data/core/types";

import { loadOurStockFor } from "../../lager/_lib/data";
import { buildVartLagerModel, type VartLagerModel, type WarehouseEvent } from "./model";

/** Roller som får skriva antal hemma och inköp (RLS: 'receipt' är ägare och admin). */
export const EDIT_ROLES = ["owner", "admin"] as const;

/** Senaste händelsen (inte försäljning) per titel i centrallagret. */
async function queryLatest(tx: Tx, orgId: string): Promise<Map<string, WarehouseEvent>> {
  const result = await tx.execute(sql`
    select distinct on (e.title_id)
      e.title_id::text as title_id, e.kind::text as kind, e.quantity, e.occurred_at,
      e.note, e.source
    from public.stock_events e
    join public.stock_locations l
      on l.organization_id = e.organization_id and l.id = e.location_id
    where e.organization_id = ${orgId}::uuid and l.is_central and e.kind <> 'sale'
    order by e.title_id, e.occurred_at desc, e.seq desc`);
  const map = new Map<string, WarehouseEvent>();
  for (const r of Array.from(result) as {
    title_id: string;
    kind: string;
    quantity: number;
    occurred_at: Date | string;
    note: string | null;
    source: string | null;
  }[]) {
    map.set(r.title_id, {
      titleId: r.title_id,
      kind: r.kind,
      quantity: Number(r.quantity),
      occurredAt: new Date(r.occurred_at).toISOString(),
      note: r.note,
      source: r.source,
    });
  }
  return map;
}

export interface VartLagerView extends VartLagerModel {
  readonly hasWarehouse: boolean;
}

export async function loadVartLagerFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<VartLagerView> {
  const role = await requireRoleFor(viewer.user, viewer.organization.id, ECONOMY_ROLES);
  const orgId = viewer.organization.id;
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);

  const [our, master, stock, sales, prices, latest] = await Promise.all([
    loadOurStockFor(viewer, now),
    loadMasterDataFor(viewer, now),
    loadStockFor(viewer),
    loadSalesCountsFor(viewer, { period: { start: addDays(today, -6), end: today } }),
    withUserDbFor(viewer.user, (tx) => queryPrices(tx, orgId)),
    withUserDbFor(viewer.user, (tx) => queryLatest(tx, orgId)),
  ]);

  const home = new Map<string, number>();
  const inMachines = new Map<string, number>();
  for (const r of stock.rows) {
    if (r.isCentral) home.set(r.titleId, r.onHand);
    else if (r.locationKind === "machine" && (r.lastCountedAt || r.lastRestockedAt)) {
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
      .map((t) => ({ id: t.id, name: t.name })),
    warehouse: our.rows,
    home,
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
  });
  return { ...model, hasWarehouse: our.hasWarehouse };
}
