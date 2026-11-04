/**
 * Antalet konton i organisationen (utan butiksportalens) och väntande inbjudningar, för
 * punkten "Bjud in delägaren" i Att göra (@/analytics/todos/team). Läses under RLS: ägare
 * och admin ser alla medlemskap och inbjudningar i organisationen.
 */

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";

export async function queryTeamSize(
  tx: Tx,
  orgId: string,
): Promise<{ members: number; pendingInvites: number }> {
  const [row] = Array.from(
    await tx.execute(sql`
      select
        (select count(*)::int from public.memberships m
          where m.organization_id = ${orgId}::uuid and m.role <> 'store') as members,
        (select count(*)::int from public.invitations i
          where i.organization_id = ${orgId}::uuid and i.role <> 'store'
            and i.accepted_at is null and i.expires_at > now()) as pending`),
  ) as Array<{ members: number; pending: number }>;
  return { members: Number(row?.members ?? 0), pendingInvites: Number(row?.pending ?? 0) };
}
