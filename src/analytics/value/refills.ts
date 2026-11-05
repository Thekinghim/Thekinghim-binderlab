/**
 * Påfyllning i tid: hur mycket som såldes tack vare att ett fack fylldes på innan det tog
 * slut. Ren funktion utan databas.
 *
 * Regler per lagerplats (automat) och titel, med lagerhändelserna i tidsordning
 * (`compareStockEvents`):
 *
 * 1. **Saldot** följs som i stock.ts: en inventering sätter saldot, andra händelser ändrar
 *    det. Saldot är känt från första inventeringen, eller från första händelsen om den är
 *    ett inflöde. Blir saldot negativt är det okänt till nästa inventering.
 * 2. **Varje påfyllning** (kind 'refill') i perioden klassas efter saldot strax före:
 *    - saldo > 0: **i tid** (facket var inte tomt),
 *    - saldo ≤ 0: **efter tomt**,
 *    - okänt saldo: **okänt** (räknas inte åt något håll).
 *    Flera påfyllningar av samma titel i samma automat samma dag räknas som en.
 * 3. **Räddad försäljning** efter en påfyllning i tid med saldot S före: de pack som säljs
 *    efter påfyllningen utöver S, alltså de som annars hade mött ett tomt fack. Bara
 *    försäljning inom `maxDays` dagar från dagen då facket hade blivit tomt räknas
 *    (SAVED_SALES_MAX_DAYS, standard 7): antagandet är att någon annars hade fyllt på inom
 *    en vecka. Räkningen slutar vid nästa inflöde, vid en positiv justering och vid en
 *    inventering som visar fler pack än väntat (en påfyllning som inte registrerats).
 *    Svinn ändrar inte S (försiktigt: färre räddade pack).
 * 4. **Kronor.** Räddade pack × snittpriset exkl. moms för titeln i automaten (orderna som
 *    skickas in), annars titelns snitt i alla automater. Bruttoresultat = intäkt − inköpspriset
 *    som gällde försäljningsdagen; pack utan inköpspris räknas inte i bruttoresultatet.
 * 5. Bara försäljning inom perioden räknas, i den månad packet såldes.
 */

import {
  addDays,
  assertPeriod,
  monthOf,
  PriceIndex,
  roundHalfUp,
  vatOfGross,
  type IsoDate,
  type IsoMonth,
  type OrderLine,
  type Period,
  type PurchasePrice,
  type Settings,
} from "@/domain";
import { compareStockEvents, stockKey, type StockEventRef } from "../lost-sales/stock";
import { SAVED_SALES_MAX_DAYS } from "./assumptions";

const INFLOW = new Set<StockEventRef["kind"]>(["refill", "receipt", "transfer_in"]);

export interface RefillValueInput {
  /** Automaternas lagerhändelser, inklusive försäljning ('sale'). Centrallagret ignoreras. */
  readonly stockEvents: readonly StockEventRef[];
  /** Order för snittpriset per pack (gärna några veckor före perioden också). */
  readonly orders: readonly OrderLine[];
  readonly period: Period;
  readonly settings: Pick<Settings, "vatRateBp">;
  readonly prices?: readonly PurchasePrice[];
  /** Dagar efter tomt som räknas. Standard SAVED_SALES_MAX_DAYS. */
  readonly maxDays?: number;
}

export interface RefillSeriesValue {
  readonly machineId: string;
  readonly titleId: string;
  readonly refillsOnTime: number;
  readonly refillsAfterEmpty: number;
  readonly savedUnits: number;
  readonly savedRevenueOre: number;
}

export interface RefillMonthValue {
  readonly month: IsoMonth;
  readonly refillsOnTime: number;
  readonly refillsAfterEmpty: number;
  readonly savedUnits: number;
  readonly savedRevenueOre: number;
}

export interface RefillValueResult {
  readonly period: Period;
  readonly maxDays: number;
  readonly refills: {
    readonly onTime: number;
    readonly afterEmpty: number;
    readonly unknown: number;
  };
  /** Andel i tid av påfyllningarna med känt saldo, i bp. `null` utan sådana. */
  readonly onTimeShareBp: number | null;
  readonly savedUnits: number;
  /** Räddad intäkt exkl. moms. */
  readonly savedRevenueOre: number;
  /** Räddad intäkt minus inköp, för pack med inköpspris. */
  readonly savedGrossProfitOre: number;
  /** Räddade pack utan snittpris (räknas inte i kronor). */
  readonly unitsWithoutPrice: number;
  readonly byMonth: readonly RefillMonthValue[];
  /** Per automat och titel, mest räddat först. */
  readonly series: readonly RefillSeriesValue[];
}

interface SavedUnit {
  readonly machineId: string;
  readonly titleId: string;
  readonly date: IsoDate;
}

interface RefillMark {
  readonly machineId: string;
  readonly titleId: string;
  readonly date: IsoDate;
  readonly status: "on-time" | "after-empty" | "unknown";
}

/** Snittpris exkl. moms per pack: per automat och titel, och per titel. */
function averagePrices(orders: readonly OrderLine[], vatRateBp: number) {
  const sums = new Map<string, { net: number; n: number }>();
  const add = (key: string, net: number) => {
    const cur = sums.get(key);
    if (cur) {
      cur.net += net;
      cur.n += 1;
    } else sums.set(key, { net, n: 1 });
  };
  for (const o of orders) {
    const net = o.amountOre - vatOfGross(o.amountOre, vatRateBp);
    add(`t:${o.titleId}`, net);
    if (o.machineId) add(`m:${o.machineId}:${o.titleId}`, net);
  }
  return (machineId: string, titleId: string): number | null => {
    const s = sums.get(`m:${machineId}:${titleId}`) ?? sums.get(`t:${titleId}`);
    return s && s.n > 0 ? roundHalfUp(s.net, s.n) : null;
  };
}

/** Går igenom en serie (en automat och titel) och samlar påfyllningar och räddade pack. */
function walkSeries(
  events: readonly StockEventRef[],
  period: Period,
  maxDays: number,
  marks: RefillMark[],
  saved: SavedUnit[],
): void {
  let level: number | null = null;
  let open: { before: number; sold: number; emptyDate: IsoDate | null } | null = null;
  const seenRefillDays = new Set<IsoDate>();

  events.forEach((e, i) => {
    const machineId = e.machineId!;
    const date = e.businessDate;
    if (e.kind === "count") {
      // Fler pack än väntat: en påfyllning som inte registrerats. Sluta räkna.
      if (open && level !== null && e.quantity > level) open = null;
      level = e.quantity;
      return;
    }
    if (INFLOW.has(e.kind)) {
      if (e.kind === "refill" && date >= period.start && date <= period.end) {
        if (!seenRefillDays.has(date)) {
          seenRefillDays.add(date);
          marks.push({
            machineId,
            titleId: e.titleId,
            date,
            status: level === null ? "unknown" : level > 0 ? "on-time" : "after-empty",
          });
        }
      }
      open =
        e.kind === "refill" && level !== null && level > 0
          ? { before: level, sold: 0, emptyDate: null }
          : null;
      if (level !== null) level += e.quantity;
      else if (i === 0) level = e.quantity; // fylld från tom: saldot känt från första inflödet
      return;
    }
    if (e.kind === "sale") {
      if (open) {
        open.sold += 1;
        if (open.sold > open.before) {
          if (open.emptyDate === null) open.emptyDate = date;
          const lastDay = addDays(open.emptyDate, maxDays - 1);
          if (date <= lastDay && date >= period.start && date <= period.end) {
            saved.push({ machineId, titleId: e.titleId, date });
          }
        }
      }
    } else if (e.kind === "adjustment" && e.quantity > 0) {
      open = null; // ett inflöde utan påfyllning: räkna inte vidare
    }
    if (level !== null) {
      level += e.quantity;
      if (level < 0) level = null;
    }
  });
}

/**
 * Påfyllningar i tid och räddad försäljning för perioden (se modulens regler).
 */
export function refillValue(input: RefillValueInput): RefillValueResult {
  assertPeriod(input.period);
  const maxDays = input.maxDays ?? SAVED_SALES_MAX_DAYS;
  if (!Number.isSafeInteger(maxDays) || maxDays < 1) {
    throw new Error(`maxDays måste vara ett heltal ≥ 1, fick ${maxDays}.`);
  }

  // Gruppera per lagerplats och titel (bara automater).
  const groups = new Map<string, StockEventRef[]>();
  for (const e of input.stockEvents) {
    if (e.machineId === null || e.businessDate > input.period.end) continue;
    const key = stockKey(e.locationId, e.titleId);
    const list = groups.get(key);
    if (list) list.push(e);
    else groups.set(key, [e]);
  }

  const marks: RefillMark[] = [];
  const saved: SavedUnit[] = [];
  for (const key of [...groups.keys()].sort()) {
    const list = groups.get(key)!.sort(compareStockEvents);
    walkSeries(list, input.period, maxDays, marks, saved);
  }

  const priceOf = averagePrices(input.orders, input.settings.vatRateBp);
  const costs = new PriceIndex(input.prices ?? []);

  let savedRevenueOre = 0;
  let savedGrossProfitOre = 0;
  let unitsWithoutPrice = 0;
  type Mutable<T> = { -readonly [K in keyof T]: T[K] };
  const months = new Map<IsoMonth, Mutable<RefillMonthValue>>();
  const month = (m: IsoMonth) => {
    let cur = months.get(m);
    if (!cur) {
      cur = { month: m, refillsOnTime: 0, refillsAfterEmpty: 0, savedUnits: 0, savedRevenueOre: 0 };
      months.set(m, cur);
    }
    return cur;
  };
  const series = new Map<string, Mutable<RefillSeriesValue>>();
  const seriesOf = (machineId: string, titleId: string) => {
    const key = `${machineId}:${titleId}`;
    let cur = series.get(key);
    if (!cur) {
      cur = {
        machineId,
        titleId,
        refillsOnTime: 0,
        refillsAfterEmpty: 0,
        savedUnits: 0,
        savedRevenueOre: 0,
      };
      series.set(key, cur);
    }
    return cur;
  };

  for (const u of saved) {
    const price = priceOf(u.machineId, u.titleId);
    const m = month(monthOf(u.date));
    const s = seriesOf(u.machineId, u.titleId);
    m.savedUnits += 1;
    s.savedUnits += 1;
    if (price === null) {
      unitsWithoutPrice += 1;
      continue;
    }
    savedRevenueOre += price;
    m.savedRevenueOre += price;
    s.savedRevenueOre += price;
    const cost = costs.priceOn(u.titleId, u.date);
    if (cost) savedGrossProfitOre += price - cost.unitCostOre;
  }

  let onTime = 0;
  let afterEmpty = 0;
  let unknown = 0;
  for (const r of marks) {
    if (r.status === "unknown") {
      unknown += 1;
      continue;
    }
    const m = month(monthOf(r.date));
    const s = seriesOf(r.machineId, r.titleId);
    if (r.status === "on-time") {
      onTime += 1;
      m.refillsOnTime += 1;
      s.refillsOnTime += 1;
    } else {
      afterEmpty += 1;
      m.refillsAfterEmpty += 1;
      s.refillsAfterEmpty += 1;
    }
  }

  const known = onTime + afterEmpty;
  return {
    period: input.period,
    maxDays,
    refills: { onTime, afterEmpty, unknown },
    onTimeShareBp: known === 0 ? null : roundHalfUp(onTime * 10_000, known),
    savedUnits: saved.length,
    savedRevenueOre,
    savedGrossProfitOre,
    unitsWithoutPrice,
    byMonth: [...months.values()].sort((a, b) => (a.month < b.month ? -1 : 1)),
    series: [...series.values()].sort(
      (a, b) =>
        b.savedRevenueOre - a.savedRevenueOre ||
        b.refillsAfterEmpty - a.refillsAfterEmpty ||
        (a.machineId + a.titleId < b.machineId + b.titleId ? -1 : 1),
    ),
  };
}
