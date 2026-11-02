/**
 * Vem som har tillgång till butiksportalen för en butik: butiksanvändarna
 * (memberships med role = store och butikens store_id) och väntande inbjudningar.
 * För /butiker/[butik], där ägare och admin bjuder in, tar bort och återkallar.
 *
 * Bara ägare och admin (requireRoleFor). E-post läses via list_members (som
 * kräver owner/admin i databasen); medlemskapen och inbjudningarna läses under
 * RLS (memberships_select och invitations_select släpper bara in owner/admin).
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";

import { requireRoleFor, withUserDbFor } from "../access";
import type { SessionUser } from "../session";

export interface StorePortalUser {
  readonly membershipId: string;
  readonly email: string;
  readonly displayName: string | null;
  /** ISO-tid. */
  readonly since: string;
}

export interface StorePortalInvitation {
  readonly invitationId: string;
  readonly email: string;
  /** ISO-tid. */
  readonly invitedAt: string;
  /** ISO-tid. */
  readonly expiresAt: string;
}

export interface StorePortalAccess {
  readonly users: StorePortalUser[];
  readonly invitations: StorePortalInvitation[];
}

const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString();

export async function queryStorePortalAccess(
  tx: Tx,
  organizationId: string,
  storeId: string,
): Promise<StorePortalAccess> {
  const users = Array.from(
    await tx.execute(
      sql`select lm.membership_id, lm.email, lm.display_name, lm.created_at
          from public.list_members(${organizationId}::uuid) lm
          join public.memberships m on m.id = lm.membership_id
          where m.organization_id = ${organizationId}::uuid
            and m.role = 'store'
            and m.store_id = ${storeId}::uuid
          order by lm.created_at, lm.email`,
    ),
  ) as Record<string, unknown>[];
  const invitations = Array.from(
    await tx.execute(
      sql`select i.id, i.email::text as email, i.created_at, i.expires_at
          from public.invitations i
          where i.organization_id = ${organizationId}::uuid
            and i.role = 'store'
            and i.store_id = ${storeId}::uuid
            and i.accepted_at is null
            and i.expires_at > now()
          order by i.created_at desc`,
    ),
  ) as Record<string, unknown>[];
  return {
    users: users.map((r) => ({
      membershipId: String(r.membership_id),
      email: String(r.email),
      displayName: typeof r.display_name === "string" ? r.display_name : null,
      since: iso(r.created_at),
    })),
    invitations: invitations.map((r) => ({
      invitationId: String(r.id),
      email: String(r.email),
      invitedAt: iso(r.created_at),
      expiresAt: iso(r.expires_at),
    })),
  };
}

/** Butikens portaltillgång. Kastar AuthorizationError för andra än ägare och admin. */
export async function loadStorePortalAccessFor(
  user: SessionUser,
  organizationId: string,
  storeId: string,
): Promise<StorePortalAccess> {
  await requireRoleFor(user, organizationId, ["owner", "admin"]);
  return withUserDbFor(user, (tx) => queryStorePortalAccess(tx, organizationId, storeId));
}

/** Tar bort en butiksanvändare (bara role = store för just den butiken). Antal borttagna. */
export async function deleteStorePortalUser(
  tx: Tx,
  input: { organizationId: string; storeId: string; membershipId: string },
): Promise<number> {
  const deleted = Array.from(
    await tx.execute(
      sql`delete from public.memberships
          where id = ${input.membershipId}::uuid
            and organization_id = ${input.organizationId}::uuid
            and role = 'store'
            and store_id = ${input.storeId}::uuid
          returning id`,
    ),
  );
  return deleted.length;
}

/** Återkallar en väntande butiksinbjudan för just den butiken. Antal borttagna. */
export async function deleteStorePortalInvitation(
  tx: Tx,
  input: { organizationId: string; storeId: string; invitationId: string },
): Promise<number> {
  const deleted = Array.from(
    await tx.execute(
      sql`delete from public.invitations
          where id = ${input.invitationId}::uuid
            and organization_id = ${input.organizationId}::uuid
            and role = 'store'
            and store_id = ${input.storeId}::uuid
            and accepted_at is null
          returning id`,
    ),
  );
  return deleted.length;
}
