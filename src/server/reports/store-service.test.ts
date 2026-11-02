import { describe, expect, it } from "vitest";

import { busiestWindow, MIN_ORDERS, refillSummary } from "./store-service";

describe("busiestWindow", () => {
  it("väljer veckodagen med flest köp och tretimmarsfönstret inom den (svensk tid)", () => {
    // Lördag 24 okt. 2026: 12 köp 13–15 svensk tid (11–13 UTC), plus spridda köp på tisdagar.
    const sat = Array.from(
      { length: 12 },
      (_, i) => `2026-10-24T${String(11 + (i % 3)).padStart(2, "0")}:10:00Z`,
    );
    const tue = Array.from(
      { length: 9 },
      (_, i) => `2026-10-20T${String(7 + i).padStart(2, "0")}:00:00Z`,
    );
    expect(busiestWindow([...sat, ...tue], "Europe/Stockholm")).toEqual({
      text: "Lördagar 13–16",
      orders: 21,
    });
  });

  it("ger inget svar under minsta antalet köp", () => {
    const few = Array.from({ length: MIN_ORDERS - 1 }, () => "2026-10-24T11:00:00Z");
    expect(busiestWindow(few, "Europe/Stockholm")).toEqual({ text: null, orders: MIN_ORDERS - 1 });
  });

  it("hoppar över ogiltiga tider", () => {
    expect(busiestWindow(["inte en tid"], "Europe/Stockholm").orders).toBe(0);
  });
});

describe("refillSummary", () => {
  it("räknar påfyllningar och senaste dagen", () => {
    expect(refillSummary(["2026-10-03", "2026-10-30", "2026-10-12"])).toEqual({
      count: 3,
      last: "2026-10-30",
    });
    expect(refillSummary([])).toEqual({ count: 0, last: null });
  });

  it("räknar besök (dagar), inte en rad per titel", () => {
    expect(refillSummary(["2026-10-10", "2026-10-10", "2026-10-20", "2026-10-20"])).toEqual({
      count: 2,
      last: "2026-10-20",
    });
  });
});
