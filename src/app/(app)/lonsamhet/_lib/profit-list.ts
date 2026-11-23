/**
 * Vinstlistan (Lönsamhet, vyerna per titel, automat och butik): vilka rader som får en
 * vinststapel, i vilken ordning, och texterna under namnet. Bara presentation: beloppen
 * kommer färdiga från modellen (ProfitLine) och räknas inte om.
 */
import { formatInt, formatSek, NBSP } from "@/lib/format";

import type { ProfitLine } from "./model";

/** Raden har order men ingen med inköpspris: vinsten är okänd. */
export function isOnlyUnpriced(r: ProfitLine): boolean {
  return r.kind === "item" && r.orders > 0 && r.orders === r.unpricedOrders;
}

export interface ProfitListGroups {
  /** Rader med vinst (helt eller delvis prissatta), mest vinst först. */
  readonly priced: ProfitLine[];
  /** Rader där inget sålt har inköpspris, mest intäkt först. */
  readonly unpriced: ProfitLine[];
  /** De särskilda raderna (ej fördelad hyra, utan automat, utan butik), sist. */
  readonly special: ProfitLine[];
}

const collator = new Intl.Collator("sv-SE", { numeric: true, sensitivity: "base" });

/** Delar upp och sorterar raderna för listan. Ren funktion (testas). */
export function profitListGroups(rows: readonly ProfitLine[]): ProfitListGroups {
  const priced: ProfitLine[] = [];
  const unpriced: ProfitLine[] = [];
  const special: ProfitLine[] = [];
  for (const r of rows) {
    if (r.kind !== "item") special.push(r);
    else if (isOnlyUnpriced(r)) unpriced.push(r);
    else priced.push(r);
  }
  priced.sort((a, b) => b.profitOre - a.profitOre || collator.compare(a.name, b.name));
  unpriced.sort(
    (a, b) => b.unpricedRevenueOre - a.unpricedRevenueOre || collator.compare(a.name, b.name),
  );
  return { priced, unpriced, special };
}

/**
 * Intäkten stapeln visar: prissatt intäkt (det som delas i kostnad och vinst), eller för rader
 * helt utan inköpspris intäkten utan pris (randig stapel).
 */
export function barRevenueOre(r: ProfitLine): number {
  return isOnlyUnpriced(r) ? r.unpricedRevenueOre : r.revenueOre;
}

/** Listans längsta stapel (full längd). */
export function barMaxOre(rows: readonly ProfitLine[]): number {
  let max = 0;
  for (const r of rows) if (r.kind === "item") max = Math.max(max, barRevenueOre(r));
  return max;
}

/**
 * Det grå i stapeln: allt i den prissatta intäkten som inte är vår vinst (inköp, kortavgifter,
 * VMB-moms och, när den är dragen, butikernas andel). Samma tal som modellens vinst.
 */
export function barCostOre(r: ProfitLine): number {
  return r.revenueOre - r.profitOre;
}

/** Vad det grå heter i rubriken: "inköp" när det bara är inköpet, annars "kostnader". */
export function costNoun(totals: ProfitLine, showStoreShare: boolean): "inköp" | "kostnader" {
  const onlyCost =
    totals.feesOre === 0 &&
    totals.vmbVatOre === 0 &&
    (!showStoreShare || totals.compensationOre === 0);
  return onlyCost ? "inköp" : "kostnader";
}

const kr = (ore: number) => formatSek(ore / 100);

/** "1 såld" · "12 sålda". */
export function soldText(orders: number): string {
  return `${formatInt(orders)}${NBSP}${orders === 1 ? "såld" : "sålda"}`;
}

/**
 * Raden under namnet: "100 sålda · 21 900 kr intäkt", och för delvis prissatta
 * "· 3 utan pris". Intäkten är all intäkt (med och utan inköpspris).
 */
export function subLine(r: ProfitLine): string {
  const parts = [soldText(r.orders), `${kr(r.revenueOre + r.unpricedRevenueOre)} intäkt`];
  if (r.kind === "item" && r.unpricedOrders > 0 && !isOnlyUnpriced(r)) {
    parts.push(`${formatInt(r.unpricedOrders)} utan pris`);
  }
  return parts.join(" · ");
}

/** Tooltip på stapeln: "Intäkt 21 900 kr · Kostnader 13 900 kr · Vinst 8 000 kr". */
export function barTitle(r: ProfitLine, noun: "inköp" | "kostnader", profitLabel: string): string {
  if (isOnlyUnpriced(r)) return `Intäkt ${kr(r.unpricedRevenueOre)} · inköpspris saknas`;
  const cost = noun === "inköp" ? "Inköp" : "Kostnader";
  return `Intäkt ${kr(r.revenueOre)} · ${cost} ${kr(barCostOre(r))} · ${profitLabel} ${kr(r.profitOre)}`;
}

/** Totalraden: "Totalt 775 order · 121 792 kr intäkt med pris". */
export function totalLine(totals: ProfitLine): string {
  return `Totalt ${formatInt(totals.orders)} order · ${kr(totals.revenueOre)} intäkt med pris`;
}
