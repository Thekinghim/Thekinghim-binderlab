"use server";

/**
 * Server actions för Datakällor → "Automatisk synk (Chrome-tillägg)". Tunna omslag
 * kring ./manage: indata valideras här (zod), rollen kontrolleras här
 * (requireContextRole) och i ./manage mot databasen, och allt skrivs som användaren
 * med RLS. Alla returnerar { ok, data } eller { ok: false, error } på svenska.
 */

import { unstable_rethrow } from "next/navigation";
import { ZodError } from "zod";

import { AuthorizationError } from "@/server/access";
import { OPERATOR_ROLES, requireContextRole, revalidateAppData } from "@/server/data/core";
import { dbErrorMessage } from "@/server/errors";
import { getActiveOrganization, requireUser } from "@/server/session";

import {
  createExtensionSourceFor,
  createExtensionSourceSchema,
  createSyncTokenFor,
  createTokenSchema,
  ExtensionSetupError,
  revokeSyncTokenFor,
  revokeTokenSchema,
  type CreatedToken,
} from "./manage";

type ActionResult<T = undefined> = { ok: true; data: T } | { ok: false; error: string };

function failure(error: unknown): { ok: false; error: string } {
  unstable_rethrow(error);
  if (error instanceof ZodError) {
    return { ok: false, error: error.issues[0]?.message ?? "Ogiltiga uppgifter." };
  }
  if (error instanceof ExtensionSetupError || error instanceof AuthorizationError) {
    return { ok: false, error: error.message };
  }
  console.error("[tillagg]", error);
  return { ok: false, error: dbErrorMessage(error) };
}

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  const user = await requireUser();
  const organization = await getActiveOrganization();
  if (!organization) {
    throw new AuthorizationError("forbidden", "Du är inte medlem i någon organisation.");
  }
  return { user, organization };
}

/** Ny datakälla av typen Awish-tillägg. */
export async function createExtensionSource(raw: unknown): Promise<ActionResult<{ id: string }>> {
  try {
    const viewer = await operator();
    const input = createExtensionSourceSchema.parse(raw);
    const id = await createExtensionSourceFor(viewer, input);
    revalidateAppData();
    return { ok: true, data: { id } };
  } catch (error) {
    return failure(error);
  }
}

/** Ny synk-token. Token i svaret visas en gång och sparas aldrig. */
export async function createSyncToken(raw: unknown): Promise<ActionResult<CreatedToken>> {
  try {
    const viewer = await operator();
    const input = createTokenSchema.parse(raw);
    const data = await createSyncTokenFor(viewer, input);
    revalidateAppData();
    return { ok: true, data };
  } catch (error) {
    return failure(error);
  }
}

/** Återkallar en synk-token. */
export async function revokeSyncToken(raw: unknown): Promise<ActionResult> {
  try {
    const viewer = await operator();
    const input = revokeTokenSchema.parse(raw);
    await revokeSyncTokenFor(viewer, input);
    revalidateAppData();
    return { ok: true, data: undefined };
  } catch (error) {
    return failure(error);
  }
}
