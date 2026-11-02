/**
 * Inköpspriser med giltighetsdatum.
 *
 * Det pris som gäller för en order är det senaste med `validFrom` ≤ orderns
 * affärsdatum. Finns inget sådant saknar ordern pris, och den räknas då inte in
 * i vinsten (se profitability.ts).
 */

import { assertIsoDate, addDays } from "./dates";
import { DomainError } from "./errors";
import { assertNonNegativeInteger } from "./money";
import type { IsoDate, OrderLine, PurchasePrice } from "./types";

/** En rad i prishistoriken för en titel. */
export interface PriceHistoryEntry {
  readonly titleId: string;
  readonly unitCostOre: number;
  readonly validFrom: IsoDate;
  /** Sista dag priset gällde (dagen före nästa pris), `null` = gäller fortfarande. */
  readonly validTo: IsoDate | null;
}

function validatePrice(p: PurchasePrice): void {
  if (!p || typeof p.titleId !== "string" || p.titleId === "") {
    throw new DomainError("invalid_input", "Inköpspriset saknar titel.");
  }
  assertIsoDate(p.validFrom, `Giltig från för titel ${p.titleId}`);
  assertNonNegativeInteger(p.unitCostOre, `Inköpspriset för titel ${p.titleId}`);
}

/**
 * Uppslag av inköpspriser per titel (sorterade, binärsökning). Bygg en gång och
 * återanvänd när många order ska prissättas.
 */
export class PriceIndex {
  private readonly byTitle = new Map<string, PurchasePrice[]>();

  constructor(prices: readonly PurchasePrice[]) {
    for (const p of prices) {
      validatePrice(p);
      const list = this.byTitle.get(p.titleId);
      if (list) list.push(p);
      else this.byTitle.set(p.titleId, [p]);
    }
    for (const [titleId, list] of this.byTitle) {
      list.sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
      for (let i = 1; i < list.length; i++) {
        if (list[i]!.validFrom === list[i - 1]!.validFrom) {
          throw new DomainError(
            "duplicate_price",
            `Titel ${titleId} har två inköpspriser som gäller från ${list[i]!.validFrom}.`,
          );
        }
      }
    }
  }

  /** Priset som gäller `date`, eller `null`. */
  priceOn(titleId: string, date: IsoDate): PurchasePrice | null {
    const list = this.byTitle.get(titleId);
    if (!list) return null;
    let lo = 0;
    let hi = list.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid]!.validFrom <= date) {
        found = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return found >= 0 ? list[found]! : null;
  }

  /** Alla priser för titeln, äldst först. */
  pricesFor(titleId: string): readonly PurchasePrice[] {
    return this.byTitle.get(titleId) ?? [];
  }

  /** Titlar som har minst ett pris. */
  titleIds(): string[] {
    return [...this.byTitle.keys()];
  }
}

/**
 * Inköpspriset som gällde `date` för titeln: det senaste med `validFrom` ≤ `date`.
 * `null` om titeln saknar pris den dagen.
 *
 * priceOn(priser, 'kort-a', '2026-10-15') → { unitCostOre: 2000, validFrom: '2026-09-01', … }
 */
export function priceOn(
  prices: readonly PurchasePrice[] | PriceIndex,
  titleId: string,
  date: IsoDate,
): PurchasePrice | null {
  assertIsoDate(date);
  const index = prices instanceof PriceIndex ? prices : new PriceIndex(prices);
  return index.priceOn(titleId, date);
}

/**
 * Prishistorik för en titel, senaste först, med "giltig till" uträknat
 * (dagen före nästa pris).
 */
export function priceHistory(
  prices: readonly PurchasePrice[] | PriceIndex,
  titleId: string,
): PriceHistoryEntry[] {
  const index = prices instanceof PriceIndex ? prices : new PriceIndex(prices);
  const list = index.pricesFor(titleId);
  const out: PriceHistoryEntry[] = [];
  for (let i = list.length - 1; i >= 0; i--) {
    const p = list[i]!;
    const next = list[i + 1];
    out.push({
      titleId: p.titleId,
      unitCostOre: p.unitCostOre,
      validFrom: p.validFrom,
      validTo: next ? addDays(next.validFrom, -1) : null,
    });
  }
  return out;
}

/** En ändring av inköpspriserna: lägg till/ersätt ett pris, eller ta bort ett. */
export type PriceChange =
  | { readonly kind: "upsert"; readonly price: PurchasePrice }
  | { readonly kind: "remove"; readonly titleId: string; readonly validFrom: IsoDate };

/** Vad en prisändring påverkar. */
export interface PriceChangeImpact {
  readonly titleId: string;
  /** Order vars inköpskostnad ändras (inklusive order som går från saknat pris till pris, och tvärtom). */
  readonly affectedOrders: number;
  readonly firstDate: IsoDate | null;
  readonly lastDate: IsoDate | null;
  /** Summa inköp för de påverkade orderna före och efter ändringen (order utan pris räknas som 0). */
  readonly costBeforeOre: number;
  readonly costAfterOre: number;
  readonly costDeltaOre: number;
  /** Order som får pris av ändringen respektive förlorar sitt pris. */
  readonly ordersGainingPrice: number;
  readonly ordersLosingPrice: number;
  /** Stängda månader ('ÅÅÅÅ-MM') som har påverkade order. */
  readonly closedMonthsAffected: string[];
}

/** Prislistan efter en ändring. */
export function applyPriceChange(
  prices: readonly PurchasePrice[],
  change: PriceChange,
): PurchasePrice[] {
  const titleId = change.kind === "upsert" ? change.price.titleId : change.titleId;
  const validFrom = change.kind === "upsert" ? change.price.validFrom : change.validFrom;
  const kept = prices.filter((p) => !(p.titleId === titleId && p.validFrom === validFrom));
  if (change.kind === "upsert") {
    validatePrice(change.price);
    kept.push(change.price);
  }
  return kept;
}

/**
 * Förhandsvisar vad en prisändring gör med orderna, t.ex. för en bekräftelse:
 * "Ändringen påverkar 132 order från 1 okt., inköp +1 240 kr, varav i stängd månad: september".
 */
export function priceChangeImpact(args: {
  readonly orders: readonly OrderLine[];
  readonly prices: readonly PurchasePrice[];
  readonly change: PriceChange;
  /** Stängda månader 'ÅÅÅÅ-MM'. */
  readonly closedMonths?: readonly string[];
}): PriceChangeImpact {
  const { orders, prices, change } = args;
  const titleId = change.kind === "upsert" ? change.price.titleId : change.titleId;
  const before = new PriceIndex(prices);
  const after = new PriceIndex(applyPriceChange(prices, change));
  const closed = new Set(args.closedMonths ?? []);
  const closedHit = new Set<string>();

  let affected = 0;
  let gaining = 0;
  let losing = 0;
  let costBefore = 0;
  let costAfter = 0;
  let firstDate: IsoDate | null = null;
  let lastDate: IsoDate | null = null;

  for (const o of orders) {
    if (o.titleId !== titleId) continue;
    const b = before.priceOn(titleId, o.businessDate);
    const a = after.priceOn(titleId, o.businessDate);
    const bc = b ? b.unitCostOre : null;
    const ac = a ? a.unitCostOre : null;
    if (bc === ac) continue;
    affected++;
    if (bc === null) gaining++;
    if (ac === null) losing++;
    costBefore += bc ?? 0;
    costAfter += ac ?? 0;
    if (firstDate === null || o.businessDate < firstDate) firstDate = o.businessDate;
    if (lastDate === null || o.businessDate > lastDate) lastDate = o.businessDate;
    const month = o.businessDate.slice(0, 7);
    if (closed.has(month)) closedHit.add(month);
  }

  return {
    titleId,
    affectedOrders: affected,
    firstDate,
    lastDate,
    costBeforeOre: costBefore,
    costAfterOre: costAfter,
    costDeltaOre: costAfter - costBefore,
    ordersGainingPrice: gaining,
    ordersLosingPrice: losing,
    closedMonthsAffected: [...closedHit].sort(),
  };
}
