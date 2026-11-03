import { describe, expect, it } from "vitest";
import { unitEconomics, type UnitEconomicsInput } from "@/domain";
import { agreement, NO_TAX, placement, price } from "@/domain/testing/fixtures";
import { dailyOrders } from "./test-fixtures";
import { compareUnitEconomics } from "./unit-economics-compare";

/**
 * Sep–nov 2026 (91 dagar). m-1: 1 pack à 49 kr per dag hela perioden (vinst 29 kr per dag),
 * investering 20 000 + 1 000 kr. m-2: från 16 nov., 1 pack à 59 kr per dag (vinst 39 kr), ingen
 * investering. m-9: placerad före perioden, inga aktiva dagar.
 */
const input: UnitEconomicsInput = {
  orders: [
    ...dailyOrders("m-1", "2026-09-01", 91),
    ...dailyOrders("m-2", "2026-11-16", 15, 1, 5900),
  ],
  prices: [price("t-a", 2000, "2026-01-01")],
  agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 0 })],
  placements: [
    placement("m-1", "s-1", "2026-01-01", null),
    placement("m-2", "s-1", "2026-11-16", null),
    placement("m-9", "s-1", "2026-01-01", "2026-03-31"),
  ],
  settings: NO_TAX,
  period: { start: "2026-09-01", end: "2026-11-30" },
  investments: [
    {
      machineId: "m-1",
      kind: "purchase",
      amountOre: 2_000_000,
      date: "2026-09-01",
      depreciationMonths: 36,
    },
    {
      machineId: "m-1",
      kind: "installation",
      amountOre: 100_000,
      date: "2026-09-01",
      depreciationMonths: null,
    },
  ],
  machineIds: ["m-9"],
};

const machines = [
  { id: "m-1", name: "Automat 1" },
  { id: "m-2", name: "Automat 2" },
  { id: "m-9", name: "Automat 9" },
];

describe("compareUnitEconomics", () => {
  const res = compareUnitEconomics(input, machines);
  const row = (id: string) => res.rows.find((r) => r.machineId === id)!;

  it("sida vid sida, bäst först och automater utan dagar sist", () => {
    expect(res.rows.map((r) => [r.machineId, r.rank])).toEqual([
      ["m-2", 1],
      ["m-1", 2],
      ["m-9", null],
    ]);
  });

  it("intäkt och vinst per dag", () => {
    expect(row("m-1")).toMatchObject({
      activeDays: 91,
      revenuePerDayOre: 4_900,
      profitPerDayOre: 2_900,
      profitPerMonthOre: 87_967,
      investmentOre: 2_100_000,
    });
    expect(row("m-2")).toMatchObject({
      activeDays: 15,
      revenuePerDayOre: 5_900,
      profitPerDayOre: 3_900,
    });
  });

  it("återbetalning och avkastning bygger på domänens enhetsekonomi", () => {
    const domain = unitEconomics(input).find((u) => u.machineId === "m-1")!;
    expect(domain.paybackMonths).toBe(23.9);
    expect(row("m-1").paybackTenths).toBe(239);
    // 87 967 × 12 × 10 000 / 2 100 000 = 5 026,7 → 5 027 bp (50 % per år)
    expect(row("m-1").annualReturnBp).toBe(5_027);
    expect(row("m-1").text).toBe("Automat 1: 29 kr vinst per dag, återbetald på 23,9 månader");
  });

  it("utan investering: ingen återbetalningstid och ingen avkastning", () => {
    expect(row("m-2")).toMatchObject({ paybackTenths: null, annualReturnBp: null });
    expect(row("m-2").text).toBe("Automat 2: 39 kr vinst per dag, ingen investering registrerad");
  });

  it("flottans snitt viktas efter automatdagar", () => {
    // (263 900 + 58 500) / 106 = 3 041,5 → 3 042
    expect(res.averageProfitPerDayOre).toBe(3_042);
    expect(row("m-2").vsAverageBp).toBe(2_821);
    expect(row("m-9")).toMatchObject({ activeDays: 0, profitPerDayOre: null, vsAverageBp: null });
    expect(row("m-9").text).toBe("Automat 9: inga aktiva dagar i perioden");
  });

  it("sammanfattning med siffror och underlag", () => {
    expect(res.bestMachineId).toBe("m-2");
    expect(res.text).toBe("Automat 2 ger mest vinst per dag: 39 kr mot snittet 30 kr (+28 %).");
    expect(res.evidence.machineIds).toEqual(["m-1", "m-2", "m-9"]);
    expect(res.evidence.figures.find((f) => f.key === "machineDays")!.value).toBe(106);
    expect(row("m-1").evidence.figures.find((f) => f.key === "paybackTenths")!.value).toBe(239);
  });

  it("förlust: återbetalas inte", () => {
    const loss = compareUnitEconomics(
      { ...input, prices: [price("t-a", 6_000, "2026-01-01")] },
      machines,
    );
    const m1 = loss.rows.find((r) => r.machineId === "m-1")!;
    expect(m1.paybackTenths).toBeNull();
    expect(m1.text).toBe("Automat 1: −11 kr vinst per dag, återbetalas inte med nuvarande vinst");
  });

  it("en automat: ingen jämförelse mot snitt i texten", () => {
    const one = compareUnitEconomics(
      {
        ...input,
        orders: input.orders.filter((o) => o.machineId === "m-1"),
        placements: input.placements.slice(0, 1),
        machineIds: [],
      },
      machines,
    );
    expect(one.text).toBe("Automat 1 ger 29 kr vinst per dag.");
  });

  it("inga automater", () => {
    const none = compareUnitEconomics({
      ...input,
      orders: [],
      placements: [],
      investments: [],
      machineIds: [],
    });
    expect(none.rows).toEqual([]);
    expect(none.text).toBe("Ingen automat var placerad under perioden.");
    expect(none.averageProfitPerDayOre).toBeNull();
  });

  it("namn saknas → id", () => {
    const r = compareUnitEconomics(input);
    expect(r.rows[0]!.name).toBe("m-2");
  });
});

describe("compareUnitEconomics: underlag", () => {
  it("varje automat pekar ut sina order och försäljningsdagar", () => {
    const res = compareUnitEconomics(input, machines);
    const m2 = res.rows.find((r) => r.machineId === "m-2")!;
    expect(m2.evidence.orderIds).toHaveLength(15);
    expect(m2.evidence.dates[0]).toBe("2026-11-16");
    expect(res.rows.find((r) => r.machineId === "m-9")!.evidence.orderIds).toEqual([]);
    expect(res.evidence.orderIds).toHaveLength(106);
  });
});

describe("compareUnitEconomics: placering registrerad efter första ordern", () => {
  const late: UnitEconomicsInput = {
    ...input,
    orders: dailyOrders("m-2", "2026-11-16", 15, 1, 5900),
    placements: [placement("m-2", "s-1", "2026-11-30", null)],
    investments: [],
    machineIds: [],
  };

  it("räknar dagarna från första ordern, inte från placeringen", () => {
    const r = compareUnitEconomics(late).rows.find((x) => x.machineId === "m-2")!;
    expect(r.activeDays).toBe(15);
    expect(r.profitPerDayOre).toBe(3900);
    expect(r.profitPerMonthOre).not.toBeNull();
    expect(r.profitPerMonthOre!).toBeLessThan(3900 * 31);
  });

  it("slutar vid sista dagen med data", () => {
    const r = compareUnitEconomics(late, [], { lastDataDay: "2026-11-29" }).rows.find(
      (x) => x.machineId === "m-2",
    )!;
    expect(r.activeDays).toBe(14);
  });
});
