/**
 * Ekonomi per titel för sidan Inköpspriser: snittpris, aktuellt inköpspris och vad som
 * blir kvar per order, med varning när en titel går med förlust.
 *
 *   snittpris        = round(Σ netto / n)
 *   kvar före andel  = round((Σ netto − Σ kortavgift − VMB − n × aktuellt inköpspris) / n)
 *   butikens andel   = round(Σ provision / n)             (provision, % av intäkt eller vinstdelning)
 *   kvar per order   = round((Σ netto − Σ kortavgift − Σ provision − VMB − n × aktuellt inköpspris) / n)
 *                      (vår del: kvar efter butikens andel)
 *   VMB              = med VMB (vmbApplies): 20 % av max(0, Σ netto − n × aktuellt inköpspris),
 *                      annars 0
 *   hyra per order   = round(Σ fördelad hyra / n)            (redovisas separat, ingår inte ovan)
 *   kvar efter hyra  = round((… ovan … − Σ hyra) / n)
 *   förlustvarning   = kvar per order ≤ 0
 *
 * n = alla titelns order i perioden (även de som saknade pris på orderdagen), eftersom
 * frågan är vad nästa order lämnar med dagens pris. Avrundning sker en gång, på slutet,
 * per tal: därför kan kvar före andel − butikens andel skilja sig från kvar per order
 * med högst 1 öre (tre avrundade kvoter av heltalssummor).
 */

import { assertIsoDate } from "./dates";
import { buildLedger } from "./ledger";
import { BP_SCALE, fromBigInt, roundHalfUp } from "./money";
import type { IsoDate, ProfitabilityInput } from "./types";
import { vmbApplies, vmbVatOfMargin } from "./vmb";

/** En rad per titel. */
export interface TitleEconomics {
  readonly titleId: string;
  readonly orders: number;
  readonly pricedOrders: number;
  /** Order i perioden som saknade pris på sin dag. */
  readonly unpricedOrders: number;
  /** Nettointäkt, alla titelns order. */
  readonly revenueOre: number;
  /** Snittpris netto per order. */
  readonly averagePriceOre: number | null;
  /** Inköpspriset som gäller `asOf`. */
  readonly currentUnitCostOre: number | null;
  readonly currentPriceValidFrom: IsoDate | null;
  /** Snitt av de inköpspriser som faktiskt gällde orderna (prissatta order). */
  readonly averageCostOre: number | null;
  readonly averageFeeOre: number | null;
  readonly averageCommissionOre: number | null;
  /**
   * Kvar per order före butikens andel (hyra exkluderad): netto − kortavgift − VMB −
   * aktuellt inköp. `null` om pris eller order saknas.
   */
  readonly leftBeforeStoreOre: number | null;
  /**
   * Σ kvar före butikens andel för periodens order (täljaren ovan, oavrundad). Ger "kvar av
   * pris" med en enda avrundning: leftBeforeStoreTotalOre / revenueOre.
   */
  readonly leftBeforeStoreTotalOre: number | null;
  /**
   * Butikens andel per order (snittprovision: % av intäkten eller andel av vinsten). `null`
   * när kvar per order saknas. leftBeforeStoreOre − storeSharePerOrderOre = leftPerOrderOre
   * ±1 öre (avrundning).
   */
  readonly storeSharePerOrderOre: number | null;
  /** Vår del: kvar per order efter butikens andel (hyra exkluderad). `null` om pris eller order saknas. */
  readonly leftPerOrderOre: number | null;
  /** Kvar per order före butikens andel, efter hyra. */
  readonly leftBeforeStoreAfterRentOre: number | null;
  /** Hyra per order (fördelad hyra / antal order). */
  readonly rentPerOrderOre: number | null;
  /** Kvar per order efter hyra. */
  readonly leftPerOrderAfterRentOre: number | null;
  /** Vår del i bp av snittpriset. */
  readonly marginBp: number | null;
  /** Vår del efter butikens hela andel (provision + hyra) i bp av snittpriset. */
  readonly marginAfterRentBp: number | null;
  /** Kvar före butikens andel i bp av snittpriset. */
  readonly marginBeforeStoreBp: number | null;
  /** Vår del per order ≤ 0 (den verkliga förlusten). */
  readonly lossWarning: boolean;
  /** Kvar per order före butikens andel ≤ 0. */
  readonly lossBeforeStoreWarning: boolean;
  /** Kvar per order efter hyra ≤ 0. */
  readonly lossAfterRentWarning: boolean;
  /** Inget inköpspris gäller `asOf`. */
  readonly missingPrice: boolean;
}

/** Indata: som lönsamheten, plus datum för "aktuellt" pris och titlar som alltid ska med. */
export interface TitleEconomicsInput extends ProfitabilityInput {
  /** Dag vars pris är "aktuellt". Standard: periodens slut. */
  readonly asOf?: IsoDate;
  /** Titlar som ska med även utan försäljning (t.ex. alla aktiva titlar). */
  readonly titleIds?: readonly string[];
}

interface Acc {
  orders: number;
  priced: number;
  net: bigint;
  fee: bigint;
  commission: bigint;
  rent: bigint;
  cost: bigint;
}

/**
 * Ekonomi per titel för perioden. Titlar med försäljning, titlar med inköpspris och
 * titlar i `titleIds` kommer med. Sorterad på intäkt (störst först), sedan titel-id.
 */
export function titleEconomics(input: TitleEconomicsInput): TitleEconomics[] {
  const ledger = buildLedger(input);
  const asOf = input.asOf ?? input.period.end;
  assertIsoDate(asOf, "Datum för aktuellt pris");
  const prices = ledger.context.prices;
  const withVmb = vmbApplies(ledger.settings);

  const acc = new Map<string, Acc>();
  const get = (titleId: string): Acc => {
    let a = acc.get(titleId);
    if (!a) {
      a = { orders: 0, priced: 0, net: 0n, fee: 0n, commission: 0n, rent: 0n, cost: 0n };
      acc.set(titleId, a);
    }
    return a;
  };
  for (const id of input.titleIds ?? []) get(id);
  for (const id of prices.titleIds()) get(id);
  for (const e of ledger.entries) {
    const a = get(e.order.titleId);
    a.orders++;
    a.net += BigInt(e.netRevenueOre);
    a.fee += BigInt(e.cardFeeOre);
    a.commission += BigInt(e.commissionOre);
    a.rent += BigInt(e.rentOre);
    if (e.priced) {
      a.priced++;
      a.cost += BigInt(e.costOre);
    }
  }

  const out: TitleEconomics[] = [];
  for (const [titleId, a] of acc) {
    const price = prices.priceOn(titleId, asOf);
    const unitCost = price ? price.unitCostOre : null;
    const n = BigInt(a.orders);
    const has = a.orders > 0;
    const vmb =
      withVmb && unitCost !== null
        ? BigInt(vmbVatOfMargin(fromBigInt(a.net - n * BigInt(unitCost), "Marginalen")))
        : 0n;
    const beforeNumerator = unitCost === null ? null : a.net - a.fee - vmb - n * BigInt(unitCost);
    const leftNumerator = beforeNumerator === null ? null : beforeNumerator - a.commission;
    const priced = has && beforeNumerator !== null;
    const before = priced ? roundHalfUp(beforeNumerator, n) : null;
    const left = has && leftNumerator !== null ? roundHalfUp(leftNumerator, n) : null;
    const leftAfterRent =
      has && leftNumerator !== null ? roundHalfUp(leftNumerator - a.rent, n) : null;
    const margin = (num: bigint | null): number | null =>
      has && num !== null && a.net !== 0n ? roundHalfUp(num * BigInt(BP_SCALE), a.net) : null;
    out.push({
      titleId,
      orders: a.orders,
      pricedOrders: a.priced,
      unpricedOrders: a.orders - a.priced,
      revenueOre: fromBigInt(a.net, "Intäkten"),
      averagePriceOre: has ? roundHalfUp(a.net, n) : null,
      currentUnitCostOre: unitCost,
      currentPriceValidFrom: price ? price.validFrom : null,
      averageCostOre: a.priced > 0 ? roundHalfUp(a.cost, BigInt(a.priced)) : null,
      averageFeeOre: has ? roundHalfUp(a.fee, n) : null,
      averageCommissionOre: has ? roundHalfUp(a.commission, n) : null,
      leftBeforeStoreOre: before,
      leftBeforeStoreTotalOre: priced ? fromBigInt(beforeNumerator, "Kvar före andel") : null,
      storeSharePerOrderOre: priced ? roundHalfUp(a.commission, n) : null,
      leftPerOrderOre: left,
      leftBeforeStoreAfterRentOre: priced ? roundHalfUp(beforeNumerator - a.rent, n) : null,
      rentPerOrderOre: has ? roundHalfUp(a.rent, n) : null,
      leftPerOrderAfterRentOre: leftAfterRent,
      marginBp: margin(leftNumerator),
      marginAfterRentBp: margin(leftNumerator === null ? null : leftNumerator - a.rent),
      marginBeforeStoreBp: margin(beforeNumerator),
      lossWarning: left !== null && left <= 0,
      lossBeforeStoreWarning: before !== null && before <= 0,
      lossAfterRentWarning: leftAfterRent !== null && leftAfterRent <= 0,
      missingPrice: unitCost === null,
    });
  }
  out.sort((x, y) =>
    x.revenueOre !== y.revenueOre ? y.revenueOre - x.revenueOre : x.titleId < y.titleId ? -1 : 1,
  );
  return out;
}
