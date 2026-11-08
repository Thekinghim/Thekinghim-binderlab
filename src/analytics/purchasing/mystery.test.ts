/** Inköp/Vårt lager: mystery packs packas i hela omgångar. */
import { describe, expect, it } from "vitest";

import { purchasePlan, purchaseQtyByTitle } from "./plan";
import type { PurchasingInput } from "./types";

function input(perDayMilli: number, mysteryBatchSize: number | null): PurchasingInput {
  return {
    today: "2026-11-02",
    titles: [{ id: "MP", name: "Mystery Pack Plus", mysteryBatchSize }],
    suppliers: [],
    supplierItems: [],
    warehouseStock: [{ titleId: "MP", onHand: 0 }],
    machineStock: [],
    openPurchaseOrders: [],
    demand: [{ titleId: "MP", dailyMilli: new Array(28).fill(perDayMilli), dayVarianceMilli2: 0 }],
  };
}

describe("inköpsplanen: mystery packs", () => {
  it("antalet att packa avrundas uppåt till hela omgångar", () => {
    // 0,5 pack/dag × 14 dagar (ledtid 7 + intervall 7) = 7 pack saknas → en omgång (14).
    const plain = purchasePlan(input(500, null));
    expect(purchaseQtyByTitle(plain).get("MP")).toBe(7);
    const mystery = purchasePlan(input(500, 14));
    expect(purchaseQtyByTitle(mystery).get("MP")).toBe(14);
    // 1,5 pack/dag × 14 = 21 → två omgångar (28).
    expect(purchaseQtyByTitle(purchasePlan(input(1_500, 14))).get("MP")).toBe(28);
  });

  it("inget saknas: inget att packa", () => {
    expect(purchaseQtyByTitle(purchasePlan(input(0, 14))).has("MP")).toBe(false);
  });
});
