"use server";

/**
 * Orderlistans server actions: nästa sida när man scrollar och en orders detaljer.
 * Bara läsning. Rollen kontrolleras här (requireContextRole) och igen i laddarna
 * (requireRoleFor + RLS), så en påfyllare får aldrig en order eller ett belopp.
 */

import { ECONOMY_ROLES, requireContextRole } from "@/server/data/core";
import { AuthorizationError } from "@/server/session";

import { isUuid } from "./_lib/params";
import { loadOrderDetailFor, loadOrderPageFor } from "./_lib/service";
import { currentViewer, listArgsFrom } from "./_lib/session";
import type { OrderDetail, OrderPage } from "./_lib/types";

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
 * Nästa sida i listan. `query` är sidans query-sträng (period, filter, sökning,
 * sortering), `offset` var förra sidan slutade.
 */
export async function loadMoreOrders(
  query: string,
  offset: number,
): Promise<ActionResult<OrderPage>> {
  try {
    if (typeof query !== "string" || query.length > MAX_QUERY) {
      return { ok: false, message: "Ogiltig förfrågan." };
    }
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > MAX_OFFSET) {
      return { ok: false, message: "Ogiltig förfrågan." };
    }
    await requireContextRole(ECONOMY_ROLES);
    const { args } = await listArgsFrom(new URLSearchParams(query));
    const page = await loadOrderPageFor(await currentViewer(), args, offset);
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
