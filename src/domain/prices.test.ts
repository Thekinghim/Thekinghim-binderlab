import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { agreementOn, storeOn } from "./placements";
import { applyPriceChange, priceChangeImpact, priceHistory, PriceIndex, priceOn } from "./prices";
import { agreement, order, placement, price } from "./testing/fixtures";

const prices = [
  price("t-a", 2500, "2026-10-16"), // osorterat med flit
  price("t-a", 2000, "2026-09-01"),
  price("t-a", 2200, "2026-11-01"),
  price("t-b", 1500, "2026-01-01"),
];

describe("priceOn", () => {
  it("senaste validFrom ≤ datum", () => {
    expect(priceOn(prices, "t-a", "2026-08-31")).toBeNull();
    expect(priceOn(prices, "t-a", "2026-09-01")?.unitCostOre).toBe(2000);
    expect(priceOn(prices, "t-a", "2026-10-15")?.unitCostOre).toBe(2000);
    expect(priceOn(prices, "t-a", "2026-10-16")?.unitCostOre).toBe(2500);
    expect(priceOn(prices, "t-a", "2026-10-31")?.unitCostOre).toBe(2500);
    expect(priceOn(prices, "t-a", "2030-01-01")?.unitCostOre).toBe(2200);
    expect(priceOn(prices, "t-okand", "2026-10-16")).toBeNull();
  });

  it("index och lista ger samma svar", () => {
    const index = new PriceIndex(prices);
    for (const d of ["2026-08-31", "2026-09-01", "2026-10-15", "2026-10-16", "2026-11-01"]) {
      expect(index.priceOn("t-a", d)).toEqual(priceOn(prices, "t-a", d));
    }
  });

  it("två priser samma dag för samma titel kastar", () => {
    expect(
      () => new PriceIndex([price("t-a", 1, "2026-01-01"), price("t-a", 2, "2026-01-01")]),
    ).toThrow(expect.objectContaining({ code: "duplicate_price" }));
  });

  it("negativt eller decimalt pris kastar", () => {
    expect(() => new PriceIndex([price("t-a", -1, "2026-01-01")])).toThrow(DomainError);
    expect(() => new PriceIndex([price("t-a", 20.5, "2026-01-01")])).toThrow(DomainError);
  });
});

describe("priceHistory", () => {
  it("senaste först med giltig till", () => {
    expect(priceHistory(prices, "t-a")).toEqual([
      { titleId: "t-a", unitCostOre: 2200, validFrom: "2026-11-01", validTo: null },
      { titleId: "t-a", unitCostOre: 2500, validFrom: "2026-10-16", validTo: "2026-10-31" },
      { titleId: "t-a", unitCostOre: 2000, validFrom: "2026-09-01", validTo: "2026-10-15" },
    ]);
    expect(priceHistory(prices, "t-x")).toEqual([]);
  });
});

describe("priceChangeImpact", () => {
  const orders = [
    order({ titleId: "t-a", businessDate: "2026-08-20" }), // saknar pris
    order({ titleId: "t-a", businessDate: "2026-09-10" }),
    order({ titleId: "t-a", businessDate: "2026-10-20" }),
    order({ titleId: "t-a", businessDate: "2026-10-25" }),
    order({ titleId: "t-b", businessDate: "2026-10-25" }),
  ];

  it("nytt pris mitt i perioden påverkar bara order från och med datumet", () => {
    const impact = priceChangeImpact({
      orders,
      prices,
      change: { kind: "upsert", price: price("t-a", 2600, "2026-10-22") },
      closedMonths: ["2026-09"],
    });
    expect(impact).toMatchObject({
      affectedOrders: 1,
      firstDate: "2026-10-25",
      lastDate: "2026-10-25",
      costBeforeOre: 2500,
      costAfterOre: 2600,
      costDeltaOre: 100,
      closedMonthsAffected: [],
    });
  });

  it("pris bakåt i tiden ger order pris, och stängd månad flaggas", () => {
    const impact = priceChangeImpact({
      orders,
      prices,
      change: { kind: "upsert", price: price("t-a", 1900, "2026-08-01") },
      closedMonths: ["2026-08", "2026-09"],
    });
    expect(impact).toMatchObject({
      affectedOrders: 1,
      ordersGainingPrice: 1,
      costDeltaOre: 1900,
      closedMonthsAffected: ["2026-08"],
    });
  });

  it("ändrat belopp på befintligt datum och borttaget pris", () => {
    const changed = priceChangeImpact({
      orders,
      prices,
      change: { kind: "upsert", price: price("t-a", 2100, "2026-09-01") },
    });
    expect(changed).toMatchObject({ affectedOrders: 1, costDeltaOre: 100 });
    const removed = priceChangeImpact({
      orders,
      prices,
      change: { kind: "remove", titleId: "t-a", validFrom: "2026-09-01" },
    });
    expect(removed).toMatchObject({ affectedOrders: 1, ordersLosingPrice: 1, costDeltaOre: -2000 });
    expect(
      applyPriceChange(prices, { kind: "remove", titleId: "t-a", validFrom: "2026-09-01" }),
    ).toHaveLength(3);
  });
});

describe("storeOn och agreementOn", () => {
  const placements = [
    placement("m-1", "s-1", "2026-10-01", "2026-10-15"),
    placement("m-1", "s-2", "2026-10-16", null),
    placement("m-2", "s-1", "2026-10-05", "2026-10-10"),
  ];

  it("automat som flyttar mitt i perioden", () => {
    expect(storeOn(placements, "m-1", "2026-09-30")).toBeNull();
    expect(storeOn(placements, "m-1", "2026-10-01")).toBe("s-1");
    expect(storeOn(placements, "m-1", "2026-10-15")).toBe("s-1");
    expect(storeOn(placements, "m-1", "2026-10-16")).toBe("s-2");
    expect(storeOn(placements, "m-1", "2027-06-01")).toBe("s-2");
    expect(storeOn(placements, "m-2", "2026-10-11")).toBeNull();
    expect(storeOn(placements, null, "2026-10-11")).toBeNull();
    expect(storeOn(placements, "m-x", "2026-10-11")).toBeNull();
  });

  it("överlappande placeringar kastar", () => {
    expect(() =>
      storeOn(
        [
          placement("m-1", "s-1", "2026-10-01", "2026-10-15"),
          placement("m-1", "s-2", "2026-10-15", null),
        ],
        "m-1",
        "2026-10-01",
      ),
    ).toThrow(expect.objectContaining({ code: "overlapping_placement" }));
    expect(() =>
      storeOn(
        [placement("m-1", "s-1", "2026-10-01", null), placement("m-1", "s-2", "2026-12-01", null)],
        "m-1",
        "2026-10-01",
      ),
    ).toThrow(DomainError);
  });

  it("avtal som byts mitt i månaden", () => {
    const agreements = [
      agreement("s-1", "2026-01-01", "2026-10-15", { commissionBp: 1000 }),
      agreement("s-1", "2026-10-16", null, { commissionBp: 1500, monthlyRentOre: 50_000 }),
    ];
    expect(agreementOn(agreements, "s-1", "2026-10-15")?.commissionBp).toBe(1000);
    expect(agreementOn(agreements, "s-1", "2026-10-16")?.commissionBp).toBe(1500);
    expect(agreementOn(agreements, "s-1", "2025-12-31")).toBeNull();
    expect(() =>
      agreementOn(
        [agreement("s-1", "2026-01-10", "2026-01-01", { commissionBp: 1 })],
        "s-1",
        "2026-01-01",
      ),
    ).toThrow(DomainError);
  });
});
