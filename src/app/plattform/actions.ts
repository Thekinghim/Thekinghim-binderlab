"use server";

/**
 * Server actions för /plattform. Bara plattformsoperatörer: savePlanFor kontrollerar det mot
 * databasen före allt annat, och RPC:n platform_save_plan nekar ändå alla andra.
 */

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/server/auth/flows";
import { getSessionUser } from "@/server/session";
import { savePlanFor, type SavePlanInput } from "@/server/subscriptions/service";

/** Ändrar en kunds plan (status, pris, valuta) från ett datum och kundens fakturauppgifter. */
export async function savePlan(input: SavePlanInput): Promise<ActionResult> {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const result = await savePlanFor(await getSessionUser(), {
    organizationId: str(input?.organizationId),
    effectiveFrom: str(input?.effectiveFrom),
    status: str(input?.status),
    price: str(input?.price),
    currency: str(input?.currency),
    trialEndsOn: str(input?.trialEndsOn),
    countryCode: str(input?.countryCode),
    vatNumber: str(input?.vatNumber),
    note: str(input?.note),
  });
  if (result.ok) {
    revalidatePath("/plattform");
    revalidatePath("/installningar");
  }
  return result;
}
