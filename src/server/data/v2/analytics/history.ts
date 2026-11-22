/**
 * Automatens historik (Automater → Historik, byggplanen 2.3). Läses som den inloggade (RLS)
 * efter rollkontroll; alla fyra roller får den, och den innehåller inga belopp
 * (./history-model.ts). Demokunder går genom samma vakter som andra laddare.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { withUserDbFor } from "@/server/access";

import type { Viewer } from "../../core/loaders";
import { requireViewerRole } from "../../core/loaders";
import { ALL_ROLES } from "../../core/types";
import { buildHistory, type HistoryEntry } from "./history-model";

type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/** Historiken för en automat, nyast först. Tom lista för en automat som inte finns. */
export async function loadMachineHistoryFor(
  viewer: Viewer,
  machineId: string,
): Promise<HistoryEntry[]> {
  await requireViewerRole(viewer, ALL_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    const exec = async (q: ReturnType<typeof sql>) => Array.from(await tx.execute(q)) as Row[];
    const [fills, counts, swaps, offline, placements] = await Promise.all([
      exec(sql`
        select date_trunc('minute', e.occurred_at) as at, e.performed_by::text as who_id,
               max(p.display_name) as who, sum(e.quantity)::int as packs,
               count(distinct e.title_id)::int as titles
        from public.stock_events e
        join public.stock_locations l
          on l.organization_id = e.organization_id and l.id = e.location_id
        left join public.profiles p
          on p.organization_id = e.organization_id and p.user_id = e.performed_by
        where e.organization_id = ${orgId}::uuid and l.machine_id = ${machineId}::uuid
          and e.kind in ('refill', 'transfer_in')
          and coalesce(e.note, '') not like 'Produktbyte%'
        group by 1, 2
        order by 1 desc
        limit 60`),
      exec(sql`
        select date_trunc('minute', e.occurred_at) as at, count(distinct e.title_id)::int as titles
        from public.stock_events e
        join public.stock_locations l
          on l.organization_id = e.organization_id and l.id = e.location_id
        where e.organization_id = ${orgId}::uuid and l.machine_id = ${machineId}::uuid
          and e.kind = 'count' and e.source is null
        group by 1
        order by 1 desc
        limit 40`),
      exec(sql`
        select w.occurred_at as at, w.channel, f.name as from_name, t.name as to_name,
               w.returned_units, w.taken_units
        from public.product_swaps w
        join public.titles f on f.organization_id = w.organization_id and f.id = w.from_title_id
        join public.titles t on t.organization_id = w.organization_id and t.id = w.to_title_id
        where w.organization_id = ${orgId}::uuid and w.machine_id = ${machineId}::uuid
        order by w.occurred_at desc
        limit 40`),
      exec(sql`
        select a.triggered_at as at, a.message
        from public.alerts a
        where a.organization_id = ${orgId}::uuid and a.machine_id = ${machineId}::uuid
          and a.kind = 'machine_offline'
        order by a.triggered_at desc
        limit 20`),
      exec(sql`
        select p.valid_from::text as valid_from, s.name as store_name
        from public.machine_placements p
        join public.stores s on s.organization_id = p.organization_id and s.id = p.store_id
        where p.organization_id = ${orgId}::uuid and p.machine_id = ${machineId}::uuid
        order by p.valid_from desc
        limit 10`),
    ]);
    return buildHistory({
      fills: fills.map((r) => ({
        at: iso(r.at),
        who: typeof r.who === "string" && r.who.trim() ? r.who.trim() : null,
        packs: int(r.packs),
        titles: int(r.titles),
      })),
      counts: counts.map((r) => ({ at: iso(r.at), titles: int(r.titles) })),
      swaps: swaps.map((r) => ({
        at: iso(r.at),
        channel: String(r.channel ?? ""),
        from: String(r.from_name ?? ""),
        to: String(r.to_name ?? ""),
        returned: int(r.returned_units),
        taken: int(r.taken_units),
      })),
      offline: offline.map((r) => ({
        at: iso(r.at),
        message: typeof r.message === "string" ? r.message : null,
      })),
      placements: placements.map((r) => ({
        from: String(r.valid_from),
        storeName: String(r.store_name ?? ""),
      })),
    });
  });
}
