import { describe, expect, it } from "vitest";

import { median, perDayList, type PerDayInput } from "./per-day";

const row = (
  machineId: string,
  profitPerDayOre: number | null,
  paybackTenths: number | null = null,
): PerDayInput => ({
  machineId,
  name: `Automat ${machineId}`,
  profitPerDayOre,
  profitPerMonthOre: profitPerDayOre === null ? null : profitPerDayOre * 30,
  paybackTenths,
});

describe("median", () => {
  it("udda och jämnt antal, tom lista", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([1, 2, 3, 5])).toBe(3); // (2+3)/2 = 2,5 → 3 öre
    expect(median([])).toBeNull();
  });
});

describe("perDayList", () => {
  it("sorterar mest först, skalar mot den bästa och sätter medianen", () => {
    const list = perDayList(
      [row("a", 10_000, 80), row("b", 25_000, 56), row("c", 14_600, 150), row("d", null)],
      { a: "NA-01", b: "NA-02" },
      { b: "Bio Fyren" },
    );
    expect(list.rows.map((r) => r.machineId)).toEqual(["b", "c", "a"]);
    expect(list.rows[0]).toMatchObject({ fraction: 1, code: "NA-02", storeName: "Bio Fyren" });
    expect(list.rows[2]!.fraction).toBeCloseTo(0.4);
    expect(list.medianOre).toBe(14_600);
    expect(list.medianFraction).toBeCloseTo(14_600 / 25_000);
    // Återbetalningen mot den längsta (150 tiondelar).
    expect(list.rows[1]!.paybackFraction).toBe(1);
    expect(list.rows[0]!.paybackFraction).toBeCloseTo(56 / 150);
  });

  it("förlust ger tom stapel; ingen median när den är ≤ 0", () => {
    const list = perDayList([row("a", -500), row("b", -100)], {}, {});
    expect(list.rows.every((r) => r.fraction === 0)).toBe(true);
    expect(list.medianFraction).toBeNull();
    expect(list.rows.every((r) => r.paybackFraction === null)).toBe(true);
  });

  it("utan placerade automater: tom lista", () => {
    expect(perDayList([row("a", null)], {}, {})).toEqual({
      rows: [],
      medianOre: null,
      medianFraction: null,
    });
  });
});
