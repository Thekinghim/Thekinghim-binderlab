/**
 * Prestanda: ett år med 100 000 order, 20 automater, 30 titlar och prisändringar.
 * Kontrollerar att alla sex vyer räknas på rimlig tid och att totalerna stämmer.
 */

import { describe, expect, it } from "vitest";
import { addDays } from "./dates";
import { profitabilityViews } from "./profitability";
import { agreement, placement, price, rng } from "./testing/fixtures";
import type { OrderLine, ProfitabilityInput } from "./types";

function bigYear(): ProfitabilityInput {
  const r = rng(2026);
  const titles = Array.from({ length: 30 }, (_, i) => `t-${i}`);
  const machines = Array.from({ length: 20 }, (_, i) => `m-${i}`);
  const stores = Array.from({ length: 12 }, (_, i) => `s-${i}`);
  const prices = titles.flatMap((t, i) =>
    i % 10 === 9
      ? []
      : [price(t, 1800 + i * 10, "2025-06-01"), price(t, 2000 + i * 10, "2026-07-01")],
  );
  const agreements = stores.flatMap((s, i) => [
    agreement(s, "2025-01-01", "2026-05-14", { commissionBp: 1000 + i * 50 }),
    agreement(s, "2026-05-15", null, { commissionBp: 1200, monthlyRentOre: 50_000 + i * 1000 }),
  ]);
  const placements = machines.flatMap((m, i) => [
    placement(m, stores[i % stores.length]!, "2025-01-01", "2026-08-31"),
    placement(m, stores[(i + 5) % stores.length]!, "2026-09-01", null),
  ]);
  const orders: OrderLine[] = [];
  for (let i = 0; i < 100_000; i++) {
    orders.push({
      id: `o-${i}`,
      externalId: String(i),
      titleId: r.pick(titles),
      machineId: r.pick(machines),
      businessDate: addDays("2026-01-01", r.int(0, 364)),
      amountOre: r.pick([4900, 5900, 12_900]),
    });
  }
  return {
    orders,
    prices,
    agreements,
    placements,
    settings: { vatRateBp: 0, cardFeeBp: 0 },
    period: { start: "2026-01-01", end: "2026-12-31" },
  };
}

describe("prestanda", () => {
  it("100 000 order, sex vyer", () => {
    const input = bigYear();
    const t0 = performance.now();
    const views = profitabilityViews(input, ["title", "machine", "store", "day", "week", "month"]);
    const ms = performance.now() - t0;
    console.info(`profitabilityViews: 100 000 order, 6 vyer på ${Math.round(ms)} ms`);
    expect(views.title.totals.orders).toBe(100_000);
    expect(views.month.rows).toHaveLength(12);
    expect(views.week.totals).toEqual(views.title.totals);
    expect(ms).toBeLessThan(15_000);
  }, 60_000);
});
