"use server";

/**
 * "Kör kontrollen nu" (Inställningar → Kontroll). Ägare och admin; organisationen är den
 * aktiva (läses på servern), rollen kontrolleras mot databasen. Kontrollen läser bara;
 * resultatet sparas och larmen synkas (src/server/self-check).
 */

import type { ActionResult } from "@/server/auth/flows";
import { AuthorizationError } from "@/server/access";
import { revalidateAppData } from "@/server/data/core";
import { runSelfCheckNowFor, SelfCheckBusyError } from "@/server/self-check/service";
import { getActiveOrganization, getSessionUser } from "@/server/session";

export async function runSelfCheckNow(): Promise<
  ActionResult<{ status: string; failed: number; warnings: number }>
> {
  const user = await getSessionUser();
  const organization = await getActiveOrganization();
  if (!user || !organization) {
    return { ok: false, error: "Bara ägare och admin kan köra kontrollen." };
  }
  try {
    const r = await runSelfCheckNowFor({ user, organization });
    revalidateAppData();
    return { ok: true, data: { status: r.status, failed: r.failed, warnings: r.warnings } };
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { ok: false, error: "Bara ägare och admin kan köra kontrollen." };
    }
    if (error instanceof SelfCheckBusyError) return { ok: false, error: error.message };
    console.error("[kontroll] Kör kontrollen nu", error instanceof Error ? error.message : error);
    return { ok: false, error: "Kontrollen kunde inte köras. Försök igen om en stund." };
  }
}
