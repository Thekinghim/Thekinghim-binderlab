"use server";

/**
 * Server actions för Inköpspriser. Tunna omslag: organisationen är alltid den aktiva
 * (läses på servern, aldrig från klienten), rollen kontrolleras mot databasen i
 * addPurchasePriceFor och allt körs under RLS. Ändringen loggas i audit_log av triggern
 * och slår igenom direkt på Hem, Att göra, Lönsamhet och här (revalidateAppData).
 */

import { revalidatePath } from "next/cache";

import type { ActionResult } from "@/server/auth/flows";
import {
  loadDomainInput,
  loadOptionalContext,
  loadPeriod,
  revalidateSettlementData,
} from "@/server/data/core";
import { getActiveOrganization, getSessionUser } from "@/server/session";

import {
  addPurchasePriceFor,
  correctPurchasePriceFor,
  setCustomerPriceFor,
  setOwnProductFor,
  type AddPriceOutcome,
  type CorrectPriceOutcome,
} from "./_lib/data";
import { MAX_UNIT_COST_ORE, PRICE_MESSAGES } from "./_lib/model";
import type { PriceDoubtResult } from "./_lib/price-check";
import { splitWithPrice, type PerOrderSplit } from "./_lib/price-economics";

/** Lägger till (eller ersätter samma dag) ett inköpspris för en titel. Ägare och admin. */
export async function addPurchasePrice(input: {
  titleId: string;
  unitCostOre: number;
  /** Pris mot kund (öre), null = inget. Utelämnat = rör det inte. */
  customerPriceOre?: number | null;
  validFrom: string;
  note?: string;
  /** true = användaren har sett varningen om ett konstigt pris och sparar ändå. */
  confirmed?: boolean;
}): Promise<ActionResult<AddPriceOutcome> | PriceDoubtResult> {
  const organization = await getActiveOrganization();
  if (!organization) return { ok: false, error: PRICE_MESSAGES.forbidden };
  const result = await addPurchasePriceFor(await getSessionUser(), {
    organizationId: organization.id,
    titleId: String(input?.titleId ?? ""),
    unitCostOre: Number(input?.unitCostOre),
    customerPriceOre: customerPriceOf(input?.customerPriceOre),
    validFrom: String(input?.validFrom ?? ""),
    note: typeof input?.note === "string" ? input.note : undefined,
    // Formulären går alltid genom rimlighetskollen (price-check.ts).
    confirmed: input?.confirmed === true,
  });
  if (result.ok) await revalidateSettlementData();
  return result;
}

/**
 * "Rätta priset": priset gäller all försäljning hittills (nuvarande och äldre prisperioder),
 * i en transaktion. Dagens datum läses på servern i organisationens tidszon. Ägare och admin.
 */
export async function correctPurchasePrice(input: {
  titleId: string;
  unitCostOre: number;
  /** Pris mot kund (öre) på perioden som gäller i dag, null = inget. Utelämnat = rör det inte. */
  customerPriceOre?: number | null;
  note?: string;
  /** true = användaren har sett varningen om ett konstigt pris och sparar ändå. */
  confirmed?: boolean;
}): Promise<ActionResult<CorrectPriceOutcome> | PriceDoubtResult> {
  const ctx = await loadOptionalContext();
  if (!ctx) return { ok: false, error: PRICE_MESSAGES.forbidden };
  const result = await correctPurchasePriceFor(await getSessionUser(), {
    organizationId: ctx.organization.id,
    titleId: String(input?.titleId ?? ""),
    unitCostOre: Number(input?.unitCostOre),
    customerPriceOre: customerPriceOf(input?.customerPriceOre),
    note: typeof input?.note === "string" ? input.note : undefined,
    today: ctx.today,
    confirmed: input?.confirmed === true,
  });
  if (result.ok) await revalidateSettlementData();
  return result;
}

/** Klientens pris mot kund: ett tal, null (ta bort) eller utelämnat (rör inte). */
function customerPriceOf(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : Number(value);
}

/**
 * Pris mot kund för titeln, på prisperioden som gäller i dag (null = ta bort). Rör inte
 * inköpspriset. Butikens andel vid vinstdelning räknas på pris mot kund från
 * CUSTOMER_PRICE_SHARE_FROM (src/domain/profit-split.ts), så andelar, avräkningar och vår
 * del läses om som efter ett ändrat inköpspris. Ägare och admin.
 */
export async function setCustomerPrice(input: {
  titleId: string;
  customerPriceOre: number | null;
}): Promise<ActionResult<{ customerPriceOre: number | null }>> {
  const ctx = await loadOptionalContext();
  if (!ctx) return { ok: false, error: PRICE_MESSAGES.forbidden };
  const result = await setCustomerPriceFor(await getSessionUser(), {
    organizationId: ctx.organization.id,
    titleId: String(input?.titleId ?? ""),
    customerPriceOre:
      input?.customerPriceOre === null || input?.customerPriceOre === undefined
        ? null
        : Number(input.customerPriceOre),
    today: ctx.today,
  });
  if (result.ok) {
    revalidatePath("/inkopspriser");
    await revalidateSettlementData();
  }
  return result;
}

/** "Egen produkt" på eller av för en titel (vi packar den själva). Ägare och admin. */
export async function setOwnProduct(input: {
  titleId: string;
  ownProduct: boolean;
}): Promise<ActionResult<{ ownProduct: boolean }>> {
  const organization = await getActiveOrganization();
  if (!organization) return { ok: false, error: PRICE_MESSAGES.forbidden };
  const result = await setOwnProductFor(await getSessionUser(), {
    organizationId: organization.id,
    titleId: String(input?.titleId ?? ""),
    ownProduct: input?.ownProduct === true,
  });
  if (result.ok) await revalidateSettlementData();
  return result;
}

/**
 * Förhandsvisning: kvar per order (före butikens andel, andelen och vår del) för titeln i
 * sidans period och filter om det nya priset gällt all försäljning. Bara läsning; samma
 * titleEconomics som tabellen. `query` är sidans searchParams (period, ?butik=, ?automat=).
 */
export async function previewPriceSplit(input: {
  titleId: string;
  unitCostOre: number;
  query: string;
}): Promise<ActionResult<PerOrderSplit>> {
  const ctx = await loadOptionalContext();
  if (!ctx || !ctx.canEdit) return { ok: false, error: PRICE_MESSAGES.forbidden };
  const unitCostOre = Number(input?.unitCostOre);
  const titleId = String(input?.titleId ?? "");
  if (!Number.isSafeInteger(unitCostOre) || unitCostOre < 0 || unitCostOre > MAX_UNIT_COST_ORE) {
    return { ok: false, error: PRICE_MESSAGES.invalid };
  }
  try {
    const period = await loadPeriod(new URLSearchParams(String(input?.query ?? "")));
    const domain = await loadDomainInput({ period: period.period, ...period.scope });
    if (!domain.titles.some((t) => t.id === titleId)) {
      return { ok: false, error: PRICE_MESSAGES.titleMissing };
    }
    return { ok: true, data: splitWithPrice(domain.current, titleId, unitCostOre) };
  } catch {
    return { ok: false, error: PRICE_MESSAGES.invalid };
  }
}
