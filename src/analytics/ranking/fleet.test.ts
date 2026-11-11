import { describe, expect, it } from "vitest";

import { fleetRanking, type FleetMachineInput } from "./fleet";

function m(id: string, profit: number | null, days = 30, extra: Partial<FleetMachineInput> = {}) {
  return {
    machineId: id,
    activeDays: days,
    orders: days * 5,
    revenuePerDayOre: profit === null ? null : profit * 3,
    profitPerDayOre: profit,
    ...extra,
  } satisfies FleetMachineInput;
}

describe("fleetRanking: flera automater", () => {
  it("rangordnar efter vinst per dag och sätter omdöme mot medianen", () => {
    const r = fleetRanking([m("c", 4_000), m("a", 40_000), m("b", 20_000), m("d", 18_000)]);
    expect(r.mode).toBe("fleet");
    expect(r.rows.map((x) => x.machineId)).toEqual(["a", "b", "d", "c"]);
    // Median av 40 000, 20 000, 18 000, 4 000 = 19 000.
    expect(r.medianProfitPerDayOre).toBe(19_000);
    expect(r.rows.map((x) => x.verdict)).toEqual(["best", "good", "good", "weak"]);
    expect(r.rows[3]!.vsMedianOre).toBe(-15_000);
    expect(r.best?.machineId).toBe("a");
    expect(r.weak.map((x) => x.machineId)).toEqual(["c"]);
    expect(r.rows[0]!.bar).toBe(1);
    expect(r.rows[0]!.unitsPerDayTenths).toBe(50);
  });

  it("exakt hälften av medianen går dåligt, strax över går bra", () => {
    const r = fleetRanking([m("a", 30_000), m("b", 20_000), m("c", 10_000), m("d", 10_001)]);
    // Median = (20 000 + 10 001) / 2 avrundat = 15 001: 10 000 är över hälften.
    expect(r.rows.find((x) => x.machineId === "c")!.verdict).toBe("good");
    const half = fleetRanking([m("a", 30_000), m("b", 20_000), m("c", 10_000)]);
    expect(half.medianProfitPerDayOre).toBe(20_000);
    expect(half.rows.find((x) => x.machineId === "c")!.verdict).toBe("weak");
  });

  it("förlust per dag går alltid dåligt, och den bästa blir inte Bäst om alla går med förlust", () => {
    const r = fleetRanking([m("a", -100), m("b", -5_000)]);
    expect(r.rows.map((x) => x.verdict)).toEqual(["weak", "weak"]);
    expect(r.best).toBeNull();
    expect(r.rows.every((x) => x.bar === 0)).toBe(true);
    // Svagast först.
    expect(r.weak.map((x) => x.machineId)).toEqual(["b", "a"]);
  });

  it("en ny automat (under 14 dagar) får inget omdöme och räknas inte i medianen", () => {
    const r = fleetRanking([m("a", 30_000), m("b", 20_000), m("ny", 90_000, 6)]);
    expect(r.rows[0]!.machineId).toBe("ny");
    expect(r.rows[0]!.verdict).toBe("new");
    expect(r.rows[0]!.vsMedianOre).toBeNull();
    expect(r.medianProfitPerDayOre).toBe(25_000);
    expect(r.best?.machineId).toBe("a");
    expect(r.comparable).toBe(2);
  });

  it("bara en jämförbar automat: ingen median, inget Bäst", () => {
    const r = fleetRanking([m("a", 30_000), m("ny", 1_000, 3)]);
    expect(r.medianProfitPerDayOre).toBeNull();
    expect(r.rows.map((x) => x.verdict)).toEqual(["alone", "new"]);
    expect(fleetRanking([m("a", -1), m("ny", 1_000, 3)]).rows[1]!.verdict).toBe("weak");
  });

  it("automater utan aktiva dagar kommer inte med; lika vinst ordnas på id", () => {
    const r = fleetRanking([m("b", 100), m("a", 100), m("z", null, 0)]);
    expect(r.rows.map((x) => x.machineId)).toEqual(["a", "b"]);
  });

  it("tio automater: en bäst, de under halva medianen går dåligt", () => {
    const fleet = Array.from({ length: 10 }, (_, i) => m(`m${i}`, (i + 1) * 10_000));
    const r = fleetRanking(fleet);
    expect(r.medianProfitPerDayOre).toBe(55_000);
    expect(r.rows.filter((x) => x.verdict === "best")).toHaveLength(1);
    expect(r.weak.map((x) => x.machineId)).toEqual(["m0", "m1"]);
    expect(r.rows.filter((x) => x.verdict === "good")).toHaveLength(7);
  });

  it("slutsålt följer med när det är känt", () => {
    const r = fleetRanking([
      m("a", 100, 30, { lostRevenueOre: 32_000, stockoutDayTenths: 35 }),
      m("b", 50),
    ]);
    expect(r.rows[0]).toMatchObject({ lostRevenueOre: 32_000, stockoutDayTenths: 35 });
    expect(r.rows[1]).toMatchObject({ lostRevenueOre: null, stockoutDayTenths: null });
  });
});

describe("fleetRanking: en automat jämförs med sin förra period", () => {
  it("bättre, som förra och sämre (10 % gräns)", () => {
    expect(fleetRanking([m("a", 11_000)], [m("a", 10_000)]).rows[0]).toMatchObject({
      verdict: "better",
      vsPreviousBp: 1_000,
      previousProfitPerDayOre: 10_000,
    });
    expect(fleetRanking([m("a", 10_900)], [m("a", 10_000)]).rows[0]!.verdict).toBe("same");
    expect(fleetRanking([m("a", 9_000)], [m("a", 10_000)]).rows[0]!.verdict).toBe("worse");
    expect(fleetRanking([m("a", 9_000)], [m("a", 10_000)]).mode).toBe("single");
  });

  it("från förlust till vinst är bättre", () => {
    const r = fleetRanking([m("a", 5_000)], [m("a", -5_000)]);
    expect(r.rows[0]).toMatchObject({ verdict: "better", vsPreviousBp: 20_000 });
    expect(fleetRanking([m("a", 5)], [m("a", 0)]).rows[0]).toMatchObject({
      verdict: "better",
      vsPreviousBp: null,
    });
  });

  it("utan förra period, eller med en för kort, sägs att inget finns att jämföra med", () => {
    expect(fleetRanking([m("a", 5_000)]).rows[0]!.verdict).toBe("alone");
    expect(fleetRanking([m("a", 5_000)], [m("a", 9_000, 5)]).rows[0]!.verdict).toBe("alone");
  });

  it("för få dagar ger inget omdöme", () => {
    expect(fleetRanking([m("a", 5_000, 13)], [m("a", 1_000)]).rows[0]!.verdict).toBe("new");
  });

  it("ingen automat har sålt", () => {
    expect(fleetRanking([m("a", null, 0)])).toMatchObject({ mode: "empty", rows: [] });
  });
});
