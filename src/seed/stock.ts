/**
 * Lagerplan för seeden: inventering 12 okt, påfyllningar under perioden och
 * en ny leverans till centrallagret 27 okt, så att saldona i slutet blir
 * rimliga: de flesta har några pack kvar, LOW_STOCK_PAIRS par (automat,
 * titel) har 1–2 pack, ett par är slut, och en titel är slut i centrallagret.
 *
 * Försäljningen dras från automaten av databasen (en lagerhändelse `sale`
 * per order). Planen räknar med samma order och ser till att inget saldo
 * någonsin blir negativt.
 *
 * Påfyllning i en automat är en `refill`. Datamodellen kopplar inte en
 * påfyllning till centrallagret, så uttaget ur centrallagret skrivs som en
 * `adjustment` (negativ) med samma tid och en notering om automaten.
 */

import {
  LOW_STOCK_PAIRS,
  MACHINE_COUNT_TIME,
  PAR_BUFFER,
  REFILL_DAYS,
  REFILL_TIMES,
  SEED_MACHINES,
  SEED_TITLES,
  STOCK_COUNT_DAY,
  WAREHOUSE_COUNT_TIME,
  WAREHOUSE_RECEIPT,
} from "./catalog";
import { stockholmToUtcMs, type SeedOrder } from "./orders";

export type PlannedLocation = { kind: "warehouse" } | { kind: "machine"; code: string };

export interface PlannedStockEvent {
  location: PlannedLocation;
  title: string;
  kind: "count" | "refill" | "adjustment" | "receipt";
  /** Förändring, eller räknat antal vid `count`. */
  quantity: number;
  occurredAtMs: number;
  note: string;
}

export interface StockPair {
  machineCode: string;
  title: string;
}

export interface StockPlan {
  /** Händelserna i tidsordning (försäljningen kommer från orderna). */
  events: PlannedStockEvent[];
  /** Saldo i slutet per automat och titel: nyckel `${code}|${title}`. */
  machineLevels: Map<string, number>;
  /** Saldo i slutet i centrallagret per titel. */
  warehouseLevels: Map<string, number>;
  /** Paret som tar slut med sista ordern. */
  soldOut: StockPair;
  /** Paren som slutar på 1–2 pack. */
  low: StockPair[];
}

export const pairKey = (code: string, title: string): string => `${code}|${title}`;

interface PairState {
  machineCode: string;
  machineIndex: number;
  title: string;
  /** Försäljning per intervall: före första påfyllningen, mellan påfyllningar, efter sista. */
  intervals: number[];
  par: number;
  /** Saldo före sista påfyllningen (med vanlig påfyllning upp till par). */
  beforeLast: number;
  /** Försäljning efter sista påfyllningen. */
  afterLast: number;
}

function refillTimes(machineIndex: number): number[] {
  const time = REFILL_TIMES[machineIndex];
  if (!time) {
    throw new Error(`Påfyllningstid saknas för automat ${machineIndex + 1}.`);
  }
  return REFILL_DAYS.map((day) => stockholmToUtcMs(day, time));
}

function pairStates(orders: readonly SeedOrder[]): PairState[] {
  const states: PairState[] = [];
  SEED_MACHINES.forEach((machine, machineIndex) => {
    const refills = refillTimes(machineIndex);
    for (const title of SEED_TITLES) {
      const intervals = new Array<number>(refills.length + 1).fill(0);
      for (const o of orders) {
        if (o.machineCode !== machine.code || o.title !== title.name) {
          continue;
        }
        let k = 0;
        while (k < refills.length && o.paidAtMs >= (refills[k] ?? Infinity)) {
          k++;
        }
        intervals[k] = (intervals[k] ?? 0) + 1;
      }
      const par = Math.max(4, Math.max(...intervals) + PAR_BUFFER);
      // Saldo före sista påfyllningen: par minus försäljningen sedan näst sista.
      const beforeLast = par - (intervals[refills.length - 1] ?? 0);
      states.push({
        machineCode: machine.code,
        machineIndex,
        title: title.name,
        intervals,
        par,
        beforeLast,
        afterLast: intervals[refills.length] ?? 0,
      });
    }
  });
  return states;
}

/** Planerar lagerhändelserna för seed-orderna. Deterministisk. */
export function planStock(orders: readonly SeedOrder[]): StockPlan {
  const states = pairStates(orders);

  // Slut: det par i den mest säljande automaten som säljer mest efter sista
  // påfyllningen, och där sista påfyllningen kan sättas så att saldot blir 0.
  const feasible = (s: PairState, final: number): boolean =>
    s.afterLast >= 3 && s.afterLast + final > s.beforeLast;
  const ranked = [...states].sort(
    (a, b) => a.machineIndex - b.machineIndex || b.afterLast - a.afterLast,
  );
  const soldOutState = ranked.find((s) => feasible(s, 0));
  if (!soldOutState) {
    throw new Error("Inget par kan planeras att ta slut.");
  }
  const lowStates = [...states]
    .filter((s) => s !== soldOutState && feasible(s, 2))
    .sort((a, b) => b.afterLast - a.afterLast || a.machineIndex - b.machineIndex)
    .slice(0, LOW_STOCK_PAIRS);
  if (lowStates.length < LOW_STOCK_PAIRS) {
    throw new Error("För få par kan planeras med lågt saldo.");
  }
  const finalTarget = new Map<PairState, number>([[soldOutState, 0]]);
  lowStates.forEach((s, i) => finalTarget.set(s, i % 2 === 0 ? 1 : 2));

  const events: PlannedStockEvent[] = [];
  const machineLevels = new Map<string, number>();
  const refillsByTitle = new Map<string, { ms: number; quantity: number; code: string }[]>();
  const countMs = stockholmToUtcMs(STOCK_COUNT_DAY, MACHINE_COUNT_TIME);

  for (const s of states) {
    const location: PlannedLocation = { kind: "machine", code: s.machineCode };
    events.push({
      location,
      title: s.title,
      kind: "count",
      quantity: s.par,
      occurredAtMs: countMs,
      note: "Inventering före start",
    });
    const refills = refillTimes(s.machineIndex);
    let level = s.par - (s.intervals[0] ?? 0);
    refills.forEach((ms, k) => {
      const isLast = k === refills.length - 1;
      const target = isLast && finalTarget.has(s) ? s.afterLast + (finalTarget.get(s) ?? 0) : s.par;
      const quantity = target - level;
      if (quantity > 0) {
        events.push({
          location,
          title: s.title,
          kind: "refill",
          quantity,
          occurredAtMs: ms,
          note: "Påfyllning",
        });
        const list = refillsByTitle.get(s.title) ?? [];
        list.push({ ms, quantity, code: s.machineCode });
        refillsByTitle.set(s.title, list);
        level = target;
      }
      level -= s.intervals[k + 1] ?? 0;
      if (level < 0) {
        throw new Error(`Negativt saldo för ${s.machineCode} ${s.title}.`);
      }
    });
    machineLevels.set(pairKey(s.machineCode, s.title), level);
  }

  // Centrallagret: inventering, uttag vid varje påfyllning och en ny leverans.
  const warehouse: PlannedLocation = { kind: "warehouse" };
  const warehouseCountMs = stockholmToUtcMs(STOCK_COUNT_DAY, WAREHOUSE_COUNT_TIME);
  const receiptMs = stockholmToUtcMs(WAREHOUSE_RECEIPT.day, WAREHOUSE_RECEIPT.time);
  const warehouseLevels = new Map<string, number>();
  for (const title of SEED_TITLES) {
    const refills = refillsByTitle.get(title.name) ?? [];
    const total = refills.reduce((n, r) => n + r.quantity, 0);
    let initial: number;
    let receipt = 0;
    if (title.name === WAREHOUSE_RECEIPT.title) {
      const before = refills.filter((r) => r.ms < receiptMs).reduce((n, r) => n + r.quantity, 0);
      const after = total - before;
      // Lagret var nästan tomt före leveransen.
      initial = before + 2;
      const needed = after + title.warehouseReserve;
      const boxes = Math.ceil(needed / WAREHOUSE_RECEIPT.boxSize) * WAREHOUSE_RECEIPT.boxSize;
      receipt = Math.max(WAREHOUSE_RECEIPT.minQuantity, boxes);
    } else {
      initial = total + title.warehouseReserve;
    }
    events.push({
      location: warehouse,
      title: title.name,
      kind: "count",
      quantity: initial,
      occurredAtMs: warehouseCountMs,
      note: "Inventering av centrallagret före start",
    });
    if (receipt > 0) {
      events.push({
        location: warehouse,
        title: title.name,
        kind: "receipt",
        quantity: receipt,
        occurredAtMs: receiptMs,
        note: `Ny leverans: ${title.name}`,
      });
    }
    let level = initial;
    const timeline = [
      ...refills.map((r) => ({ ms: r.ms, delta: -r.quantity, code: r.code })),
      ...(receipt > 0 ? [{ ms: receiptMs, delta: receipt, code: null }] : []),
    ].sort((a, b) => a.ms - b.ms);
    for (const step of timeline) {
      level += step.delta;
      if (level < 0) {
        throw new Error(`Negativt saldo i centrallagret för ${title.name}.`);
      }
      if (step.code !== null) {
        events.push({
          location: warehouse,
          title: title.name,
          kind: "adjustment",
          quantity: step.delta,
          occurredAtMs: step.ms,
          note: `Uttag till påfyllning av ${step.code}`,
        });
      }
    }
    warehouseLevels.set(title.name, level);
  }

  events.sort((a, b) => a.occurredAtMs - b.occurredAtMs);
  return {
    events,
    machineLevels,
    warehouseLevels,
    soldOut: { machineCode: soldOutState.machineCode, title: soldOutState.title },
    low: lowStates.map((s) => ({ machineCode: s.machineCode, title: s.title })),
  };
}
