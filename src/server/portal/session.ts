/**
 * Butiksportalens session: vilken butik den inloggade får se.
 *
 * Behörigheten avgörs i databasen (portal_stores och private.portal_store_org i
 * varje portal_*-funktion). Här väljs bara vilken av användarens butiker som visas
 * (cookien bl_portal_store, annars den första) och vart den som inte är
 * butiksanvändare skickas.
 */

import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import { listOrganizationsFor, withUserDbFor } from "../access";
import { getSessionUser, requireUser, type SessionUser } from "../session";

import type { PortalStore } from "./model";
import { queryPortalStores } from "./queries";

export const PORTAL_STORE_COOKIE = "bl_portal_store";

/** Butikerna där den inloggade är butiksanvändare (en gång per förfrågan). */
export const getPortalStores = cache(async (): Promise<PortalStore[]> => {
  const user = await requireUser();
  return withUserDbFor(user, queryPortalStores);
});

export interface PortalContext {
  user: SessionUser;
  store: PortalStore;
  stores: PortalStore[];
}

/**
 * Den valda butiken för den inloggade butiksanvändaren, eller null om
 * användaren inte är butiksanvändare någonstans. Utan inloggning: till /logga-in.
 */
export const getPortalContext = cache(async (): Promise<PortalContext | null> => {
  const user = await requireUser();
  const stores = await getPortalStores();
  if (stores.length === 0) return null;
  const jar = await cookies();
  const preferred = jar.get(PORTAL_STORE_COOKIE)?.value?.toLowerCase();
  const store = stores.find((s) => s.storeId === preferred) ?? stores[0]!;
  return { user, store, stores };
});

/**
 * Kräver en butik. Den som är medlem i appen men inte butiksanvändare skickas
 * till appen; den som saknar både och får portalens tomma läge (layouten).
 */
export async function requirePortalContext(): Promise<PortalContext> {
  const ctx = await getPortalContext();
  if (ctx) return ctx;
  const user = await requireUser();
  if ((await listOrganizationsFor(user)).length > 0) redirect("/");
  redirect("/portal/ingen-butik");
}

/**
 * För appens layout (src/app/(app)/layout.tsx): en inloggad användare som BARA är
 * butiksanvändare (inget medlemskap med en approll) skickas till /portal i stället
 * för att få "Inget medlemskap". Anropas där layouten annars visar NoOrganization.
 * Behörigheten hänger inte på det här: appens laddare och RLS släpper aldrig in
 * rollen store.
 */
export async function redirectStoreUserToPortal(): Promise<void> {
  const user = await getSessionUser();
  if (!user) return;
  const stores = await withUserDbFor(user, queryPortalStores);
  if (stores.length > 0 && (await listOrganizationsFor(user)).length === 0) {
    redirect("/portal");
  }
}
