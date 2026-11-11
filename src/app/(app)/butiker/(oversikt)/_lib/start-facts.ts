/**
 * Fakta för startlistan per ny butik (storeStartList i ../../_lib/model): villkor,
 * rapportmottagare och butiksportalen per butik, och en automat i drift utan butik som
 * "Placera automat" kan öppna direkt. Läses under RLS som användaren, utan beroende på
 * Next; testas i test/db/r2-t6-startlista-butik.test.ts.
 *
 * Ägare, admin och läsare. Läsaren får inte se medlemskap och inbjudningar: då är `portal`
 * null och den bocken visas inte.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { requireRoleFor, withUserDbFor, type SessionUser } from "@/server/access";
import { ECONOMY_ROLES } from "@/server/data/core/types";

import type { StoreStartFacts } from "../../_lib/model";

export interface StoreStartData {
  /** storeId → fakta, för butiker som inte är arkiverade. */
  readonly facts: Map<string, StoreStartFacts>;
  /** Koden på en automat i drift som inte står i någon butik, eller null. */
  readonly freeMachineCode: string | null;
}

export async function loadStoreStartDataFor(
  user: SessionUser,
  organizationId: string,
): Promise<StoreStartData> {
  const role = await requireRoleFor(user, organizationId, ECONOMY_ROLES);
  const seesPortal = role === "owner" || role === "admin";
  const org = sql`${organizationId}::uuid`;
  return withUserDbFor(user, async (tx) => {
    const rows = Array.from(
      await tx.execute(sql`
        with t as (
          select (now() at time zone o.timezone)::date as today
          from public.organizations o where o.id = ${org}
        )
        select st.id::text as store_id,
               exists (select 1 from public.store_agreements a, t
                        where a.organization_id = st.organization_id and a.store_id = st.id
                          and (a.valid_to is null or a.valid_to >= t.today)) as has_terms,
               (select count(*)::int from public.report_recipients r
                 where r.organization_id = st.organization_id and r.store_id = st.id
                   and r.active) as recipients,
               (select count(*)::int from public.memberships m
                 where m.organization_id = st.organization_id and m.role = 'store'
                   and m.store_id = st.id) as users,
               (select count(*)::int from public.invitations i
                 where i.organization_id = st.organization_id and i.role = 'store'
                   and i.store_id = st.id and i.accepted_at is null
                   and i.expires_at > now()) as pending
        from public.stores st
        where st.organization_id = ${org} and st.archived_at is null`),
    ) as Array<Record<string, unknown>>;
    const free = Array.from(
      await tx.execute(sql`
        with t as (
          select (now() at time zone o.timezone)::date as today
          from public.organizations o where o.id = ${org}
        )
        select m.code
        from public.machines m, t
        where m.organization_id = ${org} and m.archived_at is null
          and (m.active_to is null or m.active_to >= t.today)
          and not exists (
            select 1 from public.machine_placements p
            where p.organization_id = m.organization_id and p.machine_id = m.id
              and (p.valid_to is null or p.valid_to >= t.today))
        order by m.created_at desc, m.code desc
        limit 1`),
    ) as Array<{ code: string }>;
    return {
      facts: new Map(
        rows.map((r) => [
          String(r.store_id),
          {
            hasTerms: r.has_terms === true,
            recipients: Number(r.recipients ?? 0),
            portal: seesPortal
              ? { users: Number(r.users ?? 0), pending: Number(r.pending ?? 0) }
              : null,
          },
        ]),
      ),
      freeMachineCode: free[0]?.code ?? null,
    };
  });
}

/** Som loadStoreStartDataFor, men ett fel stoppar inte sidan: då visas inga startlistor. */
export function loadStoreStartDataSafe(
  user: SessionUser,
  organizationId: string,
): Promise<StoreStartData | null> {
  return loadStoreStartDataFor(user, organizationId).catch((error: unknown) => {
    console.error("[butiker] Startlistan kunde inte läsas:", error);
    return null;
  });
}
