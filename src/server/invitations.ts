/**
 * Uppslag av en inbjudan från länken /inbjudan/[token], innan mottagaren har
 * loggat in.
 *
 * UNDANTAG från regeln att användarförfrågningar går via withUserDb: här
 * finns ingen användare ännu, och inbjudningar kan bara läsas av ägare och
 * admin under RLS. Token i länken (32 slumpbyte) är beviset. Uppslaget görs
 * på sha256-hashen, som i accept_invitation, och returnerar så lite som
 * möjligt: e-post, roll och organisationens namn bara för en giltig inbjudan.
 * Själva accepterandet sker alltid som användaren via RPC:n accept_invitation.
 */

import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import type { MemberRole } from "@/db/schema";

export type InvitationLookup =
  | { status: "valid"; email: string; role: MemberRole; organizationName: string }
  | { status: "expired" | "accepted" | "missing" };

const TOKEN = /^[0-9a-f]{64}$/;

export function isInvitationToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN.test(token);
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export async function describeInvitation(
  token: string,
  db: () => Db = getServiceDb,
): Promise<InvitationLookup> {
  if (!isInvitationToken(token)) {
    return { status: "missing" };
  }
  const result = await db().execute(
    sql`select i.email::text as email, i.role::text as role, o.name as organization_name,
               i.accepted_at is not null as accepted, i.expires_at <= now() as expired
        from public.invitations i
        join public.organizations o on o.id = i.organization_id
        where i.token_hash = ${hashInvitationToken(token)} and o.archived_at is null`,
  );
  const row = Array.from(result)[0] as
    | {
        email: string;
        role: MemberRole;
        organization_name: string;
        accepted: boolean;
        expired: boolean;
      }
    | undefined;
  if (!row) {
    return { status: "missing" };
  }
  if (row.accepted) {
    return { status: "accepted" };
  }
  if (row.expired) {
    return { status: "expired" };
  }
  return {
    status: "valid",
    email: row.email,
    role: row.role,
    organizationName: row.organization_name,
  };
}
