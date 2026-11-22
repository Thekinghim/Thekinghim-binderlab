/**
 * Vårt lager i V2: det sidan läser utöver Vårt lagers laddare (./data.ts). Som användaren
 * (RLS), samma roller som sidan.
 *
 * - Senaste händelser: de senaste 300 händelserna (inte försäljning) i aktiva egna lager de
 *   senaste 60 dagarna, med titel och lager (./v2-model.ts slår ihop dem).
 * - Senast räknat: senaste inventeringen per eget lager (stock_events kind = 'count').
 */

import "server-only";

import { sql } from "drizzle-orm";

import { withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";

import type { StockEventRow } from "./v2-model";

export interface VartLagerExtras {
  readonly events: StockEventRow[];
  /** Lagrets id → senaste inventering (ISO), eller saknas. */
  readonly lastCounted: Readonly<Record<string, string>>;
}

export async function loadVartLagerExtrasFor(viewer: Viewer): Promise<VartLagerExtras> {
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    const events = Array.from(
      await tx.execute(sql`
        select e.kind::text as kind, e.quantity, e.occurred_at, e.note,
               t.name as title_name, l.name as place_name,
               (select o.name from public.stock_events x
                join public.stock_locations o
                  on o.organization_id = x.organization_id and o.id = x.location_id
                where x.organization_id = e.organization_id
                  and x.transfer_group_id = e.transfer_group_id
                  and x.location_id <> e.location_id
                limit 1) as counterpart
        from public.stock_events e
        join public.stock_locations l
          on l.organization_id = e.organization_id and l.id = e.location_id
        join public.titles t on t.organization_id = e.organization_id and t.id = e.title_id
        where e.organization_id = ${orgId}::uuid and l.kind = 'warehouse'
          and l.archived_at is null and e.kind <> 'sale'
          and e.occurred_at > now() - interval '60 days'
        order by e.occurred_at desc, e.seq desc
        limit 300`),
    ) as {
      kind: string;
      quantity: number;
      occurred_at: Date | string;
      note: string | null;
      title_name: string;
      place_name: string;
      counterpart: string | null;
    }[];
    const counted = Array.from(
      await tx.execute(sql`
        select e.location_id::text as id, max(e.occurred_at) as at
        from public.stock_events e
        join public.stock_locations l
          on l.organization_id = e.organization_id and l.id = e.location_id
        where e.organization_id = ${orgId}::uuid and l.kind = 'warehouse'
          and l.archived_at is null and e.kind = 'count'
        group by e.location_id`),
    ) as { id: string; at: Date | string }[];
    return {
      events: events.map((r) => ({
        kind: r.kind,
        quantity: Number(r.quantity),
        occurredAt: new Date(r.occurred_at).toISOString(),
        note: r.note,
        titleName: r.title_name,
        placeName: r.place_name,
        counterpart: r.counterpart,
      })),
      lastCounted: Object.fromEntries(counted.map((r) => [r.id, new Date(r.at).toISOString()])),
    };
  });
}
