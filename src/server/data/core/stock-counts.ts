/**
 * De egna lagren (aktiva) och när de senast inventerades (stock_counts), för
 * inventeringssidan och punkten "Inventera Hemma" i Att göra (@/analytics/todos/stock-count).
 * Läses under RLS: ägare, admin och läsare ser inventeringarna. Standardlagret först.
 */

import { sql } from "drizzle-orm";

import type { StockCountRef } from "@/analytics/todos";
import type { Tx } from "@/db/client";

export async function queryStockCountRefs(tx: Tx, orgId: string): Promise<StockCountRef[]> {
  const result = await tx.execute(sql`
    select l.id::text as id, l.name, l.created_at,
           (select max(c.counted_at) from public.stock_counts c
             where c.organization_id = l.organization_id and c.location_id = l.id) as last_counted_at
    from public.stock_locations l
    where l.organization_id = ${orgId}::uuid and l.kind = 'warehouse' and l.archived_at is null
    order by l.is_central desc, l.created_at, l.id`);
  return (
    Array.from(result) as {
      id: string;
      name: string;
      created_at: Date | string | null;
      last_counted_at: Date | string | null;
    }[]
  ).map((r) => ({
    placeId: r.id,
    name: r.name,
    lastCountedAt: r.last_counted_at ? new Date(r.last_counted_at).toISOString() : null,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
  }));
}
