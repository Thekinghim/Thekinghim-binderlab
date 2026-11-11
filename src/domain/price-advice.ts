/**
 * Prisråd: produkter som tjänar för lite, och vilket pris som når målet.
 *
 * Marginalen är FÖRE butikernas andel (ägarens regel) och räknas på ett sålt pack med
 * priset i automaten och dagens inköpspris, med samma formler som liggaren (economics.ts):
 *
 *   netto      = pris − moms i priset
 *   kortavgift = pris × kortavgift (bp)
 *   vinst      = netto − kortavgift − inköpspris
 *   marginal   = vinst / netto (bp)
 *
 * Rådet "Höj till X kr" är det lägsta priset över dagens, i hela kronor som slutar på 5
 * eller 9 (295, 299 …), där marginalen når målet. Det är bara ett råd: priset ändras i
 * automatens system, aldrig här. Rena funktioner.
 */

import { vatOfGross } from "./economics";
import { applyBp, ratioBp } from "./money";
import type { IsoDate, Settings } from "./types";

/** Målet när organisationen inte har valt något: 25 %. */
export const DEFAULT_TARGET_MARGIN_BP = 2_500;
/** Målet får vara 1–90 %. */
export const MIN_TARGET_MARGIN_BP = 100;
export const MAX_TARGET_MARGIN_BP = 9_000;
/** Dagar bakåt som "priset i automaten" hämtas ur försäljningen. */
export const PRICE_ADVICE_WINDOW_DAYS = 30;

type FeeSettings = Pick<Settings, "vatRateBp" | "cardFeeBp">;

export interface UnitMargin {
  /** Priset utan moms (öre). */
  readonly netOre: number;
  readonly cardFeeOre: number;
  /** Vinst per pack före butikens andel (öre). */
  readonly profitOre: number;
  /** Vinsten i bp av priset utan moms. null när priset är 0. */
  readonly marginBp: number | null;
}

/** Vinst och marginal för ett sålt pack, före butikens andel. */
export function unitMargin(
  salePriceOre: number,
  unitCostOre: number,
  settings: FeeSettings,
): UnitMargin {
  const netOre = salePriceOre - vatOfGross(salePriceOre, settings.vatRateBp);
  const cardFeeOre = settings.cardFeeBp === 0 ? 0 : applyBp(salePriceOre, settings.cardFeeBp);
  const profitOre = netOre - cardFeeOre - unitCostOre;
  return { netOre, cardFeeOre, profitOre, marginBp: ratioBp(profitOre, netOre) };
}

/** Hela kronor som slutar på 5 eller 9 (prispunkter som 295 och 299). */
export function isPricePoint(kronor: number): boolean {
  const last = ((kronor % 10) + 10) % 10;
  return last === 5 || last === 9;
}

/**
 * Lägsta prispunkt (öre) över `abovePriceOre` där marginalen når målet. null när inget
 * rimligt pris gör det (avgifterna äter upp allt, eller målet är utanför 0–100 %).
 */
export function suggestedPriceOre(
  unitCostOre: number,
  targetBp: number,
  settings: FeeSettings,
  abovePriceOre = 0,
): number | null {
  if (!(targetBp >= 0) || targetBp >= 10_000 || unitCostOre < 0) return null;
  // Ungefärlig undre gräns (flyttal), sedan exakt kontroll med heltalsformlerna.
  const netShare = 10_000 / (10_000 + settings.vatRateBp);
  const keep = netShare * (1 - targetBp / 10_000) - settings.cardFeeBp / 10_000;
  if (!(keep > 0)) return null;
  const roughKronor = Math.floor(unitCostOre / keep / 100) - 2;
  let kronor = Math.max(1, roughKronor, Math.floor(abovePriceOre / 100) + 1);
  for (let i = 0; i < 200; i++, kronor++) {
    if (!isPricePoint(kronor)) continue;
    const ore = kronor * 100;
    if (!Number.isSafeInteger(ore)) return null;
    const m = unitMargin(ore, unitCostOre, settings).marginBp;
    if (m !== null && m >= targetBp) return ore;
  }
  return null;
}

/** En order som underlag för priset i automaten. */
export interface SalePriceOrder {
  readonly titleId: string;
  readonly machineId: string | null;
  readonly businessDate: IsoDate;
  readonly amountOre: number;
  /** Betaltidpunkt (ISO), när den finns: avgör ordningen samma dag. */
  readonly orderedAt?: string;
}

/**
 * Priset i automaten per titel: det senaste betalda köpet (inte gratis-pack) per automat
 * från `since`, och det lägsta av dem när automaterna har olika pris (det är där marginalen
 * är sämst). Titlar utan köp i fönstret saknas (priset är okänt).
 */
export function currentSalePrices(
  orders: readonly SalePriceOrder[],
  since: IsoDate,
): Map<string, number> {
  const latest = new Map<string, { at: string; ore: number; titleId: string }>();
  for (const o of orders) {
    if (o.amountOre <= 0 || o.businessDate < since) continue;
    const key = `${o.titleId}\u0000${o.machineId ?? ""}`;
    const at = `${o.businessDate}|${o.orderedAt ?? ""}`;
    const prev = latest.get(key);
    if (!prev || at >= prev.at) latest.set(key, { at, ore: o.amountOre, titleId: o.titleId });
  }
  const out = new Map<string, number>();
  for (const v of latest.values()) {
    const prev = out.get(v.titleId);
    if (prev === undefined || v.ore < prev) out.set(v.titleId, v.ore);
  }
  return out;
}

export interface PriceAdviceInput {
  /** Titlar som får råd (aktiva). */
  readonly titleIds: readonly string[];
  /** Priset i automaten per titel (öre, med moms), se `currentSalePrices`. */
  readonly salePrices: ReadonlyMap<string, number>;
  /** Dagens inköpspris per titel (öre). */
  readonly costOf: (titleId: string) => number | null | undefined;
  readonly settings: FeeSettings;
  readonly targetBp: number;
}

/** En produkt som tjänar för lite. */
export interface PriceAdvice {
  readonly titleId: string;
  readonly salePriceOre: number;
  readonly unitCostOre: number;
  /** Vinst per pack före butikens andel (öre). */
  readonly profitOre: number;
  readonly marginBp: number;
  /** "Höj till": lägsta prispunkt som når målet, null när ingen gör det. */
  readonly suggestedPriceOre: number | null;
  /** Marginalen med det föreslagna priset. */
  readonly suggestedMarginBp: number | null;
}

/**
 * Produkterna under målet, sämst marginal först. Titlar utan känt pris i automaten eller
 * utan inköpspris hoppas över (de har egna punkter: tyst titel, saknat inköpspris).
 */
export function priceAdvice(input: PriceAdviceInput): PriceAdvice[] {
  const out: PriceAdvice[] = [];
  for (const titleId of new Set(input.titleIds)) {
    const sale = input.salePrices.get(titleId);
    const cost = input.costOf(titleId);
    if (sale === undefined || sale <= 0 || cost === null || cost === undefined) continue;
    const now = unitMargin(sale, cost, input.settings);
    if (now.marginBp === null || now.marginBp >= input.targetBp) continue;
    const suggested = suggestedPriceOre(cost, input.targetBp, input.settings, sale);
    out.push({
      titleId,
      salePriceOre: sale,
      unitCostOre: cost,
      profitOre: now.profitOre,
      marginBp: now.marginBp,
      suggestedPriceOre: suggested,
      suggestedMarginBp:
        suggested === null ? null : unitMargin(suggested, cost, input.settings).marginBp,
    });
  }
  return out.sort((a, b) => a.marginBp - b.marginBp || (a.titleId < b.titleId ? -1 : 1));
}
