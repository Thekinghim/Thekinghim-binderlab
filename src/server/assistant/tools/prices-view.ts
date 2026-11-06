/**
 * Raderna i verktyget inkopspriser, på samma grund som sidan Inköpspriser:
 *
 * - Som standard är "kvar per order" HELA beloppet per order (före butikens andel) och
 *   "marginal" är kvar av pris före andelen, som sidans kolumner Kvar per order och Kvar av
 *   pris.
 * - Med `share` (frågan gäller en butik/automat eller uttryckligen butikens andel, som vald
 *   butik eller "Visa butikernas andel" på sidan) kommer delningen med: butikens andel per
 *   order och vår del (kvar efter andelen), och efter hyra är det vår del efter hyra.
 * - Utan `share` står vår del bara på rader med förlust (där andelen gör förlusten), som
 *   sidans förlusttext.
 *
 * Ren funktion (inga laddare), så att regeln kan testas utan databas.
 */

import { lossOnlyAfterShare, type TitleRow } from "@/app/(app)/inkopspriser/_lib/model";
import { formatPercent, formatSek } from "@/lib/format";

export type PriceSort = "marginal" | "kvar_per_order" | "order";

export interface PriceViewOptions {
  /** Visa delningen (butikens andel och vår del). */
  readonly share: boolean;
  /** Något avtal har hyra: ta med kvar efter hyra. */
  readonly rent: boolean;
  /** Urvalet som andelen gäller ("ICA Assistent"), för anmärkningen. Standard: alla butiker. */
  readonly scope?: string | null;
}

const STATUS_TEXT: Record<TitleRow["status"], string> = {
  missing: "saknar inköpspris",
  loss: "går med förlust",
  partial: "inköpspris saknas för en del av perioden",
  "loss-after-rent": "går med förlust efter hyran",
  idle: "ingen försäljning",
  ok: "lönsam",
};

/**
 * Statusen som sidans statusLabel: säger när förlusten kommer först efter butikens andel
 * (hela beloppet är positivt), så att den inte motsäger "kvar per order".
 */
function statusText(r: TitleRow): string {
  if (lossOnlyAfterShare(r)) return "går med förlust efter butikens andel";
  if (lossAfterRentOnlyAfterShare(r)) return "går med förlust efter hyra och andel";
  return STATUS_TEXT[r.status];
}

/** Förlust efter hyra som kommer av andelen: före andelen är det kvar efter hyran. */
function lossAfterRentOnlyAfterShare(r: TitleRow): boolean {
  return (
    r.status === "loss-after-rent" &&
    r.leftBeforeAfterRentOre !== null &&
    r.leftBeforeAfterRentOre > 0
  );
}

function kr(ore: number | null): string {
  return ore === null ? "–" : formatSek(ore / 100);
}

function pct(bp: number | null): string {
  return bp === null ? "–" : formatPercent(bp / 10_000);
}

/** Har titeln en butiksandel som skiljer hela beloppet från vår del? */
function hasShare(r: TitleRow): boolean {
  return (r.storeShareOre ?? 0) !== 0 && r.leftOre !== null;
}

/** Sorteringsnyckel (lägst först): samma tal som visas som kvar per order/marginal. */
export function priceSortKey(sort: PriceSort, o: Pick<PriceViewOptions, "share">) {
  return (r: TitleRow): number => {
    if (sort === "order") return -r.orders;
    if (sort === "kvar_per_order") {
      return (o.share ? r.leftOre : r.leftBeforeOre) ?? Number.POSITIVE_INFINITY;
    }
    return (o.share ? r.marginBp : r.marginBeforeBp) ?? Number.POSITIVE_INFINITY;
  };
}

/** Beloppet per order som sammanfattning och figurer visar för raden. */
export function perOrderText(r: TitleRow, o: Pick<PriceViewOptions, "share">): string {
  if (r.leftBeforeOre === null) return "–";
  if (!o.share || !hasShare(r)) return `${kr(r.leftBeforeOre)} per order`;
  return `${kr(r.leftBeforeOre)} per order, butikens andel ${kr(r.storeShareOre)}, vår del ${kr(r.leftOre)}`;
}

/** En rad till modellen. */
export function priceRowData(r: TitleRow, o: PriceViewOptions): Record<string, unknown> {
  const base: Record<string, unknown> = {
    titel: r.name,
    id: r.id,
    status: statusText(r),
    inkopsprisIdag: r.currentCostOre === null ? "saknas" : kr(r.currentCostOre),
    inkopsprisIdagOre: r.currentCostOre,
    giltigtFran: r.currentFrom,
    snittprisPerOrder: kr(r.averagePriceOre),
    snittprisPerOrderOre: r.averagePriceOre,
    kvarPerOrder: kr(r.leftBeforeOre),
    kvarPerOrderOre: r.leftBeforeOre,
    marginal: pct(r.marginBeforeBp),
    marginalBp: r.marginBeforeBp,
  };
  if (o.share) {
    // Butikens andel = provision eller vinstdelning + hyra (som sidan och Lönsamhet).
    base.butikensAndelPerOrder = kr(r.storeShareOre);
    base.butikensAndelPerOrderOre = r.storeShareOre;
    if (o.rent) {
      base.varavHyraPerOrder = kr(r.rentOre);
      base.varavHyraPerOrderOre = r.rentOre;
    }
    base.varDelPerOrder = kr(r.leftOre);
    base.varDelPerOrderOre = r.leftOre;
    base.varMarginal = pct(r.marginBp);
    base.varMarginalBp = r.marginBp;
  } else if ((r.status === "loss" || r.status === "loss-after-rent") && hasShare(r)) {
    // Förlusten kommer av butikens andel: vår del behövs för att förklara den.
    base.varDelPerOrder = kr(r.leftOre);
    base.varDelPerOrderOre = r.leftOre;
  }
  base.order = r.orders;
  base.orderUtanPris = r.unpricedOrders;
  return base;
}

/** Förklaringen till fälten (anmärkningen i verktygsresultatet). */
export function priceNote(o: PriceViewOptions): string {
  const full =
    "Kvar per order = hela beloppet per order före butikens andel: snittpris exkl. moms − inköp − avgifter (som sidan Inköpspriser). Marginal = kvar per order av priset.";
  if (o.share) {
    return `${full} Butikens andel per order (provision eller vinstdelning${o.rent ? " + hyra" : ""}) och vår del (kvar efter andelen) gäller ${o.scope ?? "alla butiker"}. Ange hela beloppet och sedan delningen: butikens andel och vår del.`;
  }
  return `${full} Butikens andel och vår del visas inte, inte heller hyran (den hör till butikernas andel): svara med hela beloppet. Vår del står bara på titlar med förlust, där andelen gör förlusten. Fråga om en butik eller om andelen ger delningen.`;
}
