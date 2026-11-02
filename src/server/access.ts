/**
 * Behörighet mot databasen, oberoende av Next (testas i test/db/auth-*.test.ts).
 * src/server/session.ts kopplar ihop funktionerna med den inloggade sessionen.
 *
 * Allt här läser UNDER RLS (withRls), med claims från den verifierade
 * sessionen. Inget läses som databasägare.
 */

import { sql } from "drizzle-orm";

import { withRls, type Tx } from "@/db/client";
import type { MemberRole } from "@/db/schema";

export const MEMBER_ROLES = [
  "owner",
  "admin",
  "refiller",
  "viewer",
] as const satisfies readonly MemberRole[];

/** Den verifierade användaren (från AuthProvider.getSession). */
export interface SessionUser {
  userId: string;
  email: string;
}

export interface OrganizationMembership {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  role: MemberRole;
}

export class AuthorizationError extends Error {
  constructor(
    readonly reason: "unauthenticated" | "forbidden",
    message = reason === "unauthenticated"
      ? "Du är inte inloggad."
      : "Du har inte behörighet till det här.",
  ) {
    super(message);
    this.name = "AuthorizationError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (MEMBER_ROLES as readonly string[]).includes(value);
}

/** Kör fn som användaren, med RLS. All dataåtkomst för användarförfrågningar går hit. */
export function withUserDbFor<T>(user: SessionUser, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withRls({ sub: user.userId, email: user.email }, fn);
}

/** Användarens roll i organisationen (läst under RLS), eller null. */
export async function getRoleFor(
  user: SessionUser,
  organizationId: string,
): Promise<MemberRole | null> {
  if (!isUuid(organizationId)) {
    return null;
  }
  return withUserDbFor(user, async (tx) => {
    const result = await tx.execute(
      sql`select m.role::text as role
          from public.memberships m
          join public.organizations o on o.id = m.organization_id
          where m.organization_id = ${organizationId}::uuid
            and m.user_id = (select auth.uid())
            and o.archived_at is null`,
    );
    const role = (Array.from(result)[0] as { role?: unknown } | undefined)?.role;
    return isMemberRole(role) ? role : null;
  });
}

/**
 * Kastar AuthorizationError("forbidden") om användaren inte har någon av
 * rollerna i organisationen. Returnerar rollen.
 */
export async function requireRoleFor(
  user: SessionUser,
  organizationId: string,
  roles: readonly MemberRole[],
): Promise<MemberRole> {
  if (roles.length === 0) {
    throw new TypeError("requireRole: ange minst en roll.");
  }
  const role = await getRoleFor(user, organizationId);
  if (role === null || !roles.includes(role)) {
    throw new AuthorizationError("forbidden");
  }
  return role;
}

/** Organisationer där användaren är medlem (ej arkiverade), äldsta medlemskapet först. */
export async function listOrganizationsFor(user: SessionUser): Promise<OrganizationMembership[]> {
  return withUserDbFor(user, async (tx) => {
    const result = await tx.execute(
      sql`select o.id, o.name, o.slug::text as slug, o.timezone, m.role::text as role
          from public.memberships m
          join public.organizations o on o.id = m.organization_id
          where m.user_id = (select auth.uid()) and o.archived_at is null
          order by m.created_at, o.name`,
    );
    return Array.from(result).flatMap((row) => {
      const r = row as Record<string, unknown>;
      return isMemberRole(r.role) && typeof r.id === "string"
        ? [
            {
              id: r.id,
              name: String(r.name),
              slug: String(r.slug),
              timezone: String(r.timezone),
              role: r.role,
            },
          ]
        : [];
    });
  });
}

/**
 * Den aktiva organisationen: den i cookien om användaren är medlem där,
 * annars den första. null om användaren inte är medlem någonstans.
 */
export async function resolveActiveOrganization(
  user: SessionUser,
  preferredOrganizationId: string | undefined,
): Promise<OrganizationMembership | null> {
  const organizations = await listOrganizationsFor(user);
  return (
    organizations.find((o) => o.id === preferredOrganizationId?.toLowerCase()) ??
    organizations[0] ??
    null
  );
}
