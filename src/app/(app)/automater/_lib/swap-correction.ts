/**
 * "Det var ett produktbyte" på Svinn (byggplanen V2 3.3 punkt 6): ett gammalt byte i ett
 * Awish-fack som synken räknade som svinn (före rättningen i src/server/awish/product-swap.ts).
 * Ägare och admin rättar det med en flytt tillbaka till lagret: transfer_out på automaten och
 * transfer_in i automatens "Fylls på från" (annars standardlagret), med samma grupp-id, daterad
 * en sekund före den senaste räkningen av titeln i automaten. Då stämmer räkningen med väntat
 * saldo och svinnet försvinner. Append-only: inget skrivs om, och samma räkning rättas en gång.
 *
 * Skrivs som användaren under RLS (stock_events_insert tillåter ägare och admin).
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { isUuid, requireRoleFor, withUserDbFor } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { OPERATOR_ROLES } from "@/server/data/core/types";

import type { Viewer } from "./service";

type Row = Record<string, unknown>;

/** Noteringen på rättelsen (känns igen så att samma räkning inte rättas två gånger). */
export const SWAP_CORRECTION_NOTE = "Produktbyte (rättat i efterhand)";

export async function correctProductSwapFor(
  viewer: Viewer,
  input: { machineId: string; titleId: string; quantity: number },
): Promise<ActionResult<{ quantity: number }>> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const quantity = Math.trunc(Number(input.quantity));
  if (!isUuid(input.machineId) || !isUuid(input.titleId)) {
    return { ok: false, error: "Automaten eller titeln finns inte." };
  }
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 10_000) {
    return { ok: false, error: "Ange antal pack, minst 1 och högst 10 000." };
  }
  return withUserDbFor(viewer.user, async (tx) => {
    const exec = async (q: ReturnType<typeof sql>) => Array.from(await tx.execute(q)) as Row[];
    const [loc] = await exec(sql`
      select l.id::text as id,
             coalesce(
               (select s.id from public.stock_locations s
                where s.organization_id = l.organization_id and s.id = l.refill_source_id
                  and s.kind = 'warehouse' and s.archived_at is null),
               (select s.id from public.stock_locations s
                where s.organization_id = l.organization_id and s.kind = 'warehouse'
                  and s.is_central and s.archived_at is null
                limit 1)
             )::text as source_id
      from public.stock_locations l
      where l.organization_id = ${orgId}::uuid and l.machine_id = ${input.machineId}::uuid
        and l.kind = 'machine'`);
    if (!loc) return { ok: false, error: "Automaten finns inte." };
    if (!loc.source_id) return { ok: false, error: "Det finns inget eget lager att flytta till." };
    const [count] = await exec(sql`
      select e.occurred_at as at, e.quantity
      from public.stock_events e
      where e.organization_id = ${orgId}::uuid and e.location_id = ${String(loc.id)}::uuid
        and e.title_id = ${input.titleId}::uuid and e.kind = 'count'
      order by e.occurred_at desc, e.seq desc
      limit 1`);
    if (!count) return { ok: false, error: "Titeln har inte räknats i automaten." };
    const at = new Date(
      (count.at instanceof Date ? count.at : new Date(String(count.at))).getTime() - 1_000,
    ).toISOString();
    const [already] = await exec(sql`
      select 1 as x from public.stock_events e
      where e.organization_id = ${orgId}::uuid and e.location_id = ${String(loc.id)}::uuid
        and e.title_id = ${input.titleId}::uuid and e.kind = 'transfer_out'
        and e.note = ${SWAP_CORRECTION_NOTE} and e.occurred_at = ${at}::timestamptz
      limit 1`);
    if (already) return { ok: false, error: "Den här räkningen är redan rättad." };
    const group = randomUUID();
    await tx.execute(sql`
      insert into public.stock_events
        (organization_id, location_id, title_id, kind, quantity, occurred_at, transfer_group_id, note)
      values
        (${orgId}::uuid, ${String(loc.id)}::uuid, ${input.titleId}::uuid, 'transfer_out',
         ${-quantity}, ${at}::timestamptz, ${group}::uuid, ${SWAP_CORRECTION_NOTE}),
        (${orgId}::uuid, ${String(loc.source_id)}::uuid, ${input.titleId}::uuid, 'transfer_in',
         ${quantity}, ${at}::timestamptz, ${group}::uuid, ${SWAP_CORRECTION_NOTE})`);
    return { ok: true, data: { quantity } };
  });
}
