/**
 * Rimlighetskoll av ett nytt inköpspris, innan det sparas: ett pris som ligger långt från
 * det förra (t.ex. 1 125 kr i stället för 112,50 kr) eller över vad packet säljs för är
 * oftast ett skrivfel. Kollen stoppar inget: den ber om ett extra tryck.
 *
 * Samma funktion används i formulären (gul rad) och på servern (addPurchasePriceFor och
 * correctPurchasePriceFor), så att kollen inte kan kringgås av misstag. Ren och klientsäker.
 */

import { formatKronor } from "@/lib/format";

/** Mer än så här långt från det förra priset (30 %) behöver ett extra tryck. */
export const PRICE_DOUBT_SHARE = 0.3;

export interface PriceDoubt {
  /** higher/lower: långt från det förra priset. aboveSale: över vad packet säljs för. */
  readonly kind: "higher" | "lower" | "aboveSale";
  readonly newOre: number;
  /** Det förra priset (higher, lower) eller snittpriset packet säljs för (aboveSale). */
  readonly refOre: number;
}

/**
 * null = priset ser rimligt ut. `oldOre` är priset som gällde innan, `saleOre` snittet av
 * vad kunderna betalat per pack; null eller 0 = finns inget att jämföra med.
 */
export function priceDoubt(x: {
  readonly newOre: number;
  readonly oldOre?: number | null;
  readonly saleOre?: number | null;
}): PriceDoubt | null {
  const { newOre } = x;
  const old = x.oldOre ?? null;
  if (old !== null && old > 0 && newOre !== old) {
    const off = Math.abs(newOre - old) / old;
    if (off > PRICE_DOUBT_SHARE) {
      return { kind: newOre > old ? "higher" : "lower", newOre, refOre: old };
    }
  }
  const sale = x.saleOre ?? null;
  if (sale !== null && sale > 0 && newOre > sale)
    return { kind: "aboveSale", newOre, refOre: sale };
  return null;
}

const kr = (ore: number) => formatKronor(ore / 100);

/** Den gula raden på svenska: "1 125 kr är mycket mer än förra priset 112,50 kr. Stämmer det?" */
export function priceDoubtText(d: PriceDoubt): string {
  if (d.kind === "aboveSale") {
    return `${kr(d.newOre)} är mer än packet säljs för (ca ${kr(d.refOre)}). Stämmer det?`;
  }
  const how = d.kind === "higher" ? "mycket mer" : "mycket mindre";
  return `${kr(d.newOre)} är ${how} än förra priset ${kr(d.refOre)}. Stämmer det?`;
}

/** Resultatet när servern vill ha ett extra tryck: felet plus vad som ser konstigt ut. */
export interface PriceDoubtResult {
  readonly ok: false;
  readonly error: string;
  readonly data?: undefined;
  readonly doubt: PriceDoubt;
}

export function isPriceDoubt(r: unknown): r is PriceDoubtResult {
  return typeof r === "object" && r !== null && "doubt" in r && Boolean(r.doubt);
}
