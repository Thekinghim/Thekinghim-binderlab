/**
 * Hjälp för tester i src/domain: seedad slump, byggare och slumpade scenarier.
 * Används bara av testerna.
 */

import { addDays } from "../dates";
import type {
  OrderLine,
  Period,
  Placement,
  ProfitabilityInput,
  PurchasePrice,
  Settings,
  StoreAgreement,
} from "../types";

/** Deterministisk slump (mulberry32). */
export interface Rng {
  next(): number;
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
  shuffle<T>(items: readonly T[]): T[];
}

export function rng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  return {
    next,
    int,
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("pick från tom lista");
      return items[int(0, items.length - 1)]!;
    },
    chance: (p: number) => next() < p,
    shuffle: <T>(items: readonly T[]): T[] => {
      const out = [...items];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}

export const NO_TAX: Settings = { vatRateBp: 0, cardFeeBp: 0 };

let seq = 0;

/** Bygger en order. Id och ordernummer genereras om de saknas. */
export function order(
  p: Partial<OrderLine> & Pick<OrderLine, "businessDate"> & { titleId?: string },
): OrderLine {
  seq++;
  const n = String(seq).padStart(6, "0");
  return {
    id: p.id ?? `o-${n}`,
    externalId: p.externalId ?? n,
    titleId: p.titleId ?? "t-a",
    machineId: p.machineId === undefined ? "m-1" : p.machineId,
    businessDate: p.businessDate,
    amountOre: p.amountOre ?? 4900,
  };
}

/** Ett pris. */
export function price(titleId: string, unitCostOre: number, validFrom: string): PurchasePrice {
  return { titleId, unitCostOre, validFrom };
}

/** Ett avtal. */
export function agreement(
  storeId: string,
  validFrom: string,
  validTo: string | null,
  terms: {
    commissionBp?: number | null;
    monthlyRentOre?: number | null;
    commissionBase?: StoreAgreement["commissionBase"];
    lossTreatment?: StoreAgreement["lossTreatment"];
  },
): StoreAgreement {
  return {
    storeId,
    validFrom,
    validTo,
    commissionBp: terms.commissionBp ?? null,
    monthlyRentOre: terms.monthlyRentOre ?? null,
    ...(terms.commissionBase ? { commissionBase: terms.commissionBase } : {}),
    ...(terms.lossTreatment ? { lossTreatment: terms.lossTreatment } : {}),
  };
}

/** En placering. */
export function placement(
  machineId: string,
  storeId: string,
  from: string,
  to: string | null,
): Placement {
  return { machineId, storeId, from, to };
}

/** Icke-överlappande segment från `start`, med luckor ibland. */
function segments(
  r: Rng,
  start: string,
  count: number,
): Array<{ from: string; to: string | null }> {
  const out: Array<{ from: string; to: string | null }> = [];
  let from = start;
  for (let i = 0; i < count; i++) {
    const len = r.int(1, 75);
    const last = i === count - 1;
    const to = last && r.chance(0.4) ? null : addDays(from, len - 1);
    out.push({ from, to });
    if (to === null) break;
    from = addDays(to, r.chance(0.5) ? 1 : r.int(2, 25));
  }
  return out;
}

/** Ett slumpat men deterministiskt scenario för avstämningstester. */
export function randomScenario(seed: number): ProfitabilityInput {
  const r = rng(seed);
  const year = r.int(2024, 2027);
  const startDay = addDays(`${year}-01-01`, r.int(0, 364));
  const length = r.pick([1, 7, 28, 30, 31, r.int(1, 120), r.int(1, 120)]);
  const period: Period = { start: startDay, end: addDays(startDay, length - 1) };

  const titles = Array.from({ length: r.int(1, 8) }, (_, i) => `t-${i + 1}`);
  const stores = Array.from({ length: r.int(1, 5) }, (_, i) => `s-${i + 1}`);
  const machines = Array.from({ length: r.int(1, 6) }, (_, i) => `m-${i + 1}`);

  const prices: PurchasePrice[] = [];
  for (const t of titles) {
    if (r.chance(0.2)) continue; // titel utan pris
    const used = new Set<string>();
    const count = r.int(1, 3);
    for (let i = 0; i < count; i++) {
      const vf = addDays(period.start, r.int(-60, length + 5));
      if (used.has(vf)) continue;
      used.add(vf);
      prices.push(price(t, r.pick([0, 1500, 2000, 2499, 2500, 3100, r.int(1, 600_000)]), vf));
    }
  }

  const agreements: StoreAgreement[] = [];
  for (const s of stores) {
    if (r.chance(0.1)) continue; // butik utan avtal
    const segs = segments(r, addDays(period.start, -r.int(0, 60)), r.int(1, 4));
    for (const seg of segs) {
      const kind = r.pick(["commission", "rent", "both", "both", "neither"] as const);
      agreements.push(
        agreement(s, seg.from, seg.to, {
          commissionBp:
            kind === "commission" || kind === "both"
              ? r.pick([0, 500, 1000, 1500, 2000, 2500, r.int(0, 10_000)])
              : null,
          monthlyRentOre:
            kind === "rent" || kind === "both"
              ? r.pick([0, 50_000, 75_000, 99_999, 100_000, r.int(1, 1_000_000)])
              : null,
        }),
      );
    }
  }

  const placements: Placement[] = [];
  for (const m of machines) {
    if (r.chance(0.1)) continue; // automat utan placering
    const segs = segments(r, addDays(period.start, -r.int(0, 30)), r.int(1, 4));
    for (const seg of segs) placements.push(placement(m, r.pick(stores), seg.from, seg.to));
  }

  const orderCount = r.pick([0, r.int(1, 20), r.int(1, 300), r.int(100, 400)]);
  const orders: OrderLine[] = [];
  const machinePool = [...machines, "m-ghost"];
  for (let i = 0; i < orderCount; i++) {
    const big = r.chance(0.02);
    orders.push({
      id: `o-${seed}-${String(i).padStart(4, "0")}`,
      externalId: String(40000 + i),
      titleId: r.chance(0.05) ? "t-unknown" : r.pick(titles),
      machineId: r.chance(0.08) ? null : r.pick(machinePool),
      businessDate: addDays(period.start, r.int(-3, length + 2)),
      amountOre: big
        ? r.int(1, 1_000_000_000)
        : r.pick([0, 1, 99, 4900, 4900, 5900, 12_900, r.int(1, 2_000_000)]),
    });
  }

  const settings: Settings = {
    vatRateBp: r.pick([0, 0, 600, 1200, 2500, r.int(0, 10_000)]),
    cardFeeBp: r.pick([0, 0, 250, r.int(0, 1000)]),
  };

  return { orders, prices, agreements, placements, settings, period };
}
