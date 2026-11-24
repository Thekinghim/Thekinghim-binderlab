import { describe, expect, it } from "vitest";

import { resolveVatReserveMode, vatReserve } from "./vat-reserve";

describe("resolveVatReserveMode", () => {
  it("automatiskt: moms på vinsten om bokföringen eller rapporten säger VMB", () => {
    expect(resolveVatReserveMode("auto", { bookkeepingVmb: true, reportVmb: false })).toBe("vmb");
    expect(resolveVatReserveMode("auto", { bookkeepingVmb: false, reportVmb: true })).toBe("vmb");
    expect(resolveVatReserveMode(null, { bookkeepingVmb: false, reportVmb: false })).toBe(
      "standard",
    );
  });
  it("ett uttryckligt val gäller", () => {
    expect(resolveVatReserveMode("none", { bookkeepingVmb: true, reportVmb: true })).toBe("none");
    expect(resolveVatReserveMode("standard", { bookkeepingVmb: true, reportVmb: true })).toBe(
      "standard",
    );
  });
});

describe("vatReserve", () => {
  const m = (month: string, grossOre: number, costOre: number, refundsOre = 0) => ({
    month,
    grossOre,
    costOre,
    refundsOre,
  });
  it("moms på vinsten per månad med underskott vidare", () => {
    const r = vatReserve("vmb", [m("2026-10", 1000, 3000), m("2026-11", 10_000, 2000)], 0, 0);
    expect(r.months).toEqual([
      { month: "2026-10", marginOre: -2000, vatOre: 0 },
      { month: "2026-11", marginOre: 6000, vatOre: 1200 },
    ]);
    expect(r.reserveOre).toBe(1200);
    expect(r.carryOutOre).toBe(0);
  });
  it("avrundar halva öre bort från noll", () => {
    expect(vatReserve("vmb", [m("2026-11", 1003, 0)], 0, 0).reserveOre).toBe(201);
  });
  it("standard: momsen i försäljningen", () => {
    expect(vatReserve("standard", [m("2026-11", 12_500, 0)], 0, 2500).reserveOre).toBe(2500);
  });
  it("ingen moms", () => {
    expect(vatReserve("none", [m("2026-11", 12_500, 0)], 0, 2500).reserveOre).toBe(0);
  });
});
