import { describe, expect, it } from "vitest";
import { MONTH_LCM, type Period, type ProfitabilityInput } from "@/domain";
import { agreement, NO_TAX, placement, price } from "@/domain/testing/fixtures";
import { newMachineScenario } from "../scenarios";
import { estimateSite } from "./estimate";
import { expansionPipeline } from "./pipeline";
import { siteHistories } from "./site-history";
import { dailyOrders, INVESTMENT } from "./test-fixtures";
import type { StoreProfile } from "./types";
import { compareUnitEconomics } from "./unit-economics-compare";

/**
 * En regel för "månad" i alla vyer: domänens aktiva månader (dagar / dagar i
 * kalendermånaden). Samma automat och period ska ge samma vinst per månad och samma
 * återbetalningstid i enhetsekonomins jämförelse och i uppskattningens underlag.
 */

const STORE: StoreProfile = {
  id: "s-1",
  name: "Ica Nära Söder",
  storeType: "livs",
  city: "Malmö",
  openHoursPerWeek: 98,
  areaSqm: 400,
};

function sources(from: string, days: number, period: Period, placedFrom = from) {
  return {
    orders: dailyOrders("m-1", from, days),
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 1000 })],
    placements: [placement("m-1", "s-1", placedFrom, null)],
    settings: NO_TAX,
    period,
  } satisfies ProfitabilityInput;
}

function both(src: ProfitabilityInput) {
  const cmp = compareUnitEconomics({
    ...src,
    investments: [
      {
        machineId: "m-1",
        kind: "purchase",
        amountOre: INVESTMENT.purchaseOre,
        date: "2026-01-01",
        depreciationMonths: 36,
      },
      {
        machineId: "m-1",
        kind: "installation",
        amountOre: INVESTMENT.installationOre,
        date: "2026-01-01",
        depreciationMonths: null,
      },
    ],
  });
  const est = estimateSite({
    target: STORE,
    targetName: "Ny plats",
    stores: [STORE],
    histories: siteHistories(src),
    period: src.period,
    investment: INVESTMENT,
    options: { minMachineDays: 1 },
  });
  return { row: cmp.rows[0]!, basis: est.basis[0]!, est };
}

describe("samma månadsregel i jämförelse och uppskattning", () => {
  const cases: [string, ProfitabilityInput][] = [
    [
      "hel oktober (31 dagar)",
      sources("2026-10-01", 31, { start: "2026-10-01", end: "2026-10-31" }),
    ],
    [
      "hel februari (28 dagar)",
      sources("2026-02-01", 28, { start: "2026-02-01", end: "2026-02-28" }),
    ],
    [
      "placerad mitt i perioden, över tre månader",
      sources("2026-09-10", 82, { start: "2026-09-01", end: "2026-11-30" }, "2026-09-10"),
    ],
    ["halv november", sources("2026-11-16", 15, { start: "2026-11-01", end: "2026-11-30" })],
  ];

  it.each(cases)("%s", (_, src) => {
    const { row, basis, est } = both(src);
    expect(basis.profitPerMonthOre).toBe(row.profitPerMonthOre);
    expect(basis.paybackTenths).toBe(row.paybackTenths);
    expect(est.paybackTenths!.expected).toBe(row.paybackTenths);
    expect(est.annualReturnBp!.expected).toBe(row.annualReturnBp);
  });

  it("vinst per månad: 2 410 kr/dag i oktober = 74 710, i februari = 67 480", () => {
    expect(both(cases[0]![1]).basis.profitPerMonthOre).toBe(74_710);
    expect(both(cases[1]![1]).basis.profitPerMonthOre).toBe(67_480);
  });

  it("automatmånader i underlaget: 16–30 nov. = 0,5 månad", () => {
    const h = siteHistories(cases[3]![1])[0]!;
    expect(h.machineMonthUnits).toBe(MONTH_LCM / 2);
    expect(both(cases[3]![1]).basis.machineMonthsHundredths).toBe(50);
  });
});

/**
 * Revisionens fall 1 och 2 med samma indata, räknade för hand med den gemensamma
 * månadsregeln (oktober = 1 automatmånad = 31 dagar) i stället för 365/12 dagar.
 */
describe("revisionens fall 1 och 2 med den gemensamma månadsregeln", () => {
  const OCT = { start: "2026-10-01", end: "2026-10-31" } as const;
  const store = (
    id: string,
    name: string,
    storeType: string,
    city: string,
    h: number,
    a: number,
  ): StoreProfile => ({ id, name, storeType, city, openHoursPerWeek: h, areaSqm: a });

  it("fall 1: A 4 820 × 31, F 0, G 2 900 × 31; viktat 79 717, återbetalning 141/263/–", () => {
    const stores = [
      store("s-a", "A", "livs", "Malmö", 98, 400),
      store("s-f", "F", "livs", "Malmö", 98, 400),
      store("s-g", "G", "livs", "Malmö", 98, 450),
    ];
    const src: ProfitabilityInput = {
      orders: [...dailyOrders("m-a", OCT.start, 31, 2), ...dailyOrders("m-g", OCT.start, 31)],
      prices: [price("t-a", 2000, "2026-01-01")],
      agreements: [agreement("s-a", "2026-01-01", null, { commissionBp: 1000 })],
      placements: [
        placement("m-a", "s-a", "2026-09-01", null),
        placement("m-f", "s-f", "2026-09-01", null),
        placement("m-g", "s-g", "2026-09-01", null),
      ],
      settings: NO_TAX,
      period: OCT,
    };
    const est = estimateSite({
      target: { storeType: "livs", city: "Malmö", openHoursPerWeek: 98, areaSqm: 400 },
      targetName: "Ny plats",
      stores,
      histories: siteHistories(src),
      period: OCT,
      investment: INVESTMENT,
    });
    // (10 000 × 149 420 + 10 000 × 0 + 9 833 × 89 900) / 29 833 = 79 717,25
    expect(est.profitPerMonthOre).toEqual({ low: 0, expected: 79_717, high: 149_420 });
    // (10 000 × 303 800 + 9 833 × 151 900) / 29 833 = 151 900 exakt
    expect(est.revenuePerMonthOre).toEqual({ low: 0, expected: 151_900, high: 303_800 });
    // 21 000 000 / 149 420 = 140,5; / 79 717,25 = 263,4; F = 0 → återbetalas inte
    expect(est.paybackTenths).toEqual({ low: 141, expected: 263, high: null });
    // × 12 × 10 000 / 2 100 000
    expect(est.annualReturnBp).toEqual({ low: 0, expected: 4_555, high: 8_538 });
    // G: 21 000 000 / 89 900 = 233,6
    expect(est.basis.find((b) => b.storeId === "s-g")!.paybackTenths).toBe(234);
    const scenario = newMachineScenario({
      sources: src,
      stores,
      likeStoreId: "s-a",
      investment: INVESTMENT,
    });
    expect(scenario.profitPerMonthOre).toEqual(est.profitPerMonthOre);
  });

  it("fall 2: villkor 15 % provision; P 4 330 × 31, Q 2 165 × 31 → 156/207/313", () => {
    const stores = [
      store("s-p", "P", "livs", "Malmö", 98, 400),
      store("s-q", "Q", "livs", "malmö", 84, 350),
    ];
    const res = expansionPipeline({
      leads: [
        {
          id: "l-1",
          name: "L1",
          storeType: "livs",
          city: "Malmö",
          openHoursPerWeek: 98,
          areaSqm: 400,
          terms: { commissionBp: 1_500, monthlyRentOre: 0 },
        },
      ],
      stores,
      histories: siteHistories({
        orders: [...dailyOrders("m-p", OCT.start, 31, 2), ...dailyOrders("m-q", OCT.start, 31)],
        prices: [price("t-a", 2000, "2026-01-01")],
        agreements: [
          agreement("s-p", "2026-01-01", null, { commissionBp: 1000 }),
          agreement("s-q", "2026-01-01", null, { commissionBp: 1000, monthlyRentOre: 31_000 }),
        ],
        placements: [
          placement("m-p", "s-p", "2026-09-01", null),
          placement("m-q", "s-q", "2026-09-01", null),
        ],
        settings: NO_TAX,
        period: OCT,
      }),
      period: OCT,
      defaultInvestment: INVESTMENT,
    });
    const l1 = res[0]!.estimate;
    // (10 000 × 134 230 + 9 527 × 67 115) / 19 527 = 101 485,4
    expect(l1.profitPerMonthOre!.expected).toBe(101_485);
    expect(l1.paybackTenths).toEqual({ low: 156, expected: 207, high: 313 });
  });
});
