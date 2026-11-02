/**
 * Historik per befintlig butik: lönsamhet och automatdagar under en period.
 *
 * Lönsamheten kommer från domänens vy per butik (`profitability(…, 'store')`), så
 * siffrorna är exakt desamma som i panelen. Automatdagar räknas från placeringarna:
 * för varje placering räknas dagarna som ligger i perioden (båda ändar inräknade).
 * En butik där en automat stått utan att sälja får alltså automatdagar men ingen intäkt,
 * och drar ned snittet, som den ska.
 */

import {
  addDays,
  assertPeriod,
  intersectPeriods,
  NO_STORE_KEY,
  periodDays,
  profitability,
  ratioBp,
  type IsoDate,
  type ProfitabilityInput,
  type ProfitabilityRow,
} from "@/domain";
import type { SiteHistory } from "./types";

interface Acc {
  machineIds: Set<string>;
  machineDays: number;
  firstDay: IsoDate | null;
  lastDay: IsoDate | null;
}

/**
 * Historik per butik under `input.period`, sorterad på butikens id. Med kommer varje
 * butik som haft en automat placerad i perioden eller som har en rad i lönsamhetsvyn.
 * Order utan butik (automat utan placering) hör inte till någon plats och räknas inte.
 */
export function siteHistories(input: ProfitabilityInput): SiteHistory[] {
  assertPeriod(input.period);
  const { period } = input;
  const result = profitability(input, "store");

  const acc = new Map<string, Acc>();
  const get = (storeId: string): Acc => {
    let a = acc.get(storeId);
    if (!a) {
      a = { machineIds: new Set(), machineDays: 0, firstDay: null, lastDay: null };
      acc.set(storeId, a);
    }
    return a;
  };

  for (const p of input.placements) {
    // Placeringen som period; öppet slut kortas till periodens slut.
    const end = p.to ?? (p.from > period.end ? p.from : period.end);
    if (end < p.from) continue;
    const overlap = intersectPeriods(period, { start: p.from, end });
    if (!overlap) continue;
    const a = get(p.storeId);
    a.machineIds.add(p.machineId);
    a.machineDays += periodDays(overlap);
    if (a.firstDay === null || overlap.start < a.firstDay) a.firstDay = overlap.start;
    if (a.lastDay === null || overlap.end > a.lastDay) a.lastDay = overlap.end;
  }

  const rows = new Map<string, ProfitabilityRow>();
  for (const r of result.rows) {
    if (r.kind !== "item" || r.key === NO_STORE_KEY) continue;
    rows.set(r.key, r);
    get(r.key);
  }

  const out: SiteHistory[] = [];
  for (const storeId of [...acc.keys()].sort()) {
    const a = acc.get(storeId)!;
    const r = rows.get(storeId);
    const revenue = r?.revenueOre ?? 0;
    const unpricedRevenue = r?.unpricedRevenueOre ?? 0;
    const cost = r?.costOre ?? 0;
    const fees = r?.feesOre ?? 0;
    out.push({
      storeId,
      period,
      machineIds: [...a.machineIds].sort(),
      machineDays: a.machineDays,
      firstDay: a.firstDay,
      lastDay: a.lastDay,
      orders: r?.orders ?? 0,
      unpricedOrders: r?.unpricedOrders ?? 0,
      revenueOre: revenue,
      unpricedRevenueOre: unpricedRevenue,
      unpricedShareBp: ratioBp(unpricedRevenue, revenue + unpricedRevenue),
      costOre: cost,
      feesOre: fees,
      commissionOre: r?.commissionOre ?? 0,
      rentOre: r?.rentOre ?? 0,
      contributionOre: revenue - cost - fees,
      profitOre: r?.profitOre ?? 0,
    });
  }
  return out;
}

/** Fönster av `days` hela dagar som slutar `asOf` (inklusive): (2026-11-28, 28) → 1–28 nov. */
export function windowEnding(asOf: IsoDate, days: number): { start: IsoDate; end: IsoDate } {
  return { start: addDays(asOf, -(days - 1)), end: asOf };
}
