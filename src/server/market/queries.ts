/**
 * Frågorna bakom Marknad. Varje funktion tar en transaktion som redan kör som användaren
 * (withUserDbFor, alltså med RLS) och organisationens id. Rollen kontrolleras i
 * ./service innan frågorna körs. Ingen beräkning här: raderna formas bara om.
 */

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { IsoDate } from "@/domain";

import type {
  AllocationRow,
  AssortmentChangeRow,
  PriceExperimentRow,
  PurchaseLineRow,
  QuoteRow,
  ReleaseRow,
  SlotRow,
  SupplierItemRow,
  SupplierRow,
} from "./types";

function textOf(snapshot: unknown): string | null {
  if (typeof snapshot !== "object" || snapshot === null) return null;
  const t = (snapshot as { text?: unknown }).text;
  return typeof t === "string" ? t : null;
}

/** Släppen som inte är arkiverade, äldst först. */
export async function queryReleases(tx: Tx, orgId: string): Promise<ReleaseRow[]> {
  const rows = await tx
    .select()
    .from(s.releases)
    .where(and(eq(s.releases.organizationId, orgId), isNull(s.releases.archivedAt)))
    .orderBy(asc(s.releases.releaseDate), asc(s.releases.name), asc(s.releases.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    series: r.series,
    releaseDate: r.releaseDate,
    titleId: r.titleId,
    supplierId: r.supplierId,
    scaleBp: r.scaleBp,
    horizonDays: r.horizonDays,
    boxSize: r.boxSize,
    minOrderQty: r.minOrderQty,
    source: r.source,
    note: r.note,
    planLockedAt: r.planLockedAt ? r.planLockedAt.toISOString() : null,
    planLockedBy: r.planLockedBy,
    planPurchaseUnits: r.planPurchaseUnits,
    planCurveBp: r.planCurveBp,
    planText: textOf(r.planSnapshot),
  }));
}

export async function queryAllocations(tx: Tx, orgId: string): Promise<AllocationRow[]> {
  const rows = await tx
    .select()
    .from(s.releaseAllocations)
    .where(eq(s.releaseAllocations.organizationId, orgId))
    .orderBy(asc(s.releaseAllocations.releaseId), asc(s.releaseAllocations.machineId));
  return rows.map((r) => ({
    id: r.id,
    releaseId: r.releaseId,
    machineId: r.machineId,
    units: r.units,
    suggestedUnits: r.suggestedUnits,
  }));
}

export async function queryQuotes(tx: Tx, orgId: string): Promise<QuoteRow[]> {
  const rows = await tx
    .select()
    .from(s.supplierPriceQuotes)
    .where(eq(s.supplierPriceQuotes.organizationId, orgId))
    .orderBy(asc(s.supplierPriceQuotes.quotedOn), asc(s.supplierPriceQuotes.id));
  return rows.map((r) => ({
    id: r.id,
    supplierId: r.supplierId,
    titleId: r.titleId,
    quotedOn: r.quotedOn,
    validUntil: r.validUntil,
    unitCostOre: r.unitCostOre,
    quantity: r.quantity,
    kind: r.kind,
    source: r.source,
    note: r.note,
    createdBy: r.createdBy,
  }));
}

/**
 * Inköpsorderrader (utom makulerade inköpsordrar) med leverantör och datum. Datum =
 * beställningsdag, annars dagen inköpsordern skapades i organisationens tidszon.
 */
export async function queryPurchaseLines(
  tx: Tx,
  orgId: string,
  timeZone: string,
): Promise<PurchaseLineRow[]> {
  const result = await tx.execute(sql`
    select l.id, l.purchase_order_id, po.supplier_id, l.title_id, l.unit_cost_ore, l.quantity,
           po.status::text as status,
           coalesce(po.ordered_on, (po.created_at at time zone ${timeZone})::date)::text as day
    from public.purchase_order_lines l
    join public.purchase_orders po
      on po.organization_id = l.organization_id and po.id = l.purchase_order_id
    where l.organization_id = ${orgId} and po.status <> 'cancelled'
    order by day, l.id`);
  return Array.from(result).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id),
      purchaseOrderId: String(r.purchase_order_id),
      supplierId: String(r.supplier_id),
      titleId: String(r.title_id),
      date: String(r.day) as IsoDate,
      unitCostOre: Number(r.unit_cost_ore),
      quantity: Number(r.quantity),
      status: String(r.status),
    };
  });
}

export async function querySuppliers(tx: Tx, orgId: string): Promise<SupplierRow[]> {
  const rows = await tx
    .select({ id: s.suppliers.id, name: s.suppliers.name, archivedAt: s.suppliers.archivedAt })
    .from(s.suppliers)
    .where(eq(s.suppliers.organizationId, orgId))
    .orderBy(asc(s.suppliers.name), asc(s.suppliers.id));
  return rows.map((r) => ({ id: r.id, name: r.name, archived: r.archivedAt !== null }));
}

export async function querySupplierItems(tx: Tx, orgId: string): Promise<SupplierItemRow[]> {
  const rows = await tx
    .select({
      supplierId: s.supplierItems.supplierId,
      titleId: s.supplierItems.titleId,
      packSize: s.supplierItems.packSize,
      minOrderQty: s.supplierItems.minOrderQty,
    })
    .from(s.supplierItems)
    .where(eq(s.supplierItems.organizationId, orgId));
  return rows;
}

export async function querySlots(tx: Tx, orgId: string): Promise<SlotRow[]> {
  const rows = await tx
    .select()
    .from(s.machineSlots)
    .where(eq(s.machineSlots.organizationId, orgId))
    .orderBy(asc(s.machineSlots.machineId), asc(s.machineSlots.validFrom), asc(s.machineSlots.id));
  return rows.map((r) => ({
    id: r.id,
    machineId: r.machineId,
    titleId: r.titleId,
    slots: r.slots,
    validFrom: r.validFrom,
    validTo: r.validTo,
  }));
}

export async function queryAssortmentChanges(
  tx: Tx,
  orgId: string,
): Promise<AssortmentChangeRow[]> {
  const rows = await tx
    .select()
    .from(s.assortmentChanges)
    .where(eq(s.assortmentChanges.organizationId, orgId))
    .orderBy(asc(s.assortmentChanges.implementedOn), asc(s.assortmentChanges.id));
  return rows.map((r) => ({
    id: r.id,
    machineId: r.machineId,
    implementedOn: r.implementedOn,
    recommendationKey: r.recommendationKey,
    fingerprint: r.fingerprint,
    expectedEffectPerWeekOre: r.expectedEffectPerWeekOre,
    changedTitleIds: r.changedTitleIds,
    text: textOf(r.snapshot),
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function queryExperiments(tx: Tx, orgId: string): Promise<PriceExperimentRow[]> {
  const [rows, arms] = await Promise.all([
    tx
      .select()
      .from(s.priceExperiments)
      .where(eq(s.priceExperiments.organizationId, orgId))
      .orderBy(asc(s.priceExperiments.startedOn), asc(s.priceExperiments.id)),
    tx
      .select({
        experimentId: s.priceExperimentMachines.experimentId,
        machineId: s.priceExperimentMachines.machineId,
        arm: s.priceExperimentMachines.arm,
      })
      .from(s.priceExperimentMachines)
      .where(eq(s.priceExperimentMachines.organizationId, orgId))
      .orderBy(asc(s.priceExperimentMachines.machineId)),
  ]);
  const armOf = (id: string, arm: "test" | "control") =>
    arms.filter((a) => a.experimentId === id && a.arm === arm).map((a) => a.machineId);
  return rows.map((r) => ({
    id: r.id,
    titleId: r.titleId,
    proposalKey: r.proposalKey,
    direction: r.direction,
    fromOre: r.fromOre,
    toOre: r.toOre,
    startedOn: r.startedOn,
    testDays: r.testDays,
    stoppedOn: r.stoppedOn,
    testMachineIds: armOf(r.id, "test"),
    controlMachineIds: armOf(r.id, "control"),
    text: textOf(r.snapshot),
  }));
}
