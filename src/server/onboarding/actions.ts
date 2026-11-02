"use server";

/**
 * Server action för en ny operatör: skapa organisationen och gör den aktiv. Tunt omslag
 * kring ./create-organization.ts, där all validering och behörighet finns.
 */

import { revalidatePath } from "next/cache";

import { getServerEnv } from "@/lib/env";
import { ACTIVE_ORG_COOKIE, activeOrgCookieOptions, type ActionResult } from "@/server/auth/flows";
import { nextCookieJar } from "@/server/auth/next-cookies";
import { getSessionUser } from "@/server/session";

import { createOrganizationFor } from "./create-organization";

export async function createOrganization(input: {
  name: string;
}): Promise<ActionResult<{ organizationId: string }>> {
  const user = await getSessionUser();
  const result = await createOrganizationFor(user, input);
  if (!result.ok || !result.data) return result;
  const jar = await nextCookieJar();
  jar.set(
    ACTIVE_ORG_COOKIE,
    result.data.organizationId,
    activeOrgCookieOptions(getServerEnv().APP_ENV !== "development"),
  );
  revalidatePath("/", "layout");
  return result;
}
