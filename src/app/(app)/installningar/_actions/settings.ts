"use server";

/**
 * Server actions för Inställningar. Organisationen är alltid den aktiva (läses på servern),
 * rollen kontrolleras mot databasen i data-funktionerna och allt körs under RLS. Ändringar
 * loggas i audit_log av triggarna och slår igenom direkt i hela appen (revalidateAppData):
 * kortavgift och moms ändrar intäkt och vinst på Hem, Lönsamhet och i rapporterna.
 */

import type { ActionResult } from "@/server/auth/flows";
import { revalidateAppData } from "@/server/data/core";
import { businessToday } from "@/server/data/core/loaders";
import { getActiveOrganization, getSessionUser } from "@/server/session";

import {
  saveOwnerSharesFor,
  setVatAcknowledgedFor,
  updateCompanyDetailsFor,
  updateSettingsFor,
} from "../_lib/data";
import { SETTINGS_MESSAGES } from "../_lib/model";

/** Sparar kortavgift, momssats och räkenskapsårets första månad. Ägare och admin. */
export async function updateSettings(input: {
  cardFeeBp: number;
  vatRateBp: number;
  fiscalYearStartMonth: number;
  vatLimitOre?: number;
}): Promise<ActionResult<{ changed: boolean }>> {
  const organization = await getActiveOrganization();
  if (!organization) return { ok: false, error: SETTINGS_MESSAGES.forbidden };
  const result = await updateSettingsFor(await getSessionUser(), {
    organizationId: organization.id,
    cardFeeBp: Number(input?.cardFeeBp),
    vatRateBp: Number(input?.vatRateBp),
    fiscalYearStartMonth: Number(input?.fiscalYearStartMonth),
    ...(input?.vatLimitOre === undefined ? {} : { vatLimitOre: Number(input.vatLimitOre) }),
  });
  if (result.ok && result.data?.changed) revalidateAppData();
  return result;
}

/** "Revisorn har koll" (true) eller "Varna igen" (false) för momsgränsen. Ägare och admin. */
export async function setVatAcknowledged(
  acknowledged: boolean,
): Promise<ActionResult<{ changed: boolean }>> {
  const organization = await getActiveOrganization();
  if (!organization) return { ok: false, error: SETTINGS_MESSAGES.forbidden };
  const result = await setVatAcknowledgedFor(await getSessionUser(), {
    organizationId: organization.id,
    acknowledged: acknowledged === true,
    today: businessToday(new Date(), organization.timezone),
  });
  if (result.ok && result.data?.changed) revalidateAppData();
  return result;
}

/** Företagsuppgifterna som står i kontrakten (namn, org.nr, adress, kontakt). Ägare och admin. */
export async function updateCompanyDetails(input: {
  companyName: string;
  orgNumber: string;
  companyAddress: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string;
}): Promise<ActionResult<{ changed: boolean }>> {
  const organization = await getActiveOrganization();
  if (!organization) return { ok: false, error: SETTINGS_MESSAGES.forbidden };
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const result = await updateCompanyDetailsFor(await getSessionUser(), {
    organizationId: organization.id,
    companyName: str(input?.companyName),
    orgNumber: str(input?.orgNumber),
    companyAddress: str(input?.companyAddress),
    contactName: str(input?.contactName),
    contactEmail: str(input?.contactEmail),
    contactPhone: str(input?.contactPhone),
  });
  if (result.ok && result.data?.changed) revalidateAppData();
  return result;
}

/** Ny fördelning av ägarandelar från ett datum. Bara ägaren. */
export async function saveOwnerShares(input: {
  validFrom: string;
  shares: Array<{ holderName: string; shareBp: number; memberUserId?: string | null }>;
}): Promise<ActionResult<{ validFrom: string }>> {
  const organization = await getActiveOrganization();
  if (!organization) return { ok: false, error: SETTINGS_MESSAGES.ownerOnly };
  const shares = Array.isArray(input?.shares) ? input.shares : [];
  const result = await saveOwnerSharesFor(await getSessionUser(), {
    organizationId: organization.id,
    validFrom: String(input?.validFrom ?? ""),
    shares: shares.map((s) => ({
      holderName: String(s?.holderName ?? ""),
      shareBp: Number(s?.shareBp),
      memberUserId: typeof s?.memberUserId === "string" && s.memberUserId ? s.memberUserId : null,
    })),
  });
  if (result.ok) revalidateAppData();
  return result;
}
