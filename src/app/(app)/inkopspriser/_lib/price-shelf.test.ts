import { describe, expect, it } from "vitest";

import type { TitleRow } from "./model";
import { shelfPriceOrder, shelfPriceState } from "./price-shelf";

const row = (id: string, over: Partial<TitleRow> = {}): TitleRow =>
  ({
    id,
    name: id.toUpperCase(),
    series: null,
    archived: false,
    currentCostOre: 9_000,
    currentFrom: "2026-01-01",
    customerPriceOre: 14_900,
    orders: 10,
    unpricedOrders: 0,
    unpricedRevenueOre: 0,
    unpricedFirstDate: null,
    status: "ok",
    own: false,
    ...over,
  }) as TitleRow;

describe("Inköpspriser som hylla", () => {
  it("saknar pris: inget pris eller order utan pris", () => {
    expect(shelfPriceState(row("a")).missing).toBe(false);
    expect(shelfPriceState(row("b", { status: "missing", currentCostOre: null }))).toEqual({
      missing: true,
      note: "Inget pris",
    });
    expect(shelfPriceState(row("c", { status: "missing", own: true })).note).toBe("Egen, ny");
    expect(shelfPriceState(row("d", { unpricedOrders: 41 })).note).toBe("41 order utan vinst");
  });

  it("ordning: saknar pris först (flest order), sedan flest order, arkiverade sist", () => {
    const rows = [
      row("few", { orders: 2 }),
      row("old", { archived: true, orders: 0 }),
      row("miss1", { status: "missing", unpricedOrders: 3 }),
      row("many", { orders: 90 }),
      row("miss2", { unpricedOrders: 41 }),
    ];
    expect(shelfPriceOrder(rows).map((r) => r.id)).toEqual([
      "miss2",
      "miss1",
      "many",
      "few",
      "old",
    ]);
  });
});
