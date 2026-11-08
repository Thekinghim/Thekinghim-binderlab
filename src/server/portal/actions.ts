"use server";

/**
 * Server actions för butiksportalen.
 *
 * - reportFault: butiksanvändaren felanmäler en automat i sin butik (blir ett
 *   ärende i incidents, syns i Inkorgen). Kontrolleras i databasen
 *   (portal_report_fault: rollen store för just den butiken, automaten står där i dag).
 * - selectPortalStore: byter visad butik för den som är butiksanvändare i flera.
 * - inviteStoreUser: ägare/admin bjuder in en butiksanvändare från /butiker
 *   (create_store_invitation). Mejlet skickas i samma transaktion som inbjudan
 *   skapas, precis som för vanliga inbjudningar.
 * - removeStoreUser / revokeStoreInvitation: ägare/admin tar bort en
 *   butiksanvändare eller återkallar en väntande inbjudan (från /butiker).
 *   requireTeamManagerFor här, RLS (memberships_delete, invitations_delete) i databasen,
 *   och frågan rör bara role = store för just den butiken.
 *
 * Alla returnerar { ok, error? } med svenska meddelanden. Indata är okontrollerad.
 */

import { cookies, headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { getServerEnv } from "@/lib/env";

import { SIMPLE_VIEW_TEAM_MESSAGE, requireTeamManagerFor, withUserDbFor } from "../access";
import { getAuthProvider } from "../auth";
import { dbErrorMessage, pgErrorOf } from "../errors";
import { createRateLimiter } from "../rate-limit";
import { resolveAppBaseUrl } from "../request-info";
import { getActiveOrganization, getSessionUser, type SessionUser } from "../session";

import { deleteStorePortalInvitation, deleteStorePortalUser } from "./access";
import { FAULT_KINDS } from "./faults";
import { insertPortalFault, insertStoreInvitation, queryPortalStores } from "./queries";
import { PORTAL_STORE_COOKIE } from "./session";

export type PortalActionResult =
  | { ok: true; id?: string }
  | { ok: false; error: string; field?: "machine" | "kind" | "description" | "email" };

const NOT_LOGGED_IN = "Du är inte inloggad. Logga in igen.";
const NO_ACCESS = "Du har inte behörighet till butiken.";

// Per serverinstans: 10 felanmälningar per användare och timme. Databasen har
// en egen gräns (20 per dygn), som gäller oavsett instans.
const globalForLimiter = globalThis as typeof globalThis & {
  __binderlabPortalFaultLimiter?: ReturnType<typeof createRateLimiter>;
};
const faultLimiter = (globalForLimiter.__binderlabPortalFaultLimiter ??= createRateLimiter({
  limit: 10,
  windowMs: 60 * 60 * 1000,
}));

const faultInput = z.object({
  storeId: z.uuid(),
  machineId: z.uuid({ message: "Välj automaten." }),
  kind: z.enum(FAULT_KINDS, { message: "Välj vad som är fel." }),
  description: z.string().trim().max(1000, "Beskrivningen får vara högst 1 000 tecken.").optional(),
});

/** Felanmälan från portalen. */
export async function reportFault(input: {
  storeId: string;
  machineId: string;
  kind: string;
  description?: string;
}): Promise<PortalActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const parsed = faultInput.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path[0];
    return {
      ok: false,
      error: issue?.message ?? "Kontrollera uppgifterna.",
      field:
        path === "machineId"
          ? "machine"
          : path === "kind"
            ? "kind"
            : path === "description"
              ? "description"
              : undefined,
    };
  }
  const { storeId, machineId, kind } = parsed.data;
  const description = parsed.data.description ? parsed.data.description : null;
  if (kind === "store_other" && !description) {
    return { ok: false, error: "Beskriv vad som är fel.", field: "description" };
  }

  const decision = faultLimiter.consume([{ key: `fault:${user.userId}` }]);
  if (!decision.allowed) {
    return {
      ok: false,
      error:
        "Ni har gjort många felanmälningar den senaste timmen. Ring operatören om det är bråttom.",
    };
  }

  try {
    const id = await withUserDbFor(user, (tx) =>
      insertPortalFault(tx, { storeId, machineId, kind, description }),
    );
    revalidatePath("/portal/felanmalan");
    return { ok: true, id };
  } catch (error) {
    const pg = pgErrorOf(error);
    if (pg?.code === "42501") return { ok: false, error: NO_ACCESS };
    if (pg?.code === "22023" && pg.message) {
      return {
        ok: false,
        error: pg.message,
        field: pg.message.startsWith("Automaten") ? "machine" : undefined,
      };
    }
    if (pg?.code === "BL030" && pg.message) return { ok: false, error: pg.message };
    return { ok: false, error: dbErrorMessage(error) };
  }
}

/** Visa en annan av användarens butiker. */
export async function selectPortalStore(storeId: string): Promise<PortalActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const parsed = z.uuid().safeParse(storeId);
  if (!parsed.success) return { ok: false, error: NO_ACCESS };
  const stores = await withUserDbFor(user, queryPortalStores);
  if (!stores.some((s) => s.storeId === parsed.data.toLowerCase())) {
    return { ok: false, error: NO_ACCESS };
  }
  const jar = await cookies();
  jar.set(PORTAL_STORE_COOKIE, parsed.data.toLowerCase(), {
    httpOnly: true,
    sameSite: "lax",
    secure: getServerEnv().APP_ENV !== "development",
    path: "/portal",
    maxAge: 60 * 60 * 24 * 365,
  });
  revalidatePath("/portal", "layout");
  return { ok: true };
}

const inviteInput = z.object({
  storeId: z.uuid(),
  email: z.email({ message: "Ange en e-postadress." }).trim().toLowerCase().max(320),
});

/**
 * Bjud in en butiksanvändare till portalen (från /butiker). Ägare och admin i den
 * aktiva organisationen. Kontrolleras både här (requireTeamManagerFor) och i databasen
 * (create_store_invitation: has_role owner/admin, butiken finns i organisationen).
 */
export async function inviteStoreUser(input: {
  storeId: string;
  email: string;
}): Promise<PortalActionResult> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const parsed = inviteInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: "Ange en giltig e-postadress.", field: "email" };
  }
  const org = await getActiveOrganization();
  if (!org) return { ok: false, error: "Du är inte medlem i någon organisation." };
  // Teamlåset: med Enkel vy bjuds ingen in (databasen nekar också, BL132).
  try {
    await requireTeamManagerFor(user, org.id);
  } catch (error) {
    if (error instanceof Error && error.message === SIMPLE_VIEW_TEAM_MESSAGE) {
      return { ok: false, error: SIMPLE_VIEW_TEAM_MESSAGE };
    }
    return { ok: false, error: "Bara ägare och administratörer kan bjuda in butiker." };
  }
  let baseUrl: string;
  try {
    baseUrl = resolveAppBaseUrl(getServerEnv(), await headers());
  } catch {
    return { ok: false, error: "Appens adress (APP_URL) är inte inställd." };
  }
  const provider = await getAuthProvider();
  try {
    await withUserDbFor(user, async (tx) => {
      const token = await insertStoreInvitation(tx, {
        organizationId: org.id,
        storeId: parsed.data.storeId,
        email: parsed.data.email,
      });
      await provider.sendInvite(parsed.data.email, `${baseUrl}/inbjudan/${token}`);
    });
    revalidatePath("/butiker", "layout");
    return { ok: true };
  } catch (error) {
    const pg = pgErrorOf(error);
    if (pg?.code === "22023" && pg.message) return { ok: false, error: pg.message };
    return {
      ok: false,
      error: pg ? dbErrorMessage(error) : "Inbjudan kunde inte skickas. Försök igen.",
    };
  }
}

const accessInput = z.object({ storeId: z.uuid(), id: z.uuid() });

/** Ägare/admin i den aktiva organisationen, annars ett felmeddelande. */
async function requireStoreManager(): Promise<
  { ok: true; user: SessionUser; orgId: string } | { ok: false; error: string }
> {
  const user = await getSessionUser();
  if (!user) return { ok: false, error: NOT_LOGGED_IN };
  const org = await getActiveOrganization();
  if (!org) return { ok: false, error: "Du är inte medlem i någon organisation." };
  try {
    await requireTeamManagerFor(user, org.id);
  } catch (error) {
    if (error instanceof Error && error.message === SIMPLE_VIEW_TEAM_MESSAGE) {
      return { ok: false, error: SIMPLE_VIEW_TEAM_MESSAGE };
    }
    return { ok: false, error: "Bara ägare och administratörer hanterar butikens portal." };
  }
  return { ok: true, user, orgId: org.id };
}

/** Ta bort en butiksanvändares tillgång till portalen. */
export async function removeStoreUser(input: {
  storeId: string;
  membershipId: string;
}): Promise<PortalActionResult> {
  const parsed = accessInput.safeParse({ storeId: input.storeId, id: input.membershipId });
  if (!parsed.success) return { ok: false, error: "Användaren finns inte längre." };
  const auth = await requireStoreManager();
  if (!auth.ok) return auth;
  try {
    const n = await withUserDbFor(auth.user, (tx) =>
      deleteStorePortalUser(tx, {
        organizationId: auth.orgId,
        storeId: parsed.data.storeId,
        membershipId: parsed.data.id,
      }),
    );
    if (n === 0) return { ok: false, error: "Användaren finns inte längre." };
    revalidatePath("/butiker", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: dbErrorMessage(error) };
  }
}

/** Återkalla en väntande inbjudan till butikens portal. */
export async function revokeStoreInvitation(input: {
  storeId: string;
  invitationId: string;
}): Promise<PortalActionResult> {
  const parsed = accessInput.safeParse({ storeId: input.storeId, id: input.invitationId });
  if (!parsed.success) return { ok: false, error: "Inbjudan finns inte längre." };
  const auth = await requireStoreManager();
  if (!auth.ok) return auth;
  try {
    const n = await withUserDbFor(auth.user, (tx) =>
      deleteStorePortalInvitation(tx, {
        organizationId: auth.orgId,
        storeId: parsed.data.storeId,
        invitationId: parsed.data.id,
      }),
    );
    if (n === 0) return { ok: false, error: "Inbjudan finns inte längre." };
    revalidatePath("/butiker", "layout");
    return { ok: true };
  } catch (error) {
    return { ok: false, error: dbErrorMessage(error) };
  }
}
