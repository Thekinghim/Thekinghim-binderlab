/**
 * Referensberäkning för testerna, skriven så enkelt och fristående som möjligt:
 * linjära sökningar, dag-för-dag-loopar, datum via Date.UTC (oberoende av tidszon)
 * och en annan avrundningsformel. Den delar ingen kod med beräkningslagret, så att
 * avstämningstesterna verkligen jämför två oberoende uträkningar.
 */

import type { ProfitabilityInput } from "../types";

const DAY = 86_400_000;

function ms(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
}

function iso(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

function dim(month: string): number {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** round(n / d) med halva uppåt, för n ≥ 0, d > 0: golv((2n + d) / 2d). */
function round(n: bigint, d: bigint): bigint {
  if (n < 0n || d <= 0n) throw new Error("oracle: endast icke-negativa tal");
  return (2n * n + d) / (2n * d);
}

export interface OracleTotals {
  orders: number;
  pricedOrders: number;
  unpricedOrders: number;
  grossOre: number;
  vatOre: number;
  revenueOre: number;
  costOre: number;
  feesOre: number;
  commissionOre: number;
  rentOre: number;
  unallocatedRentOre: number;
  profitOre: number;
  unpricedRevenueOre: number;
  unpricedVatOre: number;
  unpricedFeesOre: number;
  unpricedCommissionOre: number;
  unpricedRentOre: number;
  totalRentOre: number;
}

/** Totaler räknade på enklaste möjliga sätt. */
export function oracleTotals(input: ProfitabilityInput): OracleTotals {
  const { period, settings } = input;
  const vatBp = BigInt(settings.vatRateBp);
  const feeBp = BigInt(settings.cardFeeBp);

  const priceOf = (titleId: string, date: string): number | null => {
    let best: { vf: string; c: number } | null = null;
    for (const p of input.prices) {
      if (p.titleId !== titleId || p.validFrom > date) continue;
      if (!best || p.validFrom > best.vf) best = { vf: p.validFrom, c: p.unitCostOre };
    }
    return best ? best.c : null;
  };
  const storeOf = (machineId: string | null, date: string): string | null => {
    if (machineId === null) return null;
    const hits = input.placements.filter(
      (p) => p.machineId === machineId && p.from <= date && (p.to === null || date <= p.to),
    );
    if (hits.length > 1) throw new Error("oracle: överlappande placeringar");
    return hits[0]?.storeId ?? null;
  };
  const agreementOf = (storeId: string, date: string) => {
    const hits = input.agreements.filter(
      (a) =>
        a.storeId === storeId && a.validFrom <= date && (a.validTo === null || date <= a.validTo),
    );
    if (hits.length > 1) throw new Error("oracle: överlappande avtal");
    return hits[0] ?? null;
  };

  interface Row {
    id: string;
    date: string;
    store: string | null;
    priced: boolean;
    gross: bigint;
    vat: bigint;
    net: bigint;
    cost: bigint;
    fee: bigint;
    commission: bigint;
    rent: bigint;
  }
  const rows: Row[] = [];
  for (const o of input.orders) {
    if (o.businessDate < period.start || o.businessDate > period.end) continue;
    const gross = BigInt(o.amountOre);
    const vat = round(gross * vatBp, 10_000n + vatBp);
    const net = gross - vat;
    const fee = round(gross * feeBp, 10_000n);
    const store = storeOf(o.machineId, o.businessDate);
    const ag = store === null ? null : agreementOf(store, o.businessDate);
    const commission = round(net * BigInt(ag?.commissionBp ?? 0), 10_000n);
    const cost = priceOf(o.titleId, o.businessDate);
    rows.push({
      id: o.id,
      date: o.businessDate,
      store,
      priced: cost !== null,
      gross,
      vat,
      net,
      cost: BigInt(cost ?? 0),
      fee,
      commission,
      rent: 0n,
    });
  }

  // Hyra dag för dag per butik och månad.
  const numerators = new Map<string, bigint>();
  const stores = new Set(input.agreements.map((a) => a.storeId));
  for (let t = ms(period.start); t <= ms(period.end); t += DAY) {
    const d = iso(t);
    for (const s of stores) {
      const ag = agreementOf(s, d);
      const rent = ag?.monthlyRentOre ?? 0;
      if (!rent) continue;
      const key = `${s}|${d.slice(0, 7)}`;
      numerators.set(key, (numerators.get(key) ?? 0n) + BigInt(rent));
    }
  }
  let totalRent = 0n;
  let unallocated = 0n;
  for (const [key, num] of numerators) {
    const [store, month] = key.split("|") as [string, string];
    const rent = round(num, BigInt(dim(month)));
    totalRent += rent;
    if (rent === 0n) continue;
    const list = rows
      .filter((r) => r.store === store && r.date.slice(0, 7) === month)
      .sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : a.id < b.id ? -1 : 1));
    if (list.length === 0) {
      unallocated += rent;
      continue;
    }
    let weights = list.map((r) => r.net);
    let wsum = weights.reduce((a, b) => a + b, 0n);
    if (wsum === 0n) {
      weights = list.map(() => 1n);
      wsum = BigInt(list.length);
    }
    const parts = weights.map((w, i) => ({ i, base: (rent * w) / wsum, rest: (rent * w) % wsum }));
    let left = rent - parts.reduce((a, p) => a + p.base, 0n);
    const order = [...parts].sort((a, b) =>
      a.rest !== b.rest ? (a.rest > b.rest ? -1 : 1) : a.i - b.i,
    );
    for (const p of order) {
      if (left === 0n) break;
      p.base += 1n;
      left -= 1n;
    }
    parts.forEach((p) => {
      list[p.i]!.rent = p.base;
    });
  }

  const sum = (f: (r: Row) => bigint, priced: boolean | null) =>
    Number(
      rows.filter((r) => priced === null || r.priced === priced).reduce((a, r) => a + f(r), 0n),
    );
  const revenue = sum((r) => r.net, true);
  const cost = sum((r) => r.cost, true);
  const fees = sum((r) => r.fee, true);
  const commission = sum((r) => r.commission, true);
  const rent = sum((r) => r.rent, true) + Number(unallocated);
  return {
    orders: rows.length,
    pricedOrders: rows.filter((r) => r.priced).length,
    unpricedOrders: rows.filter((r) => !r.priced).length,
    grossOre: sum((r) => r.gross, null),
    vatOre: sum((r) => r.vat, true),
    revenueOre: revenue,
    costOre: cost,
    feesOre: fees,
    commissionOre: commission,
    rentOre: rent,
    unallocatedRentOre: Number(unallocated),
    profitOre: revenue - cost - fees - commission - rent,
    unpricedRevenueOre: sum((r) => r.net, false),
    unpricedVatOre: sum((r) => r.vat, false),
    unpricedFeesOre: sum((r) => r.fee, false),
    unpricedCommissionOre: sum((r) => r.commission, false),
    unpricedRentOre: sum((r) => r.rent, false),
    totalRentOre: Number(totalRent),
  };
}
