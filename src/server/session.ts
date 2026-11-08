/**
 * Sessionen i serverkod (serverkomponenter, server actions, route handlers).
 *
 * REGEL: all dataåtkomst på uppdrag av en användare går via `withUserDb()`,
 * som kör som användaren med RLS (claims från den VERIFIERADE sessionen).
 * `getServiceDb()` (kringgår RLS) används bara i systemjobb och skript.
 * Se docs/miljoer.md.
 *
 * Behörigheten kontrolleras i två lager: `requireRole()` här (ger tydliga
 * fel tidigt) och RLS i databasen (det som faktiskt skyddar data).
 */

import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";

import type { Tx } from "@/db/client";
import type { MemberRole } from "@/db/schema";

import {
  requireRoleFor,
  resolveActiveOrganization,
  withUserDbFor,
  type OrganizationMembership,
  type SessionUser,
} from "./access";
import { getAuthProvider } from "./auth";
import { ACTIVE_ORG_COOKIE } from "./auth/flows";
import { nextCookieJar } from "./auth/next-cookies";
import { LOGIN_PATH } from "./auth/paths";
import { guardSimpleView } from "./simple-view-guard";

export { AuthorizationError, type OrganizationMembership, type SessionUser } from "./access";

/** Den inloggade användaren (verifierad), eller null. En gång per förfrågan. */
export const getSessionUser = cache(async (): Promise<SessionUser | null> => {
  const provider = await getAuthProvider();
  return provider.getSession();
});

/** Den inloggade användaren. Skickar annars till inloggningssidan. */
export async function requireUser(): Promise<SessionUser> {
  const user = await getSessionUser();
  if (!user) {
    redirect(LOGIN_PATH);
  }
  return user;
}

/**
 * Kör `fn` i en transaktion som den inloggade användaren, med RLS.
 * Skickar till inloggningssidan om ingen är inloggad.
 */
export async function withUserDb<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const user = await requireUser();
  return withUserDbFor(user, fn);
}

/**
 * Den aktiva organisationen: cookien `bl_org` om användaren är medlem där
 * (kontrolleras under RLS), annars den första. null om användaren saknar
 * medlemskap.
 */
export const getActiveOrganization = cache(async (): Promise<OrganizationMembership | null> => {
  const user = await requireUser();
  const jar = await nextCookieJar();
  const organization = await resolveActiveOrganization(user, jar.get(ACTIVE_ORG_COOKIE));
  // Enkel vy: route handlers och server actions som läser organisationen här (sökningen,
  // assistenten, exporten, filer) spärras som sidorna (@/server/simple-view-guard).
  await guardSimpleView(organization);
  return organization;
});

/**
 * Kräver en av rollerna i organisationen (läst från memberships under RLS).
 * Kastar AuthorizationError("forbidden") annars.
 */
export async function requireRole(
  organizationId: string,
  roles: readonly MemberRole[],
): Promise<{ user: SessionUser; role: MemberRole }> {
  const user = await requireUser();
  const role = await requireRoleFor(user, organizationId, roles);
  return { user, role };
}
