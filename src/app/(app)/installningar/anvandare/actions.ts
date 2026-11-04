"use server";

/**
 * Server actions för Inställningar → Användare. Tunna omslag: organisationen
 * är alltid den aktiva (läses på servern, aldrig från klienten), rollen
 * kontrolleras mot databasen i varje flöde och allt körs under RLS.
 * Ändringar loggas i audit_log av triggarna.
 */

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import type { MemberRole } from "@/db/schema";
import { getServerEnv } from "@/lib/env";
import { getAuthProvider } from "@/server/auth";
import { createInviteFlow, type ActionResult } from "@/server/auth/flows";
import { dbErrorMessage } from "@/server/errors";
import { resolveAppBaseUrl } from "@/server/request-info";
import { revalidateAppData } from "@/server/data/core";
import { getActiveOrganization, getSessionUser } from "@/server/session";

import {
  MEMBER_MESSAGES,
  changeMemberRoleFlow,
  findManageableInvitationFor,
  removeMemberFlow,
  revokeInvitationFlow,
} from "./members-data";
import { inviteErrorFor } from "./model";

const PAGE = "/installningar/anvandare";

/** Det allmänna meddelandet för 42501, som dbErrorMessage formulerar det. */
const FORBIDDEN_DB = dbErrorMessage({ code: "42501", severity: "ERROR", message: "" });

async function activeOrganizationId(): Promise<string | null> {
  return (await getActiveOrganization())?.id ?? null;
}

async function sendInvite(
  email: string,
  role: MemberRole,
  password?: string,
): Promise<ActionResult<{ emailSent: boolean }>> {
  const organizationId = await activeOrganizationId();
  if (!organizationId) return { ok: false, error: MEMBER_MESSAGES.forbidden };
  let baseUrl: string;
  try {
    baseUrl = resolveAppBaseUrl(getServerEnv(), await headers());
  } catch {
    return { ok: false, error: "Appens adress (APP_URL) är inte inställd." };
  }
  const result = await createInviteFlow(
    { provider: await getAuthProvider(), user: await getSessionUser(), baseUrl },
    { organizationId, email, role, password },
  );
  return result.ok
    ? result
    : { ok: false, error: inviteErrorFor(role, result.error, FORBIDDEN_DB) };
}

/**
 * Bjuder in en person (mejl med länk till /inbjudan/[token], gäller 7 dagar).
 * Med `password` skapas kontot direkt med det lösenordet (t.ex. åt delägaren),
 * så att personen kan logga in utan mejlet och gå med på ett tryck.
 */
export async function inviteMember(input: {
  email: string;
  role: MemberRole;
  password?: string;
}): Promise<ActionResult<{ emailSent: boolean }>> {
  const password = typeof input?.password === "string" ? input.password : undefined;
  const result = await sendInvite(String(input?.email ?? ""), input?.role, password);
  if (result.ok) revalidatePath(PAGE);
  return result;
}

/** Byter roll. Den egna rollen påverkar hela appen (menyn), annars bara sidan. */
export async function changeMemberRole(input: {
  membershipId: string;
  role: MemberRole;
}): Promise<ActionResult<{ self: boolean }>> {
  const organizationId = await activeOrganizationId();
  const result = await changeMemberRoleFlow(await getSessionUser(), {
    organizationId,
    membershipId: input?.membershipId,
    role: input?.role,
  });
  if (result.ok) {
    if (result.data?.self) revalidateAppData();
    else revalidatePath(PAGE);
  }
  return result;
}

/** Tar bort en medlem. Tar man bort sig själv lämnar man organisationen. */
export async function removeMember(input: {
  membershipId: string;
}): Promise<ActionResult<{ self: boolean }>> {
  const organizationId = await activeOrganizationId();
  const result = await removeMemberFlow(await getSessionUser(), {
    organizationId,
    membershipId: input?.membershipId,
  });
  if (result.ok) {
    if (result.data?.self) revalidateAppData();
    else revalidatePath(PAGE);
  }
  return result;
}

/** Återkallar en obesvarad inbjudan. */
export async function revokeInvitation(input: { invitationId: string }): Promise<ActionResult> {
  const organizationId = await activeOrganizationId();
  const result = await revokeInvitationFlow(await getSessionUser(), {
    organizationId,
    invitationId: input?.invitationId,
  });
  if (result.ok) revalidatePath(PAGE);
  return result;
}

/** Skickar en ny länk. Den gamla slutar gälla (create_invitation löper ut den). */
export async function resendInvitation(input: {
  invitationId: string;
}): Promise<ActionResult<{ emailSent: boolean }>> {
  const organizationId = await activeOrganizationId();
  const found = await findManageableInvitationFor(await getSessionUser(), {
    organizationId,
    invitationId: input?.invitationId,
  });
  if (!found.ok || !found.data) return { ok: false, error: found.error ?? MEMBER_MESSAGES.invalid };
  const result = await sendInvite(found.data.email, found.data.role);
  if (result.ok) revalidatePath(PAGE);
  return result;
}
