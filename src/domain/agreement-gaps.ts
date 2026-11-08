/**
 * Dagar utan avtal: dagar då en automat stod i en butik men inget butiksavtal gällde.
 * Butiken räknas då som 0 % (ledger.ts ger ingen provision och ingen hyra de dagarna), så
 * panelen varnar för dem (Butiker, butikens sida, Att göra, avräkningen, Daglig kontroll).
 *
 *   dag utan avtal = minst en placering i butiken täcker dagen och agreementOn(...) = null
 *
 * Samma uppslag som beräkningarna (AgreementIndex), så att varningen och beloppen aldrig
 * säger olika saker. Ett avtal utan andel och hyra är ett avtal (medvetet 0 kr).
 */

import { addDays, toDayNumber } from "./dates";
import { AgreementIndex } from "./placements";
import type { IsoDate, Period, Placement, StoreAgreement } from "./types";

/** En butiks dagar utan avtal i perioden. */
export interface AgreementGap {
  readonly storeId: string;
  /** Dagar i perioden då en automat stod i butiken utan att något avtal gällde. */
  readonly days: number;
  /** Dagar i perioden då en automat stod i butiken (med eller utan avtal). */
  readonly placedDays: number;
  /** Sammanhängande följder av dagar utan avtal, äldst först. */
  readonly ranges: readonly Period[];
  /** Automaterna som stod i butiken någon av dagarna utan avtal, sorterade. */
  readonly machineIds: readonly string[];
}

/**
 * Butikerna som hade en automat men inget avtal någon dag i perioden (bara de med minst
 * en sådan dag), sorterade på butik. `storeIds` begränsar till de butikerna.
 */
export function agreementGaps(input: {
  readonly placements: readonly Placement[];
  readonly agreements: readonly StoreAgreement[] | AgreementIndex;
  readonly period: Period;
  readonly storeIds?: readonly string[];
}): AgreementGap[] {
  const { period } = input;
  if (period.end < period.start) return [];
  const index =
    input.agreements instanceof AgreementIndex
      ? input.agreements
      : new AgreementIndex(input.agreements);
  const only = input.storeIds ? new Set(input.storeIds) : null;
  const byStore = new Map<string, Placement[]>();
  for (const p of input.placements) {
    if (only && !only.has(p.storeId)) continue;
    if (p.from > period.end || (p.to !== null && p.to < period.start)) continue;
    const list = byStore.get(p.storeId);
    if (list) list.push(p);
    else byStore.set(p.storeId, [p]);
  }
  const out: AgreementGap[] = [];
  const total = toDayNumber(period.end) - toDayNumber(period.start) + 1;
  for (const [storeId, list] of byStore) {
    let placedDays = 0;
    let days = 0;
    const ranges: { start: IsoDate; end: IsoDate }[] = [];
    const machines = new Set<string>();
    let open: { start: IsoDate; end: IsoDate } | null = null;
    let day = period.start;
    for (let i = 0; i < total; i++, day = addDays(day, 1)) {
      const here = list.filter((p) => p.from <= day && (p.to === null || p.to >= day));
      const gap = here.length > 0 && index.agreementOn(storeId, day) === null;
      if (here.length > 0) placedDays += 1;
      if (gap) {
        days += 1;
        for (const p of here) machines.add(p.machineId);
        if (open) open.end = day;
        else open = { start: day, end: day };
      } else if (open) {
        ranges.push(open);
        open = null;
      }
    }
    if (open) ranges.push(open);
    if (days > 0) {
      out.push({ storeId, days, placedDays, ranges, machineIds: [...machines].sort() });
    }
  }
  return out.sort((a, b) => (a.storeId < b.storeId ? -1 : a.storeId > b.storeId ? 1 : 0));
}
