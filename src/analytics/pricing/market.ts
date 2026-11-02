/**
 * Marknadspriser: hur inköpspriset per titel utvecklats över inköp från olika
 * leverantörer, och flaggor för inköp som var ovanligt billiga eller dyra.
 *
 * Indata är inköpsorderrader (purchase_order_lines med inköpsorderns leverantör och datum).
 * Priset är `unitCostOre` per pack.
 *
 * Prisutveckling per titel:
 * - medianpris per inköp (varje inköp räknas en gång, oavsett antal),
 * - snittpris viktat med antal = round(Σ pris × antal / Σ antal),
 * - per månad: snittpris viktat med antal,
 * - förändring = (senaste månadens snittpris − första månadens) / första månadens, i bp,
 * - per leverantör: antal inköp, medianpris och avvikelse mot titelns median i bp.
 *
 * Ovanligt pris (robust, median + MAD): ett inköp jämförs med titelns tidigare inköp
 * (datum före inköpets, inom `lookbackDays`). Det flaggas när
 * 1. det finns minst `minHistory` tidigare inköp,
 * 2. |robust z| > `thresholdHundredths` / 100 (standard 3,5), och
 * 3. |pris − median| ≥ `minDeviationBp` av medianen (standard 5 %), så att små öresskillnader
 *    aldrig flaggas när historiken råkar vara mycket jämn.
 * Är MAD 0 (minst hälften av de tidigare inköpen hade exakt medianpriset) räcker villkor 1 och 3.
 */

import {
  addDays,
  assertIsoDate,
  DomainError,
  monthOf,
  roundHalfUp,
  type IsoDate,
  type IsoMonth,
} from "@/domain";
import { Ratio, fig, signedPct } from "../expansion/common";
import { nameLookup } from "../todos/common";
import { day, krExact, monthName, plural } from "../todos/text";
import {
  bpOf,
  compareStrings,
  hundredthsFixed,
  hundredthsOf,
  marketEvidence,
  pctAbs,
  relativeChangeBp,
  type MarketEvidence,
  intOption,
} from "./common";
import { median, medianAbsoluteDeviation, robustZ } from "./robust";

/** Ett inköp: en inköpsorderrad med leverantör och datum. */
export interface PurchaseRecord {
  /** Radens id (purchase_order_lines.id). */
  readonly id: string;
  readonly titleId: string;
  readonly supplierId: string;
  /** Beställningsdag (affärsdatum). */
  readonly date: IsoDate;
  /** Pris per pack i öre. */
  readonly unitCostOre: number;
  /** Antal pack. */
  readonly quantity: number;
}

/** Namn för texterna. */
export interface NamedRef {
  readonly id: string;
  readonly name: string;
}

/** Indata till `purchasePriceTrends` och `flagPurchaseAnomalies`. */
export interface MarketPriceInput {
  readonly purchases: readonly PurchaseRecord[];
  readonly titles?: readonly NamedRef[];
  readonly suppliers?: readonly NamedRef[];
}

/** Snittpris för en månad. */
export interface MonthlyPurchasePrice {
  readonly month: IsoMonth;
  readonly purchases: number;
  readonly quantity: number;
  /** Snittpris viktat med antal, avrundat till öre. */
  readonly averageOre: number;
}

/** En leverantörs priser för titeln. */
export interface SupplierPriceSummary {
  readonly supplierId: string;
  readonly purchases: number;
  readonly quantity: number;
  /** Medianpris (avrundat till öre). */
  readonly medianOre: number;
  readonly lastOre: number;
  readonly lastDate: IsoDate;
  /** Medianens avvikelse mot titelns median i bp (negativ = billigare). */
  readonly vsTitleMedianBp: number;
}

/** Prisutveckling för en titel. */
export interface TitlePriceTrend {
  readonly titleId: string;
  readonly purchases: number;
  readonly quantity: number;
  readonly medianOre: number;
  readonly weightedAverageOre: number;
  readonly minOre: number;
  readonly maxOre: number;
  readonly first: { readonly date: IsoDate; readonly unitCostOre: number };
  readonly last: { readonly date: IsoDate; readonly unitCostOre: number };
  readonly months: readonly MonthlyPurchasePrice[];
  /** Senaste månadens snittpris mot första månadens i bp. `null` om bara en månad. */
  readonly changeBp: number | null;
  /** Leverantörer, billigast (lägst median) först. */
  readonly suppliers: readonly SupplierPriceSummary[];
  /** Inköpen, äldst först. */
  readonly points: readonly PurchaseRecord[];
  readonly text: string;
  readonly evidence: MarketEvidence;
}

/** Inställningar för flaggorna. */
export interface AnomalyOptions {
  /** Minsta antal tidigare inköp. Standard 5. */
  readonly minHistory?: number;
  /** Hur långt bakåt historiken räcker, i dagar. Standard 365. */
  readonly lookbackDays?: number;
  /** Gräns för |robust z| i hundradelar. Standard 350 (= 3,5). */
  readonly thresholdHundredths?: number;
  /** Minsta avvikelse mot medianen i bp. Standard 500 (= 5 %). */
  readonly minDeviationBp?: number;
  /** Bara inköp med datum i perioden flaggas (historiken kan ligga före). */
  readonly from?: IsoDate;
  readonly to?: IsoDate;
}

/** Ett inköp som var ovanligt billigt eller dyrt. */
export interface PurchaseAnomaly {
  /** Stabil nyckel 'purchase-price:<inköp>'. */
  readonly key: string;
  readonly purchaseId: string;
  readonly titleId: string;
  readonly supplierId: string;
  readonly date: IsoDate;
  readonly direction: "cheap" | "expensive";
  readonly unitCostOre: number;
  /** Medianen av de tidigare inköpen, avrundad till öre. */
  readonly medianOre: number;
  /** MAD avrundad till öre. */
  readonly madOre: number;
  /** Robust z i hundradelar, `null` när MAD är 0. */
  readonly robustZHundredths: number | null;
  /** (pris − median) / median i bp. */
  readonly deviationBp: number;
  /** Merkostnad (positiv) eller besparing (negativ) mot medianen för hela inköpet, i öre. */
  readonly impactOre: number;
  readonly historyCount: number;
  readonly text: string;
  readonly evidence: MarketEvidence;
}

function validatePurchase(p: PurchaseRecord): void {
  if (!p || typeof p.id !== "string" || p.id === "") {
    throw new DomainError("invalid_input", "Inköpet saknar id.");
  }
  if (typeof p.titleId !== "string" || p.titleId === "") {
    throw new DomainError("invalid_input", `Inköp ${p.id} saknar titel.`);
  }
  assertIsoDate(p.date, `Datum för inköp ${p.id}`);
  if (!Number.isSafeInteger(p.unitCostOre) || p.unitCostOre < 0) {
    throw new DomainError("invalid_amount", `Priset för inköp ${p.id} måste vara ett heltal ≥ 0.`);
  }
  if (!Number.isSafeInteger(p.quantity) || p.quantity < 1) {
    throw new DomainError("invalid_input", `Antalet för inköp ${p.id} måste vara ett heltal ≥ 1.`);
  }
}

function comparePurchases(a: PurchaseRecord, b: PurchaseRecord): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return compareStrings(a.id, b.id);
}

function groupByTitle(purchases: readonly PurchaseRecord[]): Map<string, PurchaseRecord[]> {
  const seen = new Set<string>();
  const map = new Map<string, PurchaseRecord[]>();
  for (const p of purchases) {
    validatePurchase(p);
    if (seen.has(p.id)) {
      throw new DomainError("invalid_input", `Inköp ${p.id} förekommer två gånger.`);
    }
    seen.add(p.id);
    const list = map.get(p.titleId);
    if (list) list.push(p);
    else map.set(p.titleId, [p]);
  }
  for (const list of map.values()) list.sort(comparePurchases);
  return map;
}

function weightedAverage(list: readonly PurchaseRecord[]): number {
  let sum = 0n;
  let qty = 0n;
  for (const p of list) {
    sum += BigInt(p.unitCostOre) * BigInt(p.quantity);
    qty += BigInt(p.quantity);
  }
  return roundHalfUp(sum, qty);
}

/**
 * Prisutveckling per titel över alla inköp, sorterad på titel-id. Titlar utan inköp kommer
 * inte med. Texten nämner förändringen från första till senaste månaden och den billigaste
 * leverantören, t.ex. "30th Celebration: snittpriset har gått från 28,00 kr (januari) till
 * 31,50 kr (oktober), +13 %. Billigast är Leverantör B, median 29,00 kr (−4 %)."
 */
export function purchasePriceTrends(input: MarketPriceInput): TitlePriceTrend[] {
  const titleName = nameLookup(input.titles ?? []);
  const supplierName = nameLookup(input.suppliers ?? []);
  const out: TitlePriceTrend[] = [];
  const groups = groupByTitle(input.purchases);
  for (const titleId of [...groups.keys()].sort(compareStrings)) {
    const list = groups.get(titleId)!;
    const titleMedian = median(list.map((p) => p.unitCostOre))!;
    const medianOre = titleMedian.round();

    const byMonth = new Map<IsoMonth, PurchaseRecord[]>();
    for (const p of list) {
      const m = monthOf(p.date);
      const ml = byMonth.get(m);
      if (ml) ml.push(p);
      else byMonth.set(m, [p]);
    }
    const months: MonthlyPurchasePrice[] = [...byMonth.keys()].sort().map((month) => {
      const ml = byMonth.get(month)!;
      return {
        month,
        purchases: ml.length,
        quantity: ml.reduce((s, p) => s + p.quantity, 0),
        averageOre: weightedAverage(ml),
      };
    });
    const firstMonth = months[0]!;
    const lastMonth = months[months.length - 1]!;
    const changeBp =
      months.length > 1 ? relativeChangeBp(lastMonth.averageOre, firstMonth.averageOre) : null;

    const bySupplier = new Map<string, PurchaseRecord[]>();
    for (const p of list) {
      const sl = bySupplier.get(p.supplierId);
      if (sl) sl.push(p);
      else bySupplier.set(p.supplierId, [p]);
    }
    const supplierRows = [...bySupplier.entries()]
      .map(([supplierId, sl]) => {
        const m = median(sl.map((p) => p.unitCostOre))!;
        const last = sl[sl.length - 1]!;
        const summary: SupplierPriceSummary = {
          supplierId,
          purchases: sl.length,
          quantity: sl.reduce((s, p) => s + p.quantity, 0),
          medianOre: m.round(),
          lastOre: last.unitCostOre,
          lastDate: last.date,
          vsTitleMedianBp: titleMedian.sign() === 0 ? 0 : bpOf(m.sub(titleMedian).div(titleMedian)),
        };
        return { m, summary };
      })
      .sort(
        (a, b) => a.m.compare(b.m) || compareStrings(a.summary.supplierId, b.summary.supplierId),
      );
    const suppliers = supplierRows.map((r) => r.summary);

    const first = list[0]!;
    const last = list[list.length - 1]!;
    const name = titleName(titleId);
    const parts: string[] = [];
    if (changeBp !== null) {
      parts.push(
        `${name}: snittpriset har gått från ${krExact(firstMonth.averageOre)} (${monthName(firstMonth.month)}${yearSuffix(firstMonth.month, lastMonth.month)}) till ${krExact(lastMonth.averageOre)} (${monthName(lastMonth.month)}${yearSuffix(lastMonth.month, firstMonth.month)}), ${signedPct(changeBp)}.`,
      );
    } else {
      parts.push(
        `${name}: ${plural(list.length, "inköp", "inköp")} i ${monthName(firstMonth.month)}, snittpris ${krExact(firstMonth.averageOre)}.`,
      );
    }
    if (suppliers.length > 1) {
      const cheapest = suppliers[0]!;
      parts.push(
        `Billigast är ${supplierName(cheapest.supplierId)}, median ${krExact(cheapest.medianOre)} (${signedPct(cheapest.vsTitleMedianBp)} mot titelns median ${krExact(medianOre)}).`,
      );
    }
    out.push({
      titleId,
      purchases: list.length,
      quantity: list.reduce((s, p) => s + p.quantity, 0),
      medianOre,
      weightedAverageOre: weightedAverage(list),
      minOre: Math.min(...list.map((p) => p.unitCostOre)),
      maxOre: Math.max(...list.map((p) => p.unitCostOre)),
      first: { date: first.date, unitCostOre: first.unitCostOre },
      last: { date: last.date, unitCostOre: last.unitCostOre },
      months,
      changeBp,
      suppliers,
      points: list,
      text: parts.join(" "),
      evidence: marketEvidence({
        rule: "Snittpris per månad viktat med antal; förändring från första till senaste månaden. Leverantörer jämförs med medianpriset per inköp.",
        period: { start: first.date, end: last.date },
        dates: list.map((p) => p.date),
        titleIds: [titleId],
        purchaseIds: list.map((p) => p.id),
        figures: [
          fig("purchases", "Antal inköp", list.length, "count"),
          fig("medianOre", "Medianpris per pack", medianOre, "ore"),
          fig("firstMonthAverageOre", "Snittpris första månaden", firstMonth.averageOre, "ore"),
          fig("lastMonthAverageOre", "Snittpris senaste månaden", lastMonth.averageOre, "ore"),
          ...(changeBp !== null ? [fig("changeBp", "Förändring", changeBp, "bp")] : []),
        ],
      }),
    });
  }
  return out;
}

function yearSuffix(month: IsoMonth, other: IsoMonth): string {
  return month.slice(0, 4) === other.slice(0, 4) ? "" : ` ${month.slice(0, 4)}`;
}

/**
 * Inköp som var ovanligt billiga eller dyra jämfört med titelns tidigare inköp (median + MAD,
 * se modulens beskrivning). Sorterade på datum, sedan id. Varje flagga bär de tidigare inköpen
 * den jämförts med.
 *
 * Exempel: tidigare 2 800–3 000 öre, median 2 900, MAD 100. Ett inköp à 3 600 öre har robust
 * z = 0,6745 × 700 / 100 = 4,72 > 3,5 och avviker 24 % → "dyrt".
 */
export function flagPurchaseAnomalies(
  input: MarketPriceInput,
  options: AnomalyOptions = {},
): PurchaseAnomaly[] {
  const minHistory = intOption(options.minHistory, 5, "Minsta historik", 1);
  const lookbackDays = intOption(options.lookbackDays, 365, "Historikens längd", 1);
  const threshold = intOption(options.thresholdHundredths, 350, "Gränsen för robust z", 0);
  const minDeviationBp = intOption(options.minDeviationBp, 500, "Minsta avvikelse", 0);
  if (options.from !== undefined) assertIsoDate(options.from, "Från");
  if (options.to !== undefined) assertIsoDate(options.to, "Till");
  const titleName = nameLookup(input.titles ?? []);
  const supplierName = nameLookup(input.suppliers ?? []);

  const out: PurchaseAnomaly[] = [];
  for (const list of groupByTitle(input.purchases).values()) {
    for (const p of list) {
      if (options.from !== undefined && p.date < options.from) continue;
      if (options.to !== undefined && p.date > options.to) continue;
      const earliest = addDays(p.date, -lookbackDays);
      const history = list.filter((h) => h.date < p.date && h.date >= earliest);
      if (history.length < minHistory) continue;
      const values = history.map((h) => h.unitCostOre);
      const med = median(values)!;
      const mad = medianAbsoluteDeviation(values, med)!;
      if (med.sign() === 0) continue;
      const diff = new Ratio(p.unitCostOre).sub(med);
      const deviationBp = bpOf(diff.div(med));
      if (Math.abs(deviationBp) < minDeviationBp || diff.sign() === 0) continue;
      const z = robustZ(p.unitCostOre, med, mad);
      const zH = z === null ? null : hundredthsOf(z);
      if (z !== null) {
        const absZ = z.sign() < 0 ? z.mul(-1) : z;
        if (absZ.compare(new Ratio(threshold, 100)) <= 0) continue;
      }
      const direction = diff.sign() > 0 ? "expensive" : "cheap";
      const medianOre = med.round();
      const impactOre = diff.mul(p.quantity).round();
      const name = titleName(p.titleId);
      const word = direction === "expensive" ? "över" : "under";
      const spread =
        zH === null
          ? `alla jämförda inköp kostade ${krExact(medianOre)} eller nära det`
          : `robust z ${hundredthsFixed(zH)}`;
      out.push({
        key: `purchase-price:${p.id}`,
        purchaseId: p.id,
        titleId: p.titleId,
        supplierId: p.supplierId,
        date: p.date,
        direction,
        unitCostOre: p.unitCostOre,
        medianOre,
        madOre: mad.round(),
        robustZHundredths: zH,
        deviationBp,
        impactOre,
        historyCount: history.length,
        text: `${direction === "expensive" ? "Dyrt" : "Billigt"} inköp: ${name} från ${supplierName(p.supplierId)} ${day(p.date)} kostade ${krExact(p.unitCostOre)} per pack, ${pctAbs(deviationBp)} ${word} medianen ${krExact(medianOre)} för ${plural(history.length, "tidigare inköp", "tidigare inköp")} (${spread}). ${direction === "expensive" ? "Merkostnad" : "Besparing"} ${krExact(Math.abs(impactOre))} på ${plural(p.quantity, "pack", "pack")}.`,
        evidence: marketEvidence({
          rule: `Jämfört med titelns inköp de ${lookbackDays} dagarna före: flaggas när |robust z| > ${hundredthsFixed(threshold)} och avvikelsen mot medianen är minst ${pctAbs(minDeviationBp)} (minst ${minHistory} tidigare inköp).`,
          period: { start: history[0]!.date, end: p.date },
          dates: [p.date, ...history.map((h) => h.date)],
          titleIds: [p.titleId],
          purchaseIds: [p.id, ...history.map((h) => h.id)],
          figures: [
            fig("unitCostOre", "Pris per pack", p.unitCostOre, "ore"),
            fig("medianOre", "Median tidigare inköp", medianOre, "ore"),
            fig("madOre", "MAD tidigare inköp", mad.round(), "ore"),
            ...(zH !== null ? [fig("robustZ", "Robust z", zH, "hundredths")] : []),
            fig("deviationBp", "Avvikelse mot medianen", deviationBp, "bp"),
            fig("historyCount", "Tidigare inköp", history.length, "count"),
            fig("impactOre", "Skillnad mot medianen för inköpet", impactOre, "ore"),
          ],
        }),
      });
    }
  }
  return out.sort((a, b) =>
    a.date !== b.date ? (a.date < b.date ? -1 : 1) : compareStrings(a.purchaseId, b.purchaseId),
  );
}
