"use server";

/**
 * Inställningar → Awish: byt Awish-kontots tidszon (UpdateMerchant med bara timezone).
 * Rollen kontrolleras här och i tjänsten mot databasen; organisationen är den aktiva.
 */

import { catalogAction } from "@/server/awish-catalog/action-result";
import { applyTimezoneFor, previewTimezoneFor } from "@/server/awish-catalog/merchant";
import {
  OPERATOR_ROLES,
  requireContextRole,
  requireViewer,
  revalidateAppData,
} from "@/server/data/core";

async function operator() {
  await requireContextRole(OPERATOR_ROLES);
  return requireViewer();
}

export async function previewTimezone() {
  return catalogAction("awish-konto", async () => previewTimezoneFor(await operator()));
}

export async function applyTimezone(raw: unknown) {
  return catalogAction("awish-konto", async () => {
    const r = await applyTimezoneFor(await operator(), raw);
    await revalidateAppData();
    return r;
  });
}
