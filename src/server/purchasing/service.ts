/**
 * Ändringar i inköpen: leverantörer, leverantörsartiklar, inköpsorder och mottagning.
 * Bundna till en verifierad användare och organisation (Viewer); server actions anropar
 * dem med sessionens användare, testerna (test/db/prognos-*.test.ts) direkt.
 *
 * Varje funktion kontrollerar rollen mot databasen först (bara ägare och admin) och
 * skriver sedan som användaren med RLS. Mottagningen ökar `received_quantity`; databasens
 * trigger skriver då en lagerhändelse av typen `receipt` i centrallagret.
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { addDays, type IsoDate } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { pgErrorOf } from "@/server/errors";

import { queryPurchaseOrders } from "./queries";
import type {
  CreatePurchaseOrderInput,
  ReceiveInput,
  SupplierInput,
  SupplierItemInput,
  UpdateSupplierInput,
} from "./schemas";
import type { PurchaseOrderRecord, PurchaseOrderStatus } from "./types";

/** Fel som visas för användaren som det är (svensk text). */
export class PurchasingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PurchasingError";
  }
}

async function asOperator<T>(viewer: Viewer, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  try {
    return await withUserDbFor(viewer.user, fn);
  } catch (error) {
    // Databasens egna kontroller (trigger) har svenska meddelanden.
    const pg = pgErrorOf(error);
    if (pg?.code === "22023" && pg.message) throw new PurchasingError(pg.message);
    throw error;
  }
}

function todayOf(viewer: Viewer, now: Date): IsoDate {
  return businessToday(now, viewer.organization.timezone);
}

// ---------------------------------------------------------------------------
// Leverantörer
// ---------------------------------------------------------------------------

export async function createSupplierFor(viewer: Viewer, input: SupplierInput): Promise<string> {
  return asOperator(viewer, async (tx) => {
    const [row] = await tx
      .insert(s.suppliers)
      .values({
        organizationId: viewer.organization.id,
        name: input.name,
        contactName: input.contactName,
        email: input.email,
        phone: input.phone,
        defaultLeadTimeDays: input.defaultLeadTimeDays,
      })
      .returning({ id: s.suppliers.id });
    return row!.id;
  });
}

export async function updateSupplierFor(viewer: Viewer, input: UpdateSupplierInput): Promise<void> {
  await asOperator(viewer, async (tx) => {
    const updated = await tx
      .update(s.suppliers)
      .set({
        name: input.name,
        contactName: input.contactName,
        email: input.email,
        phone: input.phone,
        defaultLeadTimeDays: input.defaultLeadTimeDays,
      })
      .where(
        and(eq(s.suppliers.organizationId, viewer.organization.id), eq(s.suppliers.id, input.id)),
      )
      .returning({ id: s.suppliers.id });
    if (updated.length === 0) throw new PurchasingError("Leverantören finns inte.");
  });
}

/** Arkiverar (eller återställer) en leverantör. Leverantörer raderas aldrig (inköpsorder pekar på dem). */
export async function setSupplierArchivedFor(
  viewer: Viewer,
  input: { id: string; archived: boolean },
): Promise<void> {
  await asOperator(viewer, async (tx) => {
    const updated = await tx
      .update(s.suppliers)
      .set({ archivedAt: input.archived ? sql`now()` : null })
      .where(
        and(eq(s.suppliers.organizationId, viewer.organization.id), eq(s.suppliers.id, input.id)),
      )
      .returning({ id: s.suppliers.id });
    if (updated.length === 0) throw new PurchasingError("Leverantören finns inte.");
  });
}

// ---------------------------------------------------------------------------
// Leverantörsartiklar
// ---------------------------------------------------------------------------

/** Lägger till eller ändrar en artikel (en titel hos en leverantör). Returnerar id. */
export async function saveSupplierItemFor(
  viewer: Viewer,
  input: SupplierItemInput,
): Promise<string> {
  try {
    return await asOperator(viewer, async (tx) => {
      const values = {
        supplierId: input.supplierId,
        titleId: input.titleId,
        packSize: input.packSize,
        minOrderQty: input.minOrderQty,
        leadTimeDays: input.leadTimeDays,
        unitCostOre: input.unitCostOre,
      };
      if (input.id) {
        const updated = await tx
          .update(s.supplierItems)
          .set(values)
          .where(
            and(
              eq(s.supplierItems.organizationId, viewer.organization.id),
              eq(s.supplierItems.id, input.id),
            ),
          )
          .returning({ id: s.supplierItems.id });
        if (updated.length === 0) throw new PurchasingError("Artikeln finns inte.");
        return updated[0]!.id;
      }
      const [row] = await tx
        .insert(s.supplierItems)
        .values({ organizationId: viewer.organization.id, ...values })
        .returning({ id: s.supplierItems.id });
      return row!.id;
    });
  } catch (error) {
    const pg = pgErrorOf(error);
    if (pg?.code === "23505") {
      throw new PurchasingError("Titeln finns redan hos leverantören. Ändra den raden i stället.");
    }
    if (pg?.code === "23503") throw new PurchasingError("Leverantören eller titeln finns inte.");
    throw error;
  }
}

export async function deleteSupplierItemFor(viewer: Viewer, input: { id: string }): Promise<void> {
  await asOperator(viewer, async (tx) => {
    const deleted = await tx
      .delete(s.supplierItems)
      .where(
        and(
          eq(s.supplierItems.organizationId, viewer.organization.id),
          eq(s.supplierItems.id, input.id),
        ),
      )
      .returning({ id: s.supplierItems.id });
    if (deleted.length === 0) throw new PurchasingError("Artikeln finns inte.");
  });
}

// ---------------------------------------------------------------------------
// Inköpsorder
// ---------------------------------------------------------------------------

/** Läser och låser en inköpsorder (för uppdatering i samma transaktion). */
async function lockOrder(tx: Tx, orgId: string, id: string): Promise<PurchaseOrderRecord> {
  await tx.execute(
    sql`select 1 from public.purchase_orders
        where organization_id = ${orgId}::uuid and id = ${id}::uuid for update`,
  );
  const [order] = await queryPurchaseOrders(tx, orgId, [id]);
  if (!order) throw new PurchasingError("Inköpsordern finns inte.");
  return order;
}

/**
 * Skapar en inköpsorder med rader. `status: 'ordered'` = beställd i dag; väntad leverans
 * blir `expectedOn`, annars i dag + leverantörens ledtid (om den finns).
 */
export async function createPurchaseOrderFor(
  viewer: Viewer,
  input: CreatePurchaseOrderInput,
  now: Date = new Date(),
): Promise<string> {
  const today = todayOf(viewer, now);
  const orgId = viewer.organization.id;
  try {
    return await asOperator(viewer, async (tx) => {
      const [supplier] = await tx
        .select({
          archivedAt: s.suppliers.archivedAt,
          leadTime: s.suppliers.defaultLeadTimeDays,
        })
        .from(s.suppliers)
        .where(and(eq(s.suppliers.organizationId, orgId), eq(s.suppliers.id, input.supplierId)));
      if (!supplier) throw new PurchasingError("Leverantören finns inte.");
      if (supplier.archivedAt) throw new PurchasingError("Leverantören är arkiverad.");
      const ordered = input.status === "ordered";
      const expectedOn =
        input.expectedOn ??
        (ordered && supplier.leadTime !== null ? addDays(today, supplier.leadTime) : null);
      if (expectedOn !== null && expectedOn < today) {
        throw new PurchasingError("Väntad leverans kan inte ligga före i dag.");
      }
      // Varje rad måste vara en artikel hos leverantören, minst minsta order och hela boxar.
      const items = await tx
        .select({
          titleId: s.supplierItems.titleId,
          packSize: s.supplierItems.packSize,
          minOrderQty: s.supplierItems.minOrderQty,
          title: s.titles.name,
        })
        .from(s.supplierItems)
        .innerJoin(
          s.titles,
          and(
            eq(s.titles.organizationId, s.supplierItems.organizationId),
            eq(s.titles.id, s.supplierItems.titleId),
          ),
        )
        .where(
          and(
            eq(s.supplierItems.organizationId, orgId),
            eq(s.supplierItems.supplierId, input.supplierId),
          ),
        );
      const byTitle = new Map(items.map((i) => [i.titleId, i]));
      for (const l of input.lines) {
        const item = byTitle.get(l.titleId);
        if (!item) {
          throw new PurchasingError(
            "En titel på ordern finns inte hos leverantören. Lägg till den som artikel först.",
          );
        }
        if (l.quantity < item.minOrderQty) {
          throw new PurchasingError(
            `${item.title}: minsta order är ${item.minOrderQty} pack, ordern har ${l.quantity}.`,
          );
        }
        if (l.quantity % item.packSize !== 0) {
          throw new PurchasingError(
            `${item.title}: beställ i hela boxar om ${item.packSize} pack (${l.quantity} är inte jämnt delbart).`,
          );
        }
      }
      const [po] = await tx
        .insert(s.purchaseOrders)
        .values({
          organizationId: orgId,
          supplierId: input.supplierId,
          status: input.status,
          orderedOn: ordered ? today : null,
          expectedOn,
          note: input.note,
        })
        .returning({ id: s.purchaseOrders.id });
      await tx.insert(s.purchaseOrderLines).values(
        input.lines.map((l) => ({
          organizationId: orgId,
          purchaseOrderId: po!.id,
          titleId: l.titleId,
          quantity: l.quantity,
          unitCostOre: l.unitCostOre,
        })),
      );
      return po!.id;
    });
  } catch (error) {
    if (pgErrorOf(error)?.code === "23503") throw new PurchasingError("En titel finns inte.");
    throw error;
  }
}

/** Utkast → beställd i dag. */
export async function markPurchaseOrderOrderedFor(
  viewer: Viewer,
  input: { id: string; expectedOn: IsoDate | null },
  now: Date = new Date(),
): Promise<void> {
  const today = todayOf(viewer, now);
  const orgId = viewer.organization.id;
  await asOperator(viewer, async (tx) => {
    const order = await lockOrder(tx, orgId, input.id);
    if (order.status !== "draft") {
      throw new PurchasingError("Bara ett utkast kan markeras som beställt.");
    }
    if (input.expectedOn !== null && input.expectedOn < today) {
      throw new PurchasingError("Väntad leverans kan inte ligga före i dag.");
    }
    await tx
      .update(s.purchaseOrders)
      .set({
        status: "ordered",
        orderedOn: today,
        expectedOn: input.expectedOn ?? order.expectedOn,
      })
      .where(and(eq(s.purchaseOrders.organizationId, orgId), eq(s.purchaseOrders.id, input.id)));
  });
}

/** Avbryter en order som inget tagits emot på. */
export async function cancelPurchaseOrderFor(viewer: Viewer, input: { id: string }): Promise<void> {
  const orgId = viewer.organization.id;
  await asOperator(viewer, async (tx) => {
    const order = await lockOrder(tx, orgId, input.id);
    if (order.status !== "draft" && order.status !== "ordered") {
      throw new PurchasingError(
        order.status === "cancelled"
          ? "Ordern är redan avbruten."
          : "Ordern har tagits emot helt eller delvis och kan inte avbrytas.",
      );
    }
    await tx
      .update(s.purchaseOrders)
      .set({ status: "cancelled" })
      .where(and(eq(s.purchaseOrders.organizationId, orgId), eq(s.purchaseOrders.id, input.id)));
  });
}

export interface CloseResult {
  /** Pack som aldrig kom (beställt − mottaget, summa över raderna). */
  readonly missing: number;
}

/**
 * Avslutar en delvis mottagen order med restorder: det som inte kommit räknas inte längre
 * som beställt. Ordern blir `received` (mottagen) i dag, raderna behåller sitt mottagna
 * antal och anteckningen får en rad om hur mycket som aldrig kom.
 */
export async function closePurchaseOrderFor(
  viewer: Viewer,
  input: { id: string },
  now: Date = new Date(),
): Promise<CloseResult> {
  const today = todayOf(viewer, now);
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    const order = await lockOrder(tx, orgId, input.id);
    if (order.status !== "partially_received") {
      throw new PurchasingError(
        order.status === "ordered"
          ? "Inget har tagits emot på ordern. Avbryt den i stället."
          : order.status === "draft"
            ? "Ett utkast kan inte avslutas. Avbryt det i stället."
            : order.status === "received"
              ? "Ordern är redan mottagen."
              : "Ordern är avbruten.",
      );
    }
    const missing = order.lines.reduce(
      (sum, l) => sum + Math.max(0, l.quantity - l.receivedQuantity),
      0,
    );
    const line = `Avslutad ${today} med restorder: ${missing} pack kom aldrig.`;
    await tx
      .update(s.purchaseOrders)
      .set({
        status: "received",
        receivedOn: today,
        note: order.note ? `${order.note}\n${line}` : line,
      })
      .where(and(eq(s.purchaseOrders.organizationId, orgId), eq(s.purchaseOrders.id, input.id)));
    return { missing };
  });
}

export interface ReceiveResult {
  readonly status: PurchaseOrderStatus;
  /** Pack som togs emot nu (summa över raderna). */
  readonly received: number;
}

/**
 * Tar emot leverans: ökar mottaget antal per rad (högst det som återstår). Databasen
 * skriver en lagerhändelse `receipt` i centrallagret för varje ökning. Ordern blir
 * `received` när allt tagits emot, annars `partially_received`.
 */
export async function receivePurchaseOrderFor(
  viewer: Viewer,
  input: ReceiveInput,
  now: Date = new Date(),
): Promise<ReceiveResult> {
  const today = todayOf(viewer, now);
  const orgId = viewer.organization.id;
  return asOperator(viewer, async (tx) => {
    const order = await lockOrder(tx, orgId, input.id);
    if (order.status === "draft") {
      throw new PurchasingError("Markera ordern som beställd innan leveransen tas emot.");
    }
    if (order.status !== "ordered" && order.status !== "partially_received") {
      throw new PurchasingError(
        order.status === "received" ? "Ordern är redan mottagen." : "Ordern är avbruten.",
      );
    }
    const lines = new Map(order.lines.map((l) => [l.id, l]));
    const seen = new Set<string>();
    let received = 0;
    for (const r of input.lines) {
      const line = lines.get(r.lineId);
      if (!line) throw new PurchasingError("En rad hör inte till ordern.");
      if (seen.has(r.lineId)) throw new PurchasingError("Samma rad står två gånger.");
      seen.add(r.lineId);
      const outstanding = line.quantity - line.receivedQuantity;
      if (r.quantity > outstanding) {
        throw new PurchasingError(
          `Högst ${outstanding} pack återstår på en rad. Ta emot fler som en ny order eller en lagerjustering.`,
        );
      }
      if (r.quantity === 0) continue;
      received += r.quantity;
      await tx
        .update(s.purchaseOrderLines)
        .set({ receivedQuantity: line.receivedQuantity + r.quantity })
        .where(
          and(
            eq(s.purchaseOrderLines.organizationId, orgId),
            eq(s.purchaseOrderLines.id, r.lineId),
          ),
        );
      lines.set(r.lineId, { ...line, receivedQuantity: line.receivedQuantity + r.quantity });
    }
    if (received === 0) throw new PurchasingError("Ange hur många pack som kom.");
    const complete = [...lines.values()].every((l) => l.receivedQuantity >= l.quantity);
    const status: PurchaseOrderStatus = complete ? "received" : "partially_received";
    await tx
      .update(s.purchaseOrders)
      .set({ status, receivedOn: complete ? today : null })
      .where(and(eq(s.purchaseOrders.organizationId, orgId), eq(s.purchaseOrders.id, input.id)));
    return { status, received };
  });
}
