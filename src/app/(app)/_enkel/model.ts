/**
 * Enkel vy för delägaren som köper in: Lager, Inköpslista, Inköpspriser och Vinst per
 * produkt. Ren och klientsäker; texterna kommer från @/i18n (sidorna översätter koderna
 * här). Siffrorna kommer från samma modeller som hela appen:
 *
 * - Lager och Inköpslista: Vårt lagers vymodell (buildVartLagerModel). Inköpslistans antal
 *   är Inköps antal (needQty, samma siffra som /prognos och Att göra på Vårt lager).
 * - Inköpspriser: priset som gäller i dag (priceOn), titlar utan pris först.
 * - Vinst per produkt: lönsamheten per titel, vår vinst FÖRE butikernas andel
 *   (profitBeforeShareOre). Andelen dras aldrig här.
 */

import { parseAmountOre } from "@/import/amount";
import { priceOn, type IsoDate, type PurchasePrice } from "@/domain";

import { MAX_PACKS } from "../lager/_lib/schemas";
import { needsPurchase, type VartLagerRow } from "../vart-lager/_lib/model";

const byName = (a: string, b: string) =>
  a.localeCompare(b, "sv", { sensitivity: "base", numeric: true });

// ---------------------------------------------------------------------------
// Lager
// ---------------------------------------------------------------------------

/** Märket på en rad i Lager: räkna om (under 0), slut, tar snart slut, eller inget. */
export type StockBadge = "count" | "out" | "low" | null;

export function stockBadge(
  r: Pick<VartLagerRow, "negative" | "home" | "runsOut" | "retired" | "sold7">,
): StockBadge {
  if (r.negative) return "count";
  if (r.retired) return null;
  if (r.home <= 0) return r.sold7 > 0 || r.runsOut ? "out" : null;
  return r.runsOut ? "low" : null;
}

/**
 * Raderna i Lager: det som behöver göras först (räkna om, slut, tar snart slut), sedan
 * resten i namnordning. Utgångna titlar utan pack hemma visas inte (de ligger inte i lagret
 * och köps inte in).
 */
export function stockRows<
  R extends Pick<
    VartLagerRow,
    "name" | "negative" | "home" | "runsOut" | "retired" | "sold7" | "inMachines"
  >,
>(rows: readonly R[]): R[] {
  const rank = (r: R) => {
    const b = stockBadge(r);
    return b === "count" ? 0 : b === "out" ? 1 : b === "low" ? 2 : 3;
  };
  return rows
    .filter((r) => !(r.retired && r.home <= 0))
    .slice()
    .sort((a, b) => rank(a) - rank(b) || byName(a.name, b.name));
}

/** Ett antal pack ur ett fält. `min` 1 för en leverans, 0 för en räkning. */
export type PackCount =
  { readonly ok: true; readonly n: number } | { readonly ok: false; readonly error: "min" | "max" };

export function parsePackCount(text: string, min: 0 | 1): PackCount {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return { ok: false, error: "min" };
  const n = Number(t);
  if (n < min) return { ok: false, error: "min" };
  if (n > MAX_PACKS) return { ok: false, error: "max" };
  return { ok: true, n };
}

// ---------------------------------------------------------------------------
// Inköpslista
// ---------------------------------------------------------------------------

export interface BuyItem {
  readonly titleId: string;
  readonly name: string;
  /** Egen produkt (mystery pack): packas i stället för att köpas. */
  readonly own: boolean;
  /** Antal att köpa eller packa, eller null när inköpsplanen inte kunde räknas. */
  readonly qty: number | null;
  /** Mystery pack: hela omgångar att packa (samma tal som Inköp och Vårt lager), annars null. */
  readonly batches: number | null;
  /** Under 0 hemma: räkna om först, sedan köp eller packa. */
  readonly countFirst: boolean;
  readonly home: number;
  readonly inMachines: number;
  /** Slut hemma. */
  readonly out: boolean;
  readonly unitCostOre: number | null;
  /** qty × inköpspriset, när båda finns (bara det som köps, inte det som packas). */
  readonly costOre: number | null;
}

export interface BuyList {
  readonly items: BuyItem[];
  /** Planen saknas: titlarna som tar slut visas utan antal. */
  readonly noPlan: boolean;
  /** Summan av costOre för det som köps (inte egna produkter). */
  readonly totalOre: number;
  /** Rader att köpa (inte packa) som saknar inköpspris. */
  readonly unpriced: number;
}

/**
 * Inköpslistan: samma titlar och antal som Inköp på /prognos och "Beställ"/"Packa" på
 * Vårt lager (needsPurchase). Slut först, sedan kortast räcker, sedan namn.
 */
export function buyList(rows: readonly VartLagerRow[]): BuyList {
  const items = rows
    .filter((r) => needsPurchase(r))
    .slice()
    .sort(
      (a, b) =>
        Number(b.home <= 0) - Number(a.home <= 0) ||
        (a.daysLeft ?? -1) - (b.daysLeft ?? -1) ||
        byName(a.name, b.name),
    )
    .map((r): BuyItem => {
      const costOre =
        !r.own && r.needQty !== null && r.unitCostOre !== null ? r.needQty * r.unitCostOre : null;
      return {
        titleId: r.titleId,
        name: r.name,
        own: r.own,
        // Mystery packs: omgångarnas antal i pack (hela omgångar), annars Inköps antal.
        qty: r.action?.packs ?? r.needQty,
        batches: r.action?.batches ?? null,
        countFirst: r.negative,
        home: Math.max(0, r.home),
        inMachines: r.inMachines,
        out: r.home <= 0,
        unitCostOre: r.unitCostOre,
        costOre,
      };
    });
  return {
    items,
    noPlan: rows.some((r) => r.needQty === null),
    totalOre: items.reduce((s, i) => s + (i.costOre ?? 0), 0),
    unpriced: items.filter((i) => !i.own && i.unitCostOre === null).length,
  };
}

// ---------------------------------------------------------------------------
// Inköpspriser
// ---------------------------------------------------------------------------

export interface PriceRow {
  readonly titleId: string;
  readonly name: string;
  readonly own: boolean;
  /** Priset som gäller i dag, eller null. */
  readonly unitCostOre: number | null;
  /** Från vilken dag dagens pris gäller. */
  readonly validFrom: IsoDate | null;
}

/** Aktiva titlar (inte arkiverade eller sammanslagna) med dagens pris; utan pris först. */
export function priceRows(
  titles: readonly {
    readonly id: string;
    readonly name: string;
    readonly archived?: boolean;
    readonly mergedIntoId?: string | null;
    readonly ownProduct?: boolean;
  }[],
  prices: readonly PurchasePrice[],
  today: IsoDate,
): { rows: PriceRow[]; missing: number } {
  const rows = titles
    .filter((t) => !t.archived && !t.mergedIntoId)
    .map((t): PriceRow => {
      const p = priceOn(prices, t.id, today);
      return {
        titleId: t.id,
        name: t.name,
        own: t.ownProduct === true,
        unitCostOre: p?.unitCostOre ?? null,
        validFrom: p?.validFrom ?? null,
      };
    })
    .sort(
      (a, b) =>
        Number(b.unitCostOre === null) - Number(a.unitCostOre === null) || byName(a.name, b.name),
    );
  return { rows, missing: rows.filter((r) => r.unitCostOre === null).length };
}

/** Priset ur fältet ("112,50", "112.50", "112"), i öre. */
export type ParsedPrice =
  | { readonly ok: true; readonly ore: number }
  | { readonly ok: false; readonly error: "required" | "invalid" | "tooHigh" };

/** Samma tak som Inköpspriser (MAX_UNIT_COST_ORE, 100 000 kr per pack). */
export const MAX_PRICE_ORE = 10_000_000;

export function parsePrice(text: string): ParsedPrice {
  if (text.trim() === "") return { ok: false, error: "required" };
  const r = parseAmountOre(text);
  if (!r.ok) return { ok: false, error: "invalid" };
  if (r.ore > MAX_PRICE_ORE) return { ok: false, error: "tooHigh" };
  return { ok: true, ore: r.ore };
}

// ---------------------------------------------------------------------------
// Vinst per produkt
// ---------------------------------------------------------------------------

/** Det som behövs ur en rad i lönsamheten per titel (belopp i öre). */
export interface ProductProfitRow {
  readonly key: string;
  readonly kind: string;
  readonly orders: number;
  readonly pricedOrders: number;
  readonly unpricedOrders: number;
  readonly revenueOre: number;
  readonly unpricedRevenueOre: number;
  readonly profitBeforeShareOre: number;
}

export interface ProductProfit {
  readonly titleId: string;
  readonly name: string;
  readonly packs: number;
  /** Försäljning utan moms, alla köp. */
  readonly salesOre: number;
  /** Vår vinst före butikernas andel (köp med inköpspris). */
  readonly profitOre: number;
  /** Vinst per sålt pack med inköpspris, eller null utan sådana köp. */
  readonly perPackOre: number | null;
  /** Inget av köpen har inköpspris: vinsten är okänd. */
  readonly noPrice: boolean;
}

/**
 * Vinst per produkt, mest vinst först (sålda pack, sedan namn vid lika). Bara titlar med
 * köp. Vinsten är alltid FÖRE butikernas andel, oavsett organisationens inställning.
 */
export function productProfits(
  rows: readonly ProductProfitRow[],
  titles: readonly { readonly id: string; readonly name: string }[],
): ProductProfit[] {
  const names = new Map(titles.map((t) => [t.id, t.name]));
  return rows
    .filter((r) => r.kind === "item" && r.orders > 0)
    .map((r): ProductProfit => {
      const noPrice = r.pricedOrders === 0;
      return {
        titleId: r.key,
        name: names.get(r.key) ?? r.key,
        packs: r.orders,
        salesOre: r.revenueOre + r.unpricedRevenueOre,
        profitOre: r.profitBeforeShareOre,
        perPackOre: noPrice ? null : Math.round(r.profitBeforeShareOre / r.pricedOrders),
        noPrice,
      };
    })
    .sort(
      (a, b) =>
        Number(a.noPrice) - Number(b.noPrice) ||
        b.profitOre - a.profitOre ||
        b.packs - a.packs ||
        byName(a.name, b.name),
    );
}
