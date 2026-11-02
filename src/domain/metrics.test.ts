import { describe, expect, it } from "vitest";
import {
  averageOrderValueOre,
  cardFees,
  changeBp,
  costOfGoods,
  grossRevenue,
  keyMetrics,
  marginBp,
  orderCount,
  profit,
  revenue,
  storeCompensation,
  topContributor,
  vat,
} from "./metrics";
import { profitability } from "./profitability";
import { agreement, NO_TAX, order, placement, price } from "./testing/fixtures";
import type { ProfitabilityInput } from "./types";

const orders = [
  order({ businessDate: "2026-11-01", amountOre: 4900 }),
  order({ businessDate: "2026-11-02", amountOre: 4900 }),
  order({ businessDate: "2026-11-03", amountOre: 5900 }),
];

describe("nyckeltal", () => {
  it("intäkt, moms, avgifter, antal och snittorder", () => {
    expect(grossRevenue(orders)).toBe(15_700);
    expect(revenue(orders, NO_TAX)).toBe(15_700);
    expect(orderCount(orders)).toBe(3);
    expect(averageOrderValueOre(orders, NO_TAX)).toBe(5233); // 5 233,33
    const s = { vatRateBp: 2500, cardFeeBp: 250 };
    expect(vat(orders, s)).toBe(980 + 980 + 1180);
    expect(revenue(orders, s)).toBe(15_700 - 3140);
    expect(cardFees(orders, s)).toBe(123 + 123 + 148);
    expect(averageOrderValueOre([], NO_TAX)).toBeNull();
  });

  it("marginal och förändring", () => {
    expect(marginBp(7_660, 30_400)).toBe(2_520);
    expect(marginBp(-100, 1_000)).toBe(-1_000);
    expect(marginBp(1, 0)).toBeNull();
    expect(changeBp(110, 100)).toBe(1_000);
    expect(changeBp(90, 100)).toBe(-1_000);
    expect(changeBp(-50, -100)).toBe(5_000);
    expect(changeBp(5, 0)).toBeNull();
  });
});

describe("sammandrag", () => {
  const input: ProfitabilityInput = {
    orders: [...orders, order({ titleId: "t-x", businessDate: "2026-11-04", amountOre: 10_000 })],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [
      agreement("s-1", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 30_000 }),
    ],
    placements: [placement("m-1", "s-1", "2026-01-01", null)],
    settings: NO_TAX,
    period: { start: "2026-11-01", end: "2026-11-30" },
  };

  it("keyMetrics stämmer med lönsamheten", () => {
    const t = profitability(input, "title");
    expect(keyMetrics(input)).toEqual({
      revenueOre: 25_700,
      orderCount: 4,
      averageOrderValueOre: 6425,
      profitOre: t.totals.profitOre,
      marginBp: t.totals.marginBp,
      unpricedShareBp: 3891, // 10 000 / 25 700
    });
    expect(profit(input)).toEqual({ profitOre: t.totals.profitOre, marginBp: t.totals.marginBp });
  });

  it("costOfGoods redovisar täckning", () => {
    expect(costOfGoods(input)).toEqual({
      costOre: 6000,
      pricedOrders: 3,
      unpricedOrders: 1,
      coverageBp: 7500,
      unpricedTitleIds: ["t-x"],
    });
  });

  it("storeCompensation tar med alla order, även de utan pris", () => {
    expect(storeCompensation(input)).toEqual({
      stores: [{ storeId: "s-1", commissionOre: 2570, rentOre: 30_000, totalOre: 32_570 }],
      commissionOre: 2570,
      rentOre: 30_000,
      totalOre: 32_570,
    });
  });
});

describe("topContributor", () => {
  const input: ProfitabilityInput = {
    orders: [
      order({ machineId: "m-1", businessDate: "2026-11-01", amountOre: 10_000 }),
      order({ machineId: "m-1", businessDate: "2026-11-02", amountOre: 10_000 }),
      order({ machineId: "m-2", businessDate: "2026-11-03", amountOre: 10_000 }),
      order({ machineId: "m-3", businessDate: "2026-11-03", amountOre: 10_000 }),
    ],
    prices: [price("t-a", 4000, "2026-01-01")],
    agreements: [],
    placements: [],
    settings: NO_TAX,
    period: { start: "2026-11-01", end: "2026-11-30" },
  };

  it("automaten med störst vinst och dess andel", () => {
    // Vinst 6 000 per order: m-1 12 000 av 24 000 = 50 %; marginal 60 %
    const r = profitability(input, "machine");
    expect(r.totals.marginBp).toBe(6000);
    expect(topContributor(r)).toEqual({ key: "m-1", profitOre: 12_000, shareOfProfitBp: 5000 });
  });

  it("ingen andel när vinsten är ≤ 0, null utan prissatta order", () => {
    const loss = profitability(
      { ...input, prices: [price("t-a", 20_000, "2026-01-01")] },
      "machine",
    );
    expect(topContributor(loss)?.shareOfProfitBp).toBeNull();
    expect(topContributor(profitability({ ...input, prices: [] }, "machine"))).toBeNull();
  });
});
