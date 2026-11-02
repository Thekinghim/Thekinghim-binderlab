/**
 * Lagerplanen: inget saldo blir negativt, slutsaldona är rimliga (ett par
 * slut, några lågt, en titel slut i centrallagret) och planen är densamma
 * vid varje körning.
 */

import { describe, expect, it } from "vitest";

import { LOW_STOCK_PAIRS, SEED_MACHINES, SEED_TITLES, WAREHOUSE_RECEIPT } from "./catalog";
import { generateSeedOrders } from "./orders";
import { pairKey, planStock, type PlannedStockEvent } from "./stock";

const orders = generateSeedOrders();
const plan = planStock(orders);

/** Saldo per plats och titel över tid, med försäljningen från orderna. */
function simulate(events: readonly PlannedStockEvent[]): {
  min: number;
  final: Map<string, number>;
} {
  type Step = { ms: number; key: string; kind: string; quantity: number };
  const steps: Step[] = [
    ...events.map((e) => ({
      ms: e.occurredAtMs,
      key: `${e.location.kind === "warehouse" ? "C" : e.location.code}|${e.title}`,
      kind: e.kind,
      quantity: e.quantity,
    })),
    ...orders.map((o) => ({
      ms: o.paidAtMs,
      key: `${o.machineCode}|${o.title}`,
      kind: "sale",
      quantity: -1,
    })),
  ].sort((a, b) => a.ms - b.ms);
  const level = new Map<string, number>();
  let min = Infinity;
  for (const s of steps) {
    const next = s.kind === "count" ? s.quantity : (level.get(s.key) ?? 0) + s.quantity;
    level.set(s.key, next);
    min = Math.min(min, next);
  }
  return { min, final: level };
}

describe("planStock", () => {
  const { min, final } = simulate(plan.events);

  it("inget saldo blir någonsin negativt", () => {
    expect(min).toBe(0);
  });

  it("slutsaldona i planen stämmer med simuleringen", () => {
    for (const [key, value] of plan.machineLevels) {
      expect(final.get(key), key).toBe(value);
    }
    for (const [title, value] of plan.warehouseLevels) {
      expect(final.get(`C|${title}`), title).toBe(value);
    }
  });

  it("varje automat har inventering av alla titlar 12 okt", () => {
    const counts = plan.events.filter((e) => e.kind === "count" && e.location.kind === "machine");
    expect(counts).toHaveLength(SEED_MACHINES.length * SEED_TITLES.length);
    expect(
      counts.every((e) => new Date(e.occurredAtMs).toISOString().startsWith("2026-10-12")),
    ).toBe(true);
  });

  it("ett par tar slut med sin sista order, några är låga", () => {
    expect(plan.machineLevels.get(pairKey(plan.soldOut.machineCode, plan.soldOut.title))).toBe(0);
    expect(plan.low).toHaveLength(LOW_STOCK_PAIRS);
    for (const p of plan.low) {
      const level = plan.machineLevels.get(pairKey(p.machineCode, p.title)) ?? -1;
      expect(level).toBeGreaterThanOrEqual(1);
      expect(level).toBeLessThanOrEqual(2);
    }
    const zero = [...plan.machineLevels].filter(([, v]) => v === 0);
    expect(zero).toHaveLength(1);
    const others = [...plan.machineLevels].filter(([, v]) => v > 2).map(([, v]) => v);
    expect(Math.max(...others)).toBeLessThanOrEqual(15);
  });

  it("en titel är slut i centrallagret, 30th Celebration fick en ny leverans 27 okt", () => {
    expect([...plan.warehouseLevels].filter(([, v]) => v === 0).map(([t]) => t)).toEqual([
      "Prismatic Evolution",
    ]);
    const receipts = plan.events.filter((e) => e.kind === "receipt");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.title).toBe(WAREHOUSE_RECEIPT.title);
    expect(receipts[0]?.quantity).toBeGreaterThanOrEqual(WAREHOUSE_RECEIPT.minQuantity);
    expect(new Date(receipts[0]?.occurredAtMs ?? 0).toISOString()).toBe("2026-10-27T07:30:00.000Z");
  });

  it("varje påfyllning har ett lika stort uttag ur centrallagret vid samma tid", () => {
    const refills = plan.events.filter((e) => e.kind === "refill");
    const withdrawals = plan.events.filter((e) => e.kind === "adjustment");
    expect(refills.length).toBeGreaterThan(50);
    expect(withdrawals).toHaveLength(refills.length);
    const sum = (list: PlannedStockEvent[]) => list.reduce((n, e) => n + e.quantity, 0);
    expect(sum(withdrawals)).toBe(-sum(refills));
    for (const r of refills) {
      expect(r.quantity).toBeGreaterThan(0);
      expect(
        withdrawals.some(
          (w) =>
            w.occurredAtMs === r.occurredAtMs && w.title === r.title && w.quantity === -r.quantity,
        ),
      ).toBe(true);
    }
  });

  it("är deterministisk", () => {
    expect(planStock(generateSeedOrders())).toEqual(plan);
  });
});
