"use server";

/**
 * Server actions för Inställningar → Demo för kunder. Organisationen är alltid den aktiva
 * (läses på servern, aldrig från klienten). Varje flöde kontrollerar att användaren är
 * ägare i en riktig (inte demo) organisation, se src/server/demo/customer-demos.ts.
 */

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { getServerEnv } from "@/lib/env";
import { getAuthProvider } from "@/server/auth";
import type { ActionResult } from "@/server/auth/flows";
import {
  continueCustomerDemoFor,
  createCustomerDemoFor,
  CUSTOMER_DEMO_MESSAGES,
  deleteCustomerDemoFor,
  resendCustomerDemoInviteFor,
  resetCustomerDemoFor,
  type CustomerDemoDeps,
  type CustomerDemoProgress,
} from "@/server/demo/customer-demos";
import { resolveAppBaseUrl } from "@/server/request-info";
import { getActiveOrganization, getSessionUser } from "@/server/session";

import { systemImportFileStore } from "../../datakallor/_lib/file-store";

const PAGE = "/installningar";

async function context() {
  const [user, organization] = await Promise.all([getSessionUser(), getActiveOrganization()]);
  return { user, organizationId: organization?.id ?? null };
}

async function deps(): Promise<CustomerDemoDeps | null> {
  const provider = await getAuthProvider();
  if (!provider.createSystemUser || !provider.deleteUser) return null;
  let baseUrl: string;
  try {
    baseUrl = resolveAppBaseUrl(getServerEnv(), await headers());
  } catch {
    return null;
  }
  const createSystemUser = provider.createSystemUser.bind(provider);
  const deleteUser = provider.deleteUser.bind(provider);
  return {
    users: { createSystemUser, deleteUser },
    sendInvite: (email, url) => provider.sendInvite(email, url),
    baseUrl,
    fileStore: systemImportFileStore(),
  };
}

/** Skapar kontona och demoorganisationen. Datan byggs med continueCustomerDemo. */
export async function createCustomerDemo(input: {
  email: string;
}): Promise<ActionResult<CustomerDemoProgress>> {
  const { user, organizationId } = await context();
  const d = await deps();
  if (!d) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.unavailable };
  const result = await createCustomerDemoFor(user, d, { organizationId, email: input?.email });
  if (result.ok) revalidatePath(PAGE);
  return result;
}

/** Bygger demon vidare (högst ca 90 s per anrop). Sidan anropar tills den är klar. */
export async function continueCustomerDemo(input: {
  demoId: string;
}): Promise<ActionResult<CustomerDemoProgress>> {
  const { user, organizationId } = await context();
  const d = await deps();
  if (!d) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.unavailable };
  const result = await continueCustomerDemoFor(user, d, { organizationId, demoId: input?.demoId });
  if (result.ok && result.data?.status === "ready") revalidatePath(PAGE);
  return result;
}

/** Ny inbjudan till kunden (den gamla länken slutar gälla). */
export async function resendCustomerDemoInvite(input: {
  demoId: string;
}): Promise<ActionResult<{ emailSent: boolean }>> {
  const { user, organizationId } = await context();
  const d = await deps();
  if (!d) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.unavailable };
  const result = await resendCustomerDemoInviteFor(user, d, {
    organizationId,
    demoId: input?.demoId,
  });
  if (result.ok) revalidatePath(PAGE);
  return result;
}

/** Ny demo med färsk data; kunden är kvar. Datan byggs med continueCustomerDemo. */
export async function resetCustomerDemo(input: {
  demoId: string;
}): Promise<ActionResult<CustomerDemoProgress>> {
  const { user, organizationId } = await context();
  const d = await deps();
  if (!d) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.unavailable };
  const result = await resetCustomerDemoFor(user, d, { organizationId, demoId: input?.demoId });
  if (result.ok) revalidatePath(PAGE);
  return result;
}

/** Tar bort demon, dess konton och kundens demokonto. */
export async function deleteCustomerDemo(input: { demoId: string }): Promise<ActionResult> {
  const { user, organizationId } = await context();
  const d = await deps();
  if (!d) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.unavailable };
  const result = await deleteCustomerDemoFor(user, d, { organizationId, demoId: input?.demoId });
  if (result.ok) revalidatePath(PAGE);
  return result;
}
