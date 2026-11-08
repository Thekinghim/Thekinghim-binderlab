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
  latestInvitationIdFor,
  removeMemberFlow,
  revokeInvitationFlow,
  setInvitationOptionsFlow,
  setMemberLocaleFlow,
  setMemberViewFlow,
} from "./members-data";
import { inviteErrorFor } from "./model";

const PAGE = "/installningar/anvandare";

/** Det allmänna meddelandet för 42501, som dbErrorMessage formulerar det. */
const FORBIDDEN_DB = dbErrorMessage({ code: "42501", severity: "ERROR", message: "" });

async function activeOrganizationId(): Promise<string | null> {
  return (await getActiveOrganization())?.id ?? null;
}

type InviteOptions = { viewMode: "full" | "simple"; locale: "sv" | "en" };

/** Inbjudan finns, men valen sparades inte: ägaren ska inte tro att den är enkel/engelsk. */
const INVITE_OPTIONS_FAILED =
  "Inbjudan skickades, men Enkel vy och språket sparades inte. Ändra dem på inbjudan nedan.";

/**
 * Vy och språk på den nya inbjudan (bara när de inte är standard: full vy, svenska).
 * Ett fel tigs aldrig ihjäl: då skulle inbjudan i tysthet ge hela appen.
 */
async function applyInviteOptions(
  organizationId: string,
  email: string,
  options: InviteOptions | undefined,
): Promise<boolean> {
  if (!options || (options.viewMode === "full" && options.locale === "sv")) return true;
  const user = await getSessionUser();
  if (!user) return false;
  const invitationId = await latestInvitationIdFor(user, organizationId, email).catch(() => null);
  if (!invitationId) return false;
  const set = await setInvitationOptionsFlow(user, { organizationId, invitationId, ...options });
  return set.ok;
}

async function sendInvite(
  email: string,
  role: MemberRole,
  password?: string,
  options?: InviteOptions,
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
  if (result.ok && !(await applyInviteOptions(organizationId, email, options))) {
    revalidatePath(PAGE);
    return { ok: false, error: INVITE_OPTIONS_FAILED };
  }
  return result.ok
    ? result
    : { ok: false, error: inviteErrorFor(role, result.error, FORBIDDEN_DB) };
}

function inviteOptionsOf(raw: unknown): InviteOptions | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  return {
    viewMode: r.viewMode === "simple" ? "simple" : "full",
    locale: r.locale === "en" ? "en" : "sv",
  };
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
  /** Enkel vy och språk när inbjudan tas emot (standard: full vy, svenska). */
  viewMode?: "full" | "simple";
  locale?: "sv" | "en";
}): Promise<ActionResult<{ emailSent: boolean }>> {
  const password = typeof input?.password === "string" ? input.password : undefined;
  const result = await sendInvite(
    String(input?.email ?? ""),
    input?.role,
    password,
    inviteOptionsOf(input),
  );
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
  // Den nya länken bär samma vy och språk som den gamla.
  const result = await sendInvite(found.data.email, found.data.role, undefined, {
    viewMode: found.data.viewMode,
    locale: found.data.locale,
  });
  if (result.ok) revalidatePath(PAGE);
  return result;
}

/** Enkel vy på eller av för en medlem (inte den egna). */
export async function setMemberViewMode(input: {
  membershipId: string;
  viewMode: "full" | "simple";
}): Promise<ActionResult<{ viewMode: "full" | "simple" }>> {
  const result = await setMemberViewFlow(await getSessionUser(), {
    organizationId: await activeOrganizationId(),
    membershipId: input?.membershipId,
    viewMode: input?.viewMode,
  });
  if (result.ok) revalidatePath(PAGE);
  return result;
}

/** Språket i appen för en medlem. */
export async function setMemberLocale(input: {
  membershipId: string;
  locale: "sv" | "en";
}): Promise<ActionResult<{ locale: "sv" | "en" }>> {
  const result = await setMemberLocaleFlow(await getSessionUser(), {
    organizationId: await activeOrganizationId(),
    membershipId: input?.membershipId,
    locale: input?.locale,
  });
  if (result.ok) revalidatePath(PAGE);
  return result;
}

/** Vy och språk på en obesvarad inbjudan. */
export async function setInvitationOptions(input: {
  invitationId: string;
  viewMode: "full" | "simple";
  locale: "sv" | "en";
}): Promise<ActionResult> {
  const result = await setInvitationOptionsFlow(await getSessionUser(), {
    organizationId: await activeOrganizationId(),
    invitationId: input?.invitationId,
    viewMode: input?.viewMode,
    locale: input?.locale,
  });
  if (result.ok) revalidatePath(PAGE);
  return result;
}
