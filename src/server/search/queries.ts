/**
 * Frågorna bakom sökningen. Varje funktion tar en transaktion som redan kör som
 * användaren (withUserDbFor, alltså med RLS) och organisationens id. Rollen
 * kontrolleras i ./service innan orderfrågorna körs; RLS är det andra lagret
 * (policyn orders_select släpper inte igenom påfyllaren).
 *
 * Ordersökningen går via private.search_orders, som använder trigramindexen
 * orders_external_id_trgm_idx och orders_raw_title_trgm_idx för ovanliga sökord och
 * orders_ordered_at_idx för vanliga (nyaste först, LIMIT).
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";

import type { OrderSearchRow, OrderTerm } from "./model";

function toRow(r: Record<string, unknown>): OrderSearchRow & { exact: boolean } {
  return {
    id: String(r.id),
    externalId: String(r.external_id),
    orderedAt: new Date(r.ordered_at as string | Date).toISOString(),
    amountOre: Number(r.amount_ore),
    rawTitle: String(r.raw_title),
    titleId: r.title_id === null || r.title_id === undefined ? null : String(r.title_id),
    machineId: r.machine_id === null || r.machine_id === undefined ? null : String(r.machine_id),
    exact: r.exact === true,
  };
}

/**
 * Ordern som matchar sökorden, nyaste först (högst `limit`), och de vars ordernummer
 * är exakt `exact` (högst tre). Via private.search_orders, som kontrollerar rollen
 * (ägare, admin, läsare) och kör frågan med ett enda organisationsvillkor så att
 * planeraren väljer trigramindexet (se migreringen 20261102165100_sok_search_orders.sql).
 */
export async function querySearchOrders(
  tx: Tx,
  orgId: string,
  terms: readonly OrderTerm[],
  exact: string | null,
  limit: number,
): Promise<{ exact: OrderSearchRow[]; recent: OrderSearchRow[] }> {
  const payload = terms.map((t) => ({
    pattern: t.pattern,
    title_ids: t.titleIds,
    machine_ids: t.machineIds,
  }));
  const result = await tx.execute(
    sql`select * from private.search_orders(${orgId}::uuid, ${JSON.stringify(payload)}::jsonb,
          ${exact}::text, ${limit}::int)`,
  );
  const rows = Array.from(result).map((r) => toRow(r as Record<string, unknown>));
  const strip = ({ exact: _exact, ...row }: OrderSearchRow & { exact: boolean }) => row;
  return {
    exact: rows.filter((r) => r.exact).map(strip),
    recent: rows.filter((r) => !r.exact).map(strip),
  };
}

/** Titelns alias (originalstavningar), per titel. Få rader. */
export async function queryAliases(tx: Tx, orgId: string): Promise<Map<string, string[]>> {
  const result = await tx.execute(
    sql`select a.title_id, a.alias from public.title_aliases a
        where a.organization_id = ${orgId}::uuid
        order by a.alias`,
  );
  const out = new Map<string, string[]>();
  for (const row of Array.from(result)) {
    const r = row as { title_id: string; alias: string };
    const list = out.get(r.title_id) ?? [];
    list.push(r.alias);
    out.set(r.title_id, list);
  }
  return out;
}

/** Pack per titel i automatens lagerplats (vyn stock_levels). Inga belopp. */
export async function queryMachineStock(
  tx: Tx,
  orgId: string,
  machineId: string,
): Promise<Map<string, number>> {
  const result = await tx.execute(
    sql`select sl.title_id, sum(sl.quantity)::int as quantity
        from public.stock_levels sl
        join public.stock_locations loc
          on loc.organization_id = sl.organization_id and loc.id = sl.location_id
        where sl.organization_id = ${orgId}::uuid
          and loc.machine_id = ${machineId}::uuid
          and loc.archived_at is null
        group by sl.title_id`,
  );
  return new Map(
    Array.from(result).map((row) => {
      const r = row as { title_id: string; quantity: number };
      return [r.title_id, Number(r.quantity)] as const;
    }),
  );
}

/** Titlar som har minst ett inköpspris. */
export async function queryPricedTitles(tx: Tx, orgId: string): Promise<Set<string>> {
  const result = await tx.execute(
    sql`select distinct p.title_id from public.purchase_prices p
        where p.organization_id = ${orgId}::uuid`,
  );
  return new Set(Array.from(result).map((r) => String((r as { title_id: string }).title_id)));
}
