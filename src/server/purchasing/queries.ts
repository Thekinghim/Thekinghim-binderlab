/**
 * Frågorna bakom Prognos & inköp. Varje funktion tar en transaktion som redan kör som
 * användaren (withUserDbFor, alltså med RLS) och organisationens id. Ingen funktion här
 * kontrollerar roller (det gör load.ts och service.ts först) och ingen räknar: raderna
 * formas bara om till de typer som @/analytics vill ha.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import type { StockEventRef } from "@/analytics/lost-sales/stock";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { IsoDate } from "@/domain";

import type {
  PurchaseOrderLineRecord,
  PurchaseOrderRecord,
  SupplierItemRecord,
  SupplierRecord,
} from "./types";

type Row = Record<string, unknown>;

async function rows<T extends Row>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

/** Leverantörer, även arkiverade (de behövs för gamla inköpsorder). Namnordning. */
export async function querySuppliers(tx: Tx, orgId: string): Promise<SupplierRecord[]> {
  const list = await tx
    .select({
      id: s.suppliers.id,
      name: s.suppliers.name,
      contactName: s.suppliers.contactName,
      email: s.suppliers.email,
      phone: s.suppliers.phone,
      defaultLeadTimeDays: s.suppliers.defaultLeadTimeDays,
      archivedAt: s.suppliers.archivedAt,
    })
    .from(s.suppliers)
    .where(eq(s.suppliers.organizationId, orgId))
    .orderBy(asc(s.suppliers.name), asc(s.suppliers.id));
  return list.map((r) => ({
    id: r.id,
    name: r.name,
    contactName: r.contactName,
    email: r.email,
    phone: r.phone,
    defaultLeadTimeDays: r.defaultLeadTimeDays,
    archived: r.archivedAt !== null,
  }));
}

export async function querySupplierItems(tx: Tx, orgId: string): Promise<SupplierItemRecord[]> {
  const list = await tx
    .select({
      id: s.supplierItems.id,
      supplierId: s.supplierItems.supplierId,
      titleId: s.supplierItems.titleId,
      packSize: s.supplierItems.packSize,
      minOrderQty: s.supplierItems.minOrderQty,
      leadTimeDays: s.supplierItems.leadTimeDays,
      unitCostOre: s.supplierItems.unitCostOre,
    })
    .from(s.supplierItems)
    .where(eq(s.supplierItems.organizationId, orgId))
    .orderBy(asc(s.supplierItems.supplierId), asc(s.supplierItems.titleId));
  return list.map((r) => ({ ...r, unitCostOre: Number(r.unitCostOre) }));
}

/** Inköpsorder med rader, nyast först. */
export async function queryPurchaseOrders(
  tx: Tx,
  orgId: string,
  ids?: readonly string[],
): Promise<PurchaseOrderRecord[]> {
  const where = ids
    ? and(eq(s.purchaseOrders.organizationId, orgId), inArray(s.purchaseOrders.id, [...ids]))
    : eq(s.purchaseOrders.organizationId, orgId);
  const heads = await tx
    .select({
      id: s.purchaseOrders.id,
      supplierId: s.purchaseOrders.supplierId,
      status: s.purchaseOrders.status,
      orderedOn: s.purchaseOrders.orderedOn,
      expectedOn: s.purchaseOrders.expectedOn,
      receivedOn: s.purchaseOrders.receivedOn,
      note: s.purchaseOrders.note,
      createdAt: s.purchaseOrders.createdAt,
    })
    .from(s.purchaseOrders)
    .where(where)
    .orderBy(desc(s.purchaseOrders.createdAt), asc(s.purchaseOrders.id));
  if (heads.length === 0) return [];
  const lines = await tx
    .select({
      id: s.purchaseOrderLines.id,
      purchaseOrderId: s.purchaseOrderLines.purchaseOrderId,
      titleId: s.purchaseOrderLines.titleId,
      quantity: s.purchaseOrderLines.quantity,
      unitCostOre: s.purchaseOrderLines.unitCostOre,
      receivedQuantity: s.purchaseOrderLines.receivedQuantity,
    })
    .from(s.purchaseOrderLines)
    .where(
      and(
        eq(s.purchaseOrderLines.organizationId, orgId),
        inArray(
          s.purchaseOrderLines.purchaseOrderId,
          heads.map((h) => h.id),
        ),
      ),
    )
    .orderBy(asc(s.purchaseOrderLines.createdAt), asc(s.purchaseOrderLines.id));
  const byOrder = new Map<string, PurchaseOrderLineRecord[]>();
  for (const l of lines) {
    const list = byOrder.get(l.purchaseOrderId) ?? [];
    list.push({
      id: l.id,
      titleId: l.titleId,
      quantity: l.quantity,
      unitCostOre: Number(l.unitCostOre),
      receivedQuantity: l.receivedQuantity,
    });
    byOrder.set(l.purchaseOrderId, list);
  }
  return heads.map((h) => ({
    id: h.id,
    supplierId: h.supplierId,
    status: h.status,
    orderedOn: h.orderedOn,
    expectedOn: h.expectedOn,
    receivedOn: h.receivedOn,
    note: h.note,
    createdAt: h.createdAt.toISOString(),
    lines: byOrder.get(h.id) ?? [],
  }));
}

/** Centrallagrets id, eller null. */
export async function queryCentralLocation(tx: Tx, orgId: string): Promise<string | null> {
  const list = await tx
    .select({ id: s.stockLocations.id })
    .from(s.stockLocations)
    .where(and(eq(s.stockLocations.organizationId, orgId), eq(s.stockLocations.isCentral, true)))
    .limit(1);
  return list[0]?.id ?? null;
}

/**
 * Lagerhändelser i automaterna t.o.m. `end`, för att räkna saldot dag för dag
 * (@/analytics/lost-sales). Per lagerplats och titel börjar listan vid den senaste
 * inventeringen före `from` (den sätter saldot), annars vid första händelsen. Så blir
 * saldot exakt detsamma som med hela historiken, utan att allt behöver läsas.
 */
export async function queryMachineStockEvents(
  tx: Tx,
  orgId: string,
  from: IsoDate,
  end: IsoDate,
): Promise<StockEventRef[]> {
  const list = await rows<{
    id: string;
    location_id: string;
    machine_id: string | null;
    title_id: string;
    kind: StockEventRef["kind"];
    quantity: number;
    business_date: string;
    occurred_at: Date | string;
    seq: number | string;
  }>(
    tx,
    sql`
      with last_count as (
        select e.location_id, e.title_id, max(e.business_date) as d
        from public.stock_events e
        where e.organization_id = ${orgId}::uuid
          and e.kind = 'count'
          and e.business_date < ${from}::date
        group by e.location_id, e.title_id
      )
      select e.id, e.location_id, l.machine_id, e.title_id, e.kind, e.quantity,
             e.business_date::text as business_date, e.occurred_at, e.seq
      from public.stock_events e
      join public.stock_locations l
        on l.organization_id = e.organization_id and l.id = e.location_id
      left join last_count lc
        on lc.location_id = e.location_id and lc.title_id = e.title_id
      where e.organization_id = ${orgId}::uuid
        and l.kind = 'machine'
        and e.business_date <= ${end}::date
        and (lc.d is null or e.business_date >= lc.d)
      order by e.business_date, e.occurred_at, e.seq, e.id
    `,
  );
  return list.map((r) => ({
    id: r.id,
    locationId: r.location_id,
    machineId: r.machine_id,
    titleId: r.title_id,
    kind: r.kind,
    quantity: Number(r.quantity),
    businessDate: r.business_date,
    occurredAt: r.occurred_at instanceof Date ? r.occurred_at.toISOString() : String(r.occurred_at),
    seq: Number(r.seq),
  }));
}
