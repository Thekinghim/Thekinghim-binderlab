/**
 * Bästa åtgärder: de tre konkreta förslag som är värda mest just nu. Ren funktion; förslagen
 * bygger på beräkningar som redan finns (förlorad försäljning, lönsamhet per titel,
 * sortimentsrådet) och värderas i kronor per månad där det går.
 *
 * Kandidater:
 * - **Fyll på tidigare** (`refill-earlier`): en titel i en automat där slutsålt kostade minst
 *   `minLostOre` (standard 50 kr) i månaden. Värde = förlorad intäkt i månaden.
 * - **Höj priset** (`price`): en titel med minst PRICE_ACTION_MIN_ORDERS prissatta order och
 *   negativt "kvar efter inköp" i månaden. Värde = förlusten (−kvar efter inköp).
 * - **Byt sortiment** (`assortment`): sortimentsrådet för en automat (bara "ändra"). Värde =
 *   väntad effekt per vecka × 4 (en månad, försiktigt avrundat nedåt till hela veckor).
 * - **Lägg in inköpspris** (`missing-price`): titlar med order utan inköpspris. Inget
 *   kronvärde (vinsten går inte att räkna); sorteras efter de med värde.
 *
 * Urval: kandidaterna sorteras efter värde (störst först; utan värde sist, efter intäkt). Först
 * väljs den bästa av varje sort i den ordningen, så att listan blir varierad, sedan fylls
 * den på med de näst bästa upp till `max` (standard 3). Resultatet sorteras efter värde.
 */

import { krExact, kr, plural } from "../todos/text";
import { PRICE_ACTION_MIN_ORDERS } from "./assumptions";

export type BestActionKind = "refill-earlier" | "price" | "assortment" | "missing-price";

export interface BestAction {
  readonly key: string;
  readonly kind: BestActionKind;
  /** Imperativ, verbet först ("Fyll på Pikachu i BL-001 tidigare"). */
  readonly title: string;
  readonly detail: string;
  /** Värde i öre per månad, eller `null` när det inte går att säga. */
  readonly valueOre: number | null;
  readonly href: string;
}

export interface LostSeriesRef {
  readonly machineId: string;
  readonly titleId: string;
  readonly lostRevenueOre: number;
}

export interface TitleKeptRef {
  readonly titleId: string;
  readonly pricedOrders: number;
  readonly keptOre: number;
}

export interface UnpricedTitleRef {
  readonly titleId: string;
  readonly orders: number;
  readonly revenueOre: number;
}

export interface AssortmentRef {
  readonly machineId: string;
  readonly effectPerWeekOre: number;
  readonly text: string;
}

export interface BestActionsInput {
  readonly lost: readonly LostSeriesRef[];
  readonly titles: readonly TitleKeptRef[];
  readonly unpriced: readonly UnpricedTitleRef[];
  readonly assortment: readonly AssortmentRef[];
  readonly titleName: (id: string) => string;
  readonly machineName: (id: string) => string;
  /** "oktober" (för texterna). */
  readonly monthLabel: string;
  readonly hrefs: {
    readonly lost: (machineId: string, titleId: string) => string;
    readonly price: (titleId: string) => string;
    readonly assortment: (machineId: string) => string;
  };
  readonly max?: number;
  /** Minsta förlorade intäkt för "fyll på tidigare", öre. Standard 5 000. */
  readonly minLostOre?: number;
}

const ORDER: Record<BestActionKind, number> = {
  "refill-earlier": 0,
  price: 1,
  assortment: 2,
  "missing-price": 3,
};

interface Candidate extends BestAction {
  readonly weight: number;
}

function compare(a: Candidate, b: Candidate): number {
  const av = a.valueOre ?? -1;
  const bv = b.valueOre ?? -1;
  if (av !== bv) return bv - av;
  if (a.weight !== b.weight) return b.weight - a.weight;
  if (ORDER[a.kind] !== ORDER[b.kind]) return ORDER[a.kind] - ORDER[b.kind];
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export function bestActions(input: BestActionsInput): BestAction[] {
  const max = input.max ?? 3;
  const minLost = input.minLostOre ?? 5_000;
  const all: Candidate[] = [];

  for (const s of input.lost) {
    if (s.lostRevenueOre < minLost) continue;
    all.push({
      key: `refill-earlier:${s.machineId}:${s.titleId}`,
      kind: "refill-earlier",
      title: `Fyll på ${input.titleName(s.titleId)} i ${input.machineName(s.machineId)} tidigare`,
      detail: `Facket stod tomt. Det kostade ca ${kr(s.lostRevenueOre)} i ${input.monthLabel}.`,
      valueOre: s.lostRevenueOre,
      weight: s.lostRevenueOre,
      href: input.hrefs.lost(s.machineId, s.titleId),
    });
  }

  for (const t of input.titles) {
    if (t.pricedOrders < PRICE_ACTION_MIN_ORDERS || t.keptOre >= 0) continue;
    const perPack = Math.trunc(t.keptOre / t.pricedOrders);
    all.push({
      key: `price:${t.titleId}`,
      kind: "price",
      title: `Höj priset på ${input.titleName(t.titleId)}`,
      detail: `Varje pack gav ${krExact(perPack)} efter inköp i ${input.monthLabel} (${plural(t.pricedOrders, "order", "order")}).`,
      valueOre: -t.keptOre,
      weight: -t.keptOre,
      href: input.hrefs.price(t.titleId),
    });
  }

  for (const a of input.assortment) {
    if (a.effectPerWeekOre <= 0) continue;
    const month = a.effectPerWeekOre * 4;
    all.push({
      key: `assortment:${a.machineId}`,
      kind: "assortment",
      title: `Flytta titlar i ${input.machineName(a.machineId)}`,
      detail: `${a.text} Ca ${kr(month)} mer per månad.`,
      valueOre: month,
      weight: month,
      href: input.hrefs.assortment(a.machineId),
    });
  }

  for (const u of input.unpriced) {
    if (u.orders <= 0) continue;
    all.push({
      key: `missing-price:${u.titleId}`,
      kind: "missing-price",
      title: `Lägg in inköpspris för ${input.titleName(u.titleId)}`,
      detail: `${plural(u.orders, "order", "order")} för ${kr(u.revenueOre)} saknar inköpspris. Vinsten syns inte.`,
      valueOre: null,
      weight: u.revenueOre,
      href: input.hrefs.price(u.titleId),
    });
  }

  all.sort(compare);
  const picked: Candidate[] = [];
  const kinds = new Set<BestActionKind>();
  for (const c of all) {
    if (picked.length >= max) break;
    if (kinds.has(c.kind)) continue;
    kinds.add(c.kind);
    picked.push(c);
  }
  for (const c of all) {
    if (picked.length >= max) break;
    if (!picked.includes(c)) picked.push(c);
  }
  return picked.sort(compare).map(({ weight: _weight, ...rest }) => rest);
}
