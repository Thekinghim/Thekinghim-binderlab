import { describe, expect, it } from "vitest";

import type { WarehouseRow } from "../../lager/_lib/types";
import { ourStockAside, ourStockTitle } from "./our-stock";

const row = (over: Partial<WarehouseRow>): WarehouseRow => ({
  titleId: "t",
  onHand: 10,
  perDayTenths: 10,
  daysLeft: 10,
  weekNeed: 0,
  shortBy: 0,
  status: "ok",
  lastCountedAt: null,
  ...over,
});

describe("Vårt lager: rubriken", () => {
  it("summerar pack hemma (negativt räknas som 0)", () => {
    expect(ourStockTitle([row({ onHand: 12 }), row({ onHand: -3 })])).toBe("12 pack hemma.");
  });

  it("säger bara det som kräver något", () => {
    expect(ourStockAside([row({})])).toBe("Räcker till veckans besök.");
    expect(ourStockAside([row({ status: "low", shortBy: 2 }), row({ status: "low" })])).toBe(
      "1 titel räcker inte till veckans besök.",
    );
    expect(ourStockAside([row({ status: "low" }), row({ status: "critical" })])).toBe(
      "2 titlar räcker kortare än 7 dagar.",
    );
  });
});
