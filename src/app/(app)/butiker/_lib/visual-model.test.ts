import { describe, expect, it } from "vitest";

import { sparkPoints, storeOfSale, storeSales } from "./visual-model";

const placements = [
  { machineId: "m1", storeId: "a", from: "2026-10-01", to: "2026-11-10" },
  { machineId: "m1", storeId: "b", from: "2026-11-11", to: null },
  { machineId: "m2", storeId: "a", from: "2026-01-01", to: null },
];
const names: Record<string, string> = {
  t1: "Surging Sparks",
  t2: "Black Bolt",
  t3: "Mega Evolution",
};

describe("sålda pack per butik", () => {
  it("ordern hör till butiken där automaten stod den dagen", () => {
    const by = new Map([["m1", placements.slice(0, 2)]]);
    expect(storeOfSale({ titleId: "t1", machineId: "m1", businessDate: "2026-11-10" }, by)).toBe(
      "a",
    );
    expect(storeOfSale({ titleId: "t1", machineId: "m1", businessDate: "2026-11-11" }, by)).toBe(
      "b",
    );
    expect(
      storeOfSale({ titleId: "t1", machineId: null, businessDate: "2026-11-11" }, by),
    ).toBeNull();
    expect(
      storeOfSale({ titleId: "t1", machineId: "x", businessDate: "2026-11-11" }, by),
    ).toBeNull();
  });

  it("räknar antal, mest sålda och kurvan", () => {
    const sales = [
      { titleId: "t1", machineId: "m1", businessDate: "2026-11-01" },
      { titleId: "t1", machineId: "m2", businessDate: "2026-11-02" },
      { titleId: "t2", machineId: "m2", businessDate: "2026-11-20" },
      { titleId: "t3", machineId: "m2", businessDate: "2026-11-20" },
      { titleId: "t3", machineId: "m2", businessDate: "2026-11-21" },
      { titleId: "t3", machineId: "m2", businessDate: "2026-11-30" },
      { titleId: "okänd", machineId: "m2", businessDate: "2026-11-30" },
      { titleId: "t1", machineId: "m1", businessDate: "2026-11-15" },
      // Utanför perioden
      { titleId: "t1", machineId: "m2", businessDate: "2026-10-31" },
    ];
    const out = storeSales({
      sales,
      placements,
      titleName: (id) => names[id] ?? null,
      period: { start: "2026-11-01", end: "2026-11-30" },
      top: 2,
      buckets: 3,
    });
    const a = out.get("a")!;
    expect(a.sold).toBe(7);
    expect(a.top).toEqual([
      { title: "Mega Evolution", count: 3 },
      { title: "Surging Sparks", count: 2 },
    ]);
    expect(a.spark).toEqual([2, 2, 3]);
    expect(out.get("b")).toEqual({
      sold: 1,
      top: [{ title: "Surging Sparks", count: 1 }],
      spark: [0, 1, 0],
    });
  });

  it("kurvans punkter", () => {
    expect(sparkPoints([1], 10, 10)).toBe("");
    expect(sparkPoints([0, 2], 10, 10)).toBe("0.0,9.0 10.0,2.0");
    expect(sparkPoints([0, 0], 10, 10)).toBe("0.0,9.0 10.0,9.0");
  });
});
