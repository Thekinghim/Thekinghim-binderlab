"use server";

/**
 * Server actions för Prognos & inköp. Tunna omslag kring src/server/purchasing: indata
 * valideras här (zod), rollen kontrolleras både här (requireContextRole) och i tjänsten
 * mot databasen, och allt skrivs som användaren med RLS.
 *
 * Alla returnerar { ok, data } eller { ok: false, error } med ett svenskt meddelande.
 * Ändringar som påverkar siffror (lager, inköp) räknar om alla sidor sist.
 */

import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import {
  OPERATOR_ROLES,
  requireContextRole,
  revalidateAppData,
  revalidateSettlementData,
} from "@/server/data/core";
import { dbErrorMessage } from "@/server/errors";
import {
  cancelPurchaseOrderFor,
  closePurchaseOrderFor,
  createPurchaseOrderFor,
  createSupplierFor,
  currentViewer,
  deleteSupplierItemFor,
  markPurchaseOrderOrderedFor,
  PurchasingError,
  quickOrderFor,
  quickOrderSchema,
  arrivalSchema,
  receiveArrivalFor,
  receivePurchaseOrderFor,
  saveSupplierItemFor,
  setSupplierArchivedFor,
  updateSupplierFor,
  type ArrivalResult,
  type CloseResult,
  type QuickOrderResult,
  type ReceiveResult,
} from "@/server/purchasing";
import {
  archiveSupplierSchema,
  createPurchaseOrderSchema,
  idSchema,
  markOrderedSchema,
  receiveSchema,
  supplierItemSchema,
  supplierSchema,
  updateSupplierSchema,
} from "@/server/purchasing/schemas";

import type { PriceDoubtResult } from "../inkopspriser/_lib/price-check";
import { withReceiptPrice, type ReceiptPrice } from "../vart-lager/_lib/register";

export type ActionResult<T = void> =
  { ok: true; data: T; error?: undefined } | { ok: false; error: string; data?: undefined };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof PurchasingError || error instanceof AuthorizationError) {
    return { ok: false, error: error.message };
  }
  console.error("[prognos]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return currentViewer();
}

async function run<T>(fn: () => Promise<T>, revalidate = true): Promise<ActionResult<T>> {
  try {
    const data = await fn();
    if (revalidate) revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

export async function createSupplier(raw: unknown): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const viewer = await operator();
    return { id: await createSupplierFor(viewer, supplierSchema.parse(raw)) };
  });
}

export async function updateSupplier(raw: unknown): Promise<ActionResult<void>> {
  return run(async () => {
    const viewer = await operator();
    await updateSupplierFor(viewer, updateSupplierSchema.parse(raw));
  });
}

export async function archiveSupplier(raw: unknown): Promise<ActionResult<void>> {
  return run(async () => {
    const viewer = await operator();
    await setSupplierArchivedFor(viewer, archiveSupplierSchema.parse(raw));
  });
}

export async function saveSupplierItem(raw: unknown): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const viewer = await operator();
    return { id: await saveSupplierItemFor(viewer, supplierItemSchema.parse(raw)) };
  });
}

export async function deleteSupplierItem(raw: unknown): Promise<ActionResult<void>> {
  return run(async () => {
    const viewer = await operator();
    await deleteSupplierItemFor(viewer, idSchema.parse(raw));
  });
}

export async function createPurchaseOrder(raw: unknown): Promise<ActionResult<{ id: string }>> {
  return run(async () => {
    const viewer = await operator();
    return { id: await createPurchaseOrderFor(viewer, createPurchaseOrderSchema.parse(raw)) };
  });
}

export async function markPurchaseOrderOrdered(raw: unknown): Promise<ActionResult<void>> {
  return run(async () => {
    const viewer = await operator();
    await markPurchaseOrderOrderedFor(viewer, markOrderedSchema.parse(raw));
  });
}

export async function cancelPurchaseOrder(raw: unknown): Promise<ActionResult<void>> {
  return run(async () => {
    const viewer = await operator();
    await cancelPurchaseOrderFor(viewer, idSchema.parse(raw));
  });
}

export async function receivePurchaseOrder(raw: unknown): Promise<ActionResult<ReceiveResult>> {
  return run(async () => {
    const viewer = await operator();
    return receivePurchaseOrderFor(viewer, receiveSchema.parse(raw));
  });
}

export async function closePurchaseOrder(raw: unknown): Promise<ActionResult<CloseResult>> {
  return run(async () => {
    const viewer = await operator();
    return closePurchaseOrderFor(viewer, idSchema.parse(raw));
  });
}

// ---------------------------------------------------------------------------
// "Beställt" och "Kom fram" direkt på inköpslistan (utan leverantörsregister)
// ---------------------------------------------------------------------------

/** "Beställt": packen är beställda och väntas om ca 7 dagar. Listan slutar fråga efter dem. */
export async function markOrdered(raw: unknown): Promise<ActionResult<QuickOrderResult>> {
  return run(async () => quickOrderFor(await operator(), quickOrderSchema.parse(raw)));
}

export type ArrivedResult = ArrivalResult & { readonly price: ReceiptPrice };

/**
 * "Kom fram" / "Köpt, har dem här": packen läggs in i lagret (först mot det som var på väg)
 * och, om priset skickas med och är ett annat än dagens, sparas det från i dag. Ser priset
 * konstigt ut sparas ingenting förrän användaren bekräftat (svaret har då `doubt`).
 */
export async function markArrived(
  raw: unknown,
): Promise<ActionResult<ArrivedResult> | PriceDoubtResult> {
  try {
    const viewer = await operator();
    const input = arrivalSchema.parse(raw);
    const data = await withReceiptPrice(viewer, input, new Date(), () =>
      receiveArrivalFor(viewer, input),
    );
    if ("doubt" in data) return data;
    if (data.price.status === "saved") await revalidateSettlementData();
    else revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}
