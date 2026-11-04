"use server";

/**
 * Orderlistans server actions: nästa sida när man scrollar, en orders detaljer och
 * "Markera som testköp" / "Ångra testköp". Rollen kontrolleras här (requireContextRole)
 * och igen i laddarna (requireRoleFor + RLS), så en påfyllare får aldrig en order eller
 * ett belopp. Testköp får bara ägare och admin ändra (även i databasen, set_test_purchase).
 */

import { unstable_rethrow } from "next/navigation";

import {
  ECONOMY_ROLES,
  OPERATOR_ROLES,
  requireContextRole,
  revalidateAppData,
} from "@/server/data/core";
import { AuthorizationError } from "@/server/session";

import { isUuid } from "./_lib/params";
import {
  loadOrderDetailFor,
  loadOrderPageFor,
  setTestPurchaseFor,
  TestPurchaseError,
} from "./_lib/service";
import { currentViewer, listArgsFrom } from "./_lib/session";
import type { OrderDetail, OrderPage, OrderPageStart } from "./_lib/types";

export type ActionResult<T> =
  { readonly ok: true; readonly data: T } | { readonly ok: false; readonly message: string };

const MAX_QUERY = 2000;
const MAX_OFFSET = 10_000_000;

function failure(error: unknown): { ok: false; message: string } {
  if (error instanceof AuthorizationError) {
    return { ok: false, message: "Du har inte behörighet att se order." };
  }
  console.error("[order] action misslyckades", error);
  return { ok: false, message: "Orderna gick inte att hämta." };
}

/**
 * Nästa sida i listan. `query` är listans query-sträng med perioden låst till datum
 * (filter, sökning, sortering), `start` var förra sidan slutade: offset och, i
 * tidsordning, sista radens id.
 */
export async function loadMoreOrders(
  query: string,
  start: OrderPageStart,
): Promise<ActionResult<OrderPage>> {
  try {
    if (typeof query !== "string" || query.length > MAX_QUERY) {
      return { ok: false, message: "Ogiltig förfrågan." };
    }
    const offset = start?.offset;
    if (
      typeof offset !== "number" ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > MAX_OFFSET
    ) {
      return { ok: false, message: "Ogiltig förfrågan." };
    }
    const afterId = isUuid(start.afterId) ? start.afterId : null;
    await requireContextRole(ECONOMY_ROLES);
    const { args } = await listArgsFrom(new URLSearchParams(query));
    const page = await loadOrderPageFor(await currentViewer(), args, { offset, afterId });
    return { ok: true, data: page };
  } catch (error) {
    return failure(error);
  }
}

/** En order med titel, automat, butik, källa och import. data null = finns inte. */
export async function getOrderDetail(orderId: string): Promise<ActionResult<OrderDetail | null>> {
  try {
    if (!isUuid(orderId)) return { ok: true, data: null };
    await requireContextRole(ECONOMY_ROLES);
    return { ok: true, data: await loadOrderDetailFor(await currentViewer(), orderId) };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Markerar ordern som testköp (`test` true) eller ångrar (false). Ett testköp räknas inte
 * i intäkt, vinst, butikens andel, avräkning, bokföring eller rapporter, så hela appen
 * räknas om. Bara ägare och admin.
 */
export async function setTestPurchase(
  orderId: string,
  test: boolean,
): Promise<ActionResult<{ testPurchaseAt: string | null }>> {
  try {
    await requireContextRole(OPERATOR_ROLES);
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthorizationError) {
      return { ok: false, message: "Bara ägare och admin kan markera testköp." };
    }
    throw error;
  }
  if (!isUuid(orderId) || typeof test !== "boolean") {
    return { ok: false, message: "Ogiltig förfrågan." };
  }
  try {
    const data = await setTestPurchaseFor(await currentViewer(), orderId, test);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { ok: false, message: "Bara ägare och admin kan markera testköp." };
    }
    if (error instanceof TestPurchaseError) return { ok: false, message: error.message };
    console.error("[order] testköp misslyckades", error);
    return { ok: false, message: "Det gick inte att spara. Försök igen." };
  }
}
