"use server";

/**
 * Server actions för Inköpspriser. Tunna omslag: organisationen är alltid den aktiva
 * (läses på servern, aldrig från klienten), rollen kontrolleras mot databasen i
 * addPurchasePriceFor och allt körs under RLS. Ändringen loggas i audit_log av triggern
 * och slår igenom direkt på Hem, Att göra, Lönsamhet och här (revalidateAppData).
 */

import type { ActionResult } from "@/server/auth/flows";
import { loadOptionalContext, revalidateAppData } from "@/server/data/core";
import { getActiveOrganization, getSessionUser } from "@/server/session";

import {
  addPurchasePriceFor,
  correctPurchasePriceFor,
  type AddPriceOutcome,
  type CorrectPriceOutcome,
} from "./_lib/data";
import { PRICE_MESSAGES } from "./_lib/model";

/** Lägger till (eller ersätter samma dag) ett inköpspris för en titel. Ägare och admin. */
export async function addPurchasePrice(input: {
  titleId: string;
  unitCostOre: number;
  validFrom: string;
  note?: string;
}): Promise<ActionResult<AddPriceOutcome>> {
  const organization = await getActiveOrganization();
  if (!organization) return { ok: false, error: PRICE_MESSAGES.forbidden };
  const result = await addPurchasePriceFor(await getSessionUser(), {
    organizationId: organization.id,
    titleId: String(input?.titleId ?? ""),
    unitCostOre: Number(input?.unitCostOre),
    validFrom: String(input?.validFrom ?? ""),
    note: typeof input?.note === "string" ? input.note : undefined,
  });
  if (result.ok) revalidateAppData();
  return result;
}

/**
 * "Rätta priset": priset gäller all försäljning hittills (nuvarande och äldre prisperioder),
 * i en transaktion. Dagens datum läses på servern i organisationens tidszon. Ägare och admin.
 */
export async function correctPurchasePrice(input: {
  titleId: string;
  unitCostOre: number;
  note?: string;
}): Promise<ActionResult<CorrectPriceOutcome>> {
  const ctx = await loadOptionalContext();
  if (!ctx) return { ok: false, error: PRICE_MESSAGES.forbidden };
  const result = await correctPurchasePriceFor(await getSessionUser(), {
    organizationId: ctx.organization.id,
    titleId: String(input?.titleId ?? ""),
    unitCostOre: Number(input?.unitCostOre),
    note: typeof input?.note === "string" ? input.note : undefined,
    today: ctx.today,
  });
  if (result.ok) revalidateAppData();
  return result;
}
