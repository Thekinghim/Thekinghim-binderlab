/**
 * Ekonomin för en enskild order: moms, nettointäkt, inköp, kortavgift och provision.
 *
 * Formler (alla avrundningar: halva öre bort från noll, per order):
 *   moms        = round(belopp × moms_bp / (10 000 + moms_bp))   (beloppet inkluderar momsen)
 *   netto       = belopp − moms
 *   kortavgift  = round(belopp × kortavgift_bp / 10 000)        (på belopp inkl. moms)
 *   provision   = round(netto × provision_bp / 10 000)          (avtalet för orderns butik och dag)
 *   inköp       = inköpspriset som gällde orderns dag, eller null om pris saknas
 *
 * Hyran räknas per butik och månad och fördelas på orderna i rent.ts/ledger.ts.
 */

import { assertIsoDate } from "./dates";
import { DomainError } from "./errors";
import { applyBp, assertBp, assertNonNegativeInteger, mulDivRound, BP_SCALE } from "./money";
import { AgreementIndex, PlacementIndex } from "./placements";
import { PriceIndex } from "./prices";
import type { EconomicsSources, IsoDate, OrderLine, Settings, StoreAgreement } from "./types";

/** Största tillåtna momssats (100 %). */
export const MAX_VAT_RATE_BP = BP_SCALE;

/** Förberedda uppslag för priser, placeringar och avtal. Bygg en gång per beräkning. */
export interface EconomicsContext {
  readonly kind: "economics-context";
  readonly settings: Settings;
  readonly prices: PriceIndex;
  readonly placements: PlacementIndex;
  readonly agreements: AgreementIndex;
}

/** Resultatet för en order. */
export interface OrderEconomics {
  /** Betalt belopp inkl. moms. */
  readonly grossOre: number;
  readonly vatOre: number;
  /** Nettointäkt = belopp − moms. */
  readonly netRevenueOre: number;
  /** Inköpspris som gällde orderns dag, `null` om pris saknas. */
  readonly costOre: number | null;
  /** Från när inköpspriset gällde (för spårbarhet). */
  readonly costValidFrom: IsoDate | null;
  readonly cardFeeOre: number;
  readonly commissionOre: number;
  /** Provisionssatsen som användes (0 om inget avtal eller ingen provision). */
  readonly commissionBp: number;
  /** Butiken där automaten stod orderns dag. */
  readonly storeId: string | null;
  /** Avtalet som gällde i butiken orderns dag. */
  readonly agreement: StoreAgreement | null;
}

/** Kontrollerar inställningarna. */
export function assertSettings(settings: Settings): void {
  if (!settings || typeof settings !== "object") {
    throw new DomainError("invalid_input", "Inställningar saknas.");
  }
  assertBp(settings.vatRateBp, "Momssatsen", MAX_VAT_RATE_BP);
  assertBp(settings.cardFeeBp, "Kortavgiften");
}

/** Kontrollerar en order (giltigt datum, belopp som heltal ≥ 0). */
export function assertOrder(order: OrderLine): void {
  if (!order || typeof order.id !== "string" || order.id === "") {
    throw new DomainError("invalid_input", "Ordern saknar id.");
  }
  if (typeof order.titleId !== "string" || order.titleId === "") {
    throw new DomainError("invalid_input", `Order ${order.externalId ?? order.id} saknar titel.`);
  }
  if (order.machineId !== null && (typeof order.machineId !== "string" || order.machineId === "")) {
    throw new DomainError(
      "invalid_input",
      `Order ${order.externalId ?? order.id} har ogiltig automat.`,
    );
  }
  assertIsoDate(order.businessDate, `Affärsdatum för order ${order.externalId ?? order.id}`);
  assertNonNegativeInteger(order.amountOre, `Beloppet för order ${order.externalId ?? order.id}`);
}

/** Bygger uppslagen och kontrollerar indata (överlapp, dubbletter, ogiltiga värden). */
export function createEconomicsContext(sources: EconomicsSources): EconomicsContext {
  assertSettings(sources.settings);
  return {
    kind: "economics-context",
    settings: sources.settings,
    prices: new PriceIndex(sources.prices),
    placements: new PlacementIndex(sources.placements),
    agreements: new AgreementIndex(sources.agreements),
  };
}

function isContext(x: EconomicsContext | EconomicsSources): x is EconomicsContext {
  return (x as EconomicsContext).kind === "economics-context";
}

/** Moms i ett belopp som inkluderar moms: round(belopp × sats / (10 000 + sats)). */
export function vatOfGross(grossOre: number, vatRateBp: number): number {
  if (vatRateBp === 0) return 0;
  return mulDivRound(grossOre, vatRateBp, BP_SCALE + vatRateBp);
}

/** Intern: räknar utan att kontrollera ordern igen (anroparen har gjort det). */
export function computeOrderEconomics(order: OrderLine, ctx: EconomicsContext): OrderEconomics {
  const { settings } = ctx;
  const gross = order.amountOre;
  const vat = vatOfGross(gross, settings.vatRateBp);
  const net = gross - vat;
  const cardFee = settings.cardFeeBp === 0 ? 0 : applyBp(gross, settings.cardFeeBp);
  const price = ctx.prices.priceOn(order.titleId, order.businessDate);
  const storeId =
    order.machineId === null ? null : ctx.placements.storeOn(order.machineId, order.businessDate);
  const agreement =
    storeId === null ? null : ctx.agreements.agreementOn(storeId, order.businessDate);
  const commissionBp = agreement?.commissionBp ?? 0;
  const commission = commissionBp === 0 ? 0 : applyBp(net, commissionBp);
  return {
    grossOre: gross,
    vatOre: vat,
    netRevenueOre: net,
    costOre: price ? price.unitCostOre : null,
    costValidFrom: price ? price.validFrom : null,
    cardFeeOre: cardFee,
    commissionOre: commission,
    commissionBp,
    storeId,
    agreement,
  };
}

/**
 * Ekonomin för en order: { netRevenueOre, vatOre, costOre | null, cardFeeOre, commissionOre, … }.
 *
 * `ctx` kan vara råa listor (priser, avtal, placeringar, inställningar) eller ett
 * förberett `EconomicsContext` från `createEconomicsContext` (snabbare för många order).
 *
 * Exempel, moms 25 %, kortavgift 2,5 %, provision 10 %, belopp 49,00 kr:
 * moms = round(4900 × 2500 / 12 500) = 980, netto = 3920,
 * kortavgift = round(4900 × 250 / 10 000) = round(122,5) = 123, provision = 392.
 */
export function orderEconomics(
  order: OrderLine,
  ctx: EconomicsContext | EconomicsSources,
): OrderEconomics {
  assertOrder(order);
  const context = isContext(ctx) ? ctx : createEconomicsContext(ctx);
  return computeOrderEconomics(order, context);
}
