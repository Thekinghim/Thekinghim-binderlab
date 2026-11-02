/**
 * Nyckeltal: intäkt, antal order, snittorder, marginal, förändring mot föregående period,
 * samt bekväma sammandrag (inköp med täckning, butiksersättning, vinst).
 *
 * Funktionerna som tar `orders` filtrerar inte på period; skicka in de order som ska räknas.
 */

import { assertOrder, assertSettings, vatOfGross } from "./economics";
import { buildLedger } from "./ledger";
import { applyBp, checkSafe, mulDivRound, ratioBp, roundHalfUp, BP_SCALE } from "./money";
import { summarizeLedger, type ProfitabilityResult } from "./profitability";
import type { OrderLine, ProfitabilityInput, Settings } from "./types";

/** Betalt belopp inkl. moms, i öre. */
export function grossRevenue(orders: readonly OrderLine[]): number {
  let sum = 0;
  for (const o of orders) {
    assertOrder(o);
    sum += o.amountOre;
  }
  return checkSafe(sum, "Intäkten");
}

/** Moms i orderna: Σ round(belopp × moms / (10 000 + moms)), per order. */
export function vat(orders: readonly OrderLine[], settings: Settings): number {
  assertSettings(settings);
  let sum = 0;
  for (const o of orders) {
    assertOrder(o);
    sum += vatOfGross(o.amountOre, settings.vatRateBp);
  }
  return checkSafe(sum, "Momsen");
}

/** Nettointäkt (exkl. moms) i öre: Σ (belopp − moms), med momsen avrundad per order. */
export function revenue(orders: readonly OrderLine[], settings: Settings): number {
  assertSettings(settings);
  let sum = 0;
  for (const o of orders) {
    assertOrder(o);
    sum += o.amountOre - vatOfGross(o.amountOre, settings.vatRateBp);
  }
  return checkSafe(sum, "Intäkten");
}

/** Kortavgifter: Σ round(belopp inkl. moms × kortavgift / 10 000), per order. */
export function cardFees(orders: readonly OrderLine[], settings: Settings): number {
  assertSettings(settings);
  if (settings.cardFeeBp === 0) return 0;
  let sum = 0;
  for (const o of orders) {
    assertOrder(o);
    sum += applyBp(o.amountOre, settings.cardFeeBp);
  }
  return checkSafe(sum, "Kortavgifterna");
}

/** Antal order (= antal pack, eftersom varje order är ett pack). */
export function orderCount(orders: readonly OrderLine[]): number {
  return orders.length;
}

/** Snittorder: round(nettointäkt / antal order). `null` när det inte finns några order. */
export function averageOrderValueOre(
  orders: readonly OrderLine[],
  settings: Settings,
): number | null {
  if (orders.length === 0) return null;
  return roundHalfUp(revenue(orders, settings), orders.length);
}

/** Marginal i bp: round(vinst × 10 000 / intäkt). `null` när intäkten är 0. */
export function marginBp(profitOre: number, revenueOre: number): number | null {
  return ratioBp(profitOre, revenueOre);
}

/**
 * Förändring mot föregående period i bp: round((nu − före) × 10 000 / |före|).
 * `null` när föregående värde är 0 (förändringen är då inte definierad).
 */
export function changeBp(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return mulDivRound(current - previous, BP_SCALE, Math.abs(previous));
}

/** Nyckeltal för en period. */
export interface KeyMetrics {
  /** Nettointäkt, alla order. */
  readonly revenueOre: number;
  readonly orderCount: number;
  /** Snittorder (netto), `null` utan order. */
  readonly averageOrderValueOre: number | null;
  /** Vinst för prissatta order (order utan pris ingår inte). */
  readonly profitOre: number;
  /** Marginal för prissatta order. */
  readonly marginBp: number | null;
  /** Andel av intäkten som saknar inköpspris, i bp. */
  readonly unpricedShareBp: number;
}

/** Nyckeltal för perioden i ett anrop (för Hem). */
export function keyMetrics(input: ProfitabilityInput): KeyMetrics {
  const r = summarizeLedger(buildLedger(input), "title");
  const t = r.totals;
  const revenueAll = t.revenueOre + t.unpricedRevenueOre;
  return {
    revenueOre: revenueAll,
    orderCount: t.orders,
    averageOrderValueOre: t.orders === 0 ? null : roundHalfUp(revenueAll, t.orders),
    profitOre: t.profitOre,
    marginBp: t.marginBp,
    unpricedShareBp: r.unpriced.shareBp,
  };
}

/** Inköp med täckning: hur stor del av orderna som har inköpspris. */
export interface CostOfGoods {
  readonly costOre: number;
  readonly pricedOrders: number;
  readonly unpricedOrders: number;
  /** Andel order med pris, i bp. `null` utan order. */
  readonly coverageBp: number | null;
  readonly unpricedTitleIds: string[];
}

/** Inköpskostnad för perioden med de priser som gällde varje orders dag. */
export function costOfGoods(input: ProfitabilityInput): CostOfGoods {
  const r = summarizeLedger(buildLedger(input), "title");
  return {
    costOre: r.totals.costOre,
    pricedOrders: r.totals.pricedOrders,
    unpricedOrders: r.totals.unpricedOrders,
    coverageBp: ratioBp(r.totals.pricedOrders, r.totals.orders),
    unpricedTitleIds: r.unpriced.titleIds,
  };
}

/** Butiksersättning per butik (alla order, även de utan inköpspris). */
export interface StoreCompensation {
  readonly storeId: string;
  readonly commissionOre: number;
  readonly rentOre: number;
  readonly totalOre: number;
}

/**
 * Vad butikerna ska ha för perioden: provision på nettointäkten och hyra per dag vid
 * delmånad, med de avtal och placeringar som gällde varje dag. Här ingår alla order,
 * även de som saknar inköpspris (butiken ska ha sin ersättning ändå).
 */
export function storeCompensation(input: ProfitabilityInput): {
  readonly stores: StoreCompensation[];
  readonly commissionOre: number;
  readonly rentOre: number;
  readonly totalOre: number;
} {
  const r = summarizeLedger(buildLedger(input), "store");
  const stores: StoreCompensation[] = r.rows
    .filter((row) => row.kind === "item")
    .map((row) => {
      const commission = row.commissionOre + row.unpricedCommissionOre;
      // Butikens rad har all butikens hyra i rentOre (även den på order utan pris).
      const rent = row.rentOre;
      return {
        storeId: row.key,
        commissionOre: commission,
        rentOre: rent,
        totalOre: commission + rent,
      };
    })
    .sort((a, b) => (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0));
  const commission = r.totals.commissionOre + r.totals.unpricedCommissionOre;
  const rent = r.totals.rentOre;
  return { stores, commissionOre: commission, rentOre: rent, totalOre: commission + rent };
}

/** Vinst och marginal för prissatta order i perioden. */
export function profit(input: ProfitabilityInput): { profitOre: number; marginBp: number | null } {
  const t = summarizeLedger(buildLedger(input), "title").totals;
  return { profitOre: t.profitOre, marginBp: t.marginBp };
}

/** Den rad som bidrar mest till vinsten, för rubriken på Lönsamhet. */
export interface TopContributor {
  readonly key: string;
  readonly profitOre: number;
  /**
   * Radens andel av totala vinsten i bp. `null` när totala vinsten är ≤ 0 (andelen
   * saknar då mening). Kan överstiga 10 000 om andra rader går med förlust.
   */
  readonly shareOfProfitBp: number | null;
}

/**
 * Raden med störst vinst bland vanliga rader (titel, automat, butik eller tid; inte
 * 'unallocated', 'no-machine' eller 'no-store'). `null` om det inte finns någon.
 *
 * Används för rubriker som "Ni behöll 31,4 % av intäkten (totals.marginBp).
 * Automat 1 står för nästan hälften av vinsten (shareOfProfitBp ≈ 4 900)."
 */
export function topContributor(result: ProfitabilityResult): TopContributor | null {
  let best: TopContributor | null = null;
  for (const row of result.rows) {
    if (row.kind !== "item" && row.kind !== "time") continue;
    if (row.pricedOrders === 0) continue;
    if (best === null || row.profitOre > best.profitOre) {
      best = { key: row.key, profitOre: row.profitOre, shareOfProfitBp: null };
    }
  }
  if (best === null) return null;
  const total = result.totals.profitOre;
  return { ...best, shareOfProfitBp: total > 0 ? ratioBp(best.profitOre, total) : null };
}
