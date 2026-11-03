/**
 * Planen för fler automater. Förväntade värden uträknade för hand (heltal, öre).
 */

import { describe, expect, it } from "vitest";

import {
  defaultPerMonth,
  GROWTH_PLAN_DEFAULTS,
  growthPlan,
  helpFromCount,
  MAX_REFILL_MINUTES_PER_MACHINE_WEEK,
  paybackTenthsOf,
  refillMinutesFromMonthly,
  type GrowthMachine,
  type GrowthPlanSettings,
} from "./growth-plan";

const SETTINGS: GrowthPlanSettings = {
  targetMachines: 5,
  machinePriceOre: 3_000_000, // 30 000 kr
  startStockOre: 500_000, // 5 000 kr
  perMonth: 1,
  refillMinutesPerMachineWeek: 60,
  people: 2,
  hoursPerPersonWeek: 2,
};

function machine(id: string, profit: number, days = 30, orders = 300, cost = 600_000) {
  return {
    machineId: id,
    name: `Automat ${id}`,
    activeDays: days,
    profitPerMonthOre: profit,
    orders,
    costOre: cost,
  } satisfies GrowthMachine;
}

const FLEET = [machine("a", 1_000_000), machine("b", 600_000), machine("c", 1_400_000)];

function plan(over: Partial<Parameters<typeof growthPlan>[0]> = {}) {
  return growthPlan({
    machinesNow: 3,
    machines: FLEET,
    settings: SETTINGS,
    startMonth: "2026-12",
    fallbacks: { machinePriceOre: null, refillMinutesPerMachineWeek: null },
    ...over,
  });
}

describe("growthPlan", () => {
  it("vinst per ny automat: median och spann ur flottan", () => {
    const p = plan();
    expect(p.status).toBe("ok");
    expect(p.profitPerMonthOre).toEqual({ median: 1_000_000, low: 600_000, high: 1_400_000 });
    // 300 pack på 30 dagar → 300 × 1461 / (30 × 48) = 304,375 → 304.
    expect(p.packsPerMonth).toBe(304);
    // 600 000 × 1461 / 1440 = 608 750.
    expect(p.purchasePerMonthOre).toBe(608_750);
  });

  it("kapital, återbetalning och vid målet", () => {
    const p = plan();
    expect(p.capitalPerMachineOre).toBe(3_500_000);
    // 3 500 000 × 10 / 1 000 000 = 35 → 3,5 mån; snabbast 25, långsammast 58,33 → 58.
    expect(p.paybackTenths).toEqual({ median: 35, fastest: 25, slowest: 58 });
    expect(p.toAdd).toBe(2);
    expect(p.atTarget.machines).toBe(5);
    expect(p.atTarget.profitPerMonthOre).toBe(5_000_000);
    expect(p.atTarget.capitalOre).toBe(7_000_000);
    expect(p.atTarget.minutesPerWeek).toBe(300);
    expect(p.atTarget.minutesPerPersonWeek).toBe(150);
    // 300 min / 120 min per person → 3 personer.
    expect(p.atTarget.peopleNeeded).toBe(3);
  });

  it("tidslinjen: en per månad, vinst från månaden efter köpet", () => {
    const p = plan();
    expect(p.timeline).toEqual([
      {
        month: "2026-12",
        machines: 4,
        added: 1,
        profitOre: 3_000_000,
        cashOre: -500_000,
        minutesPerPersonWeek: 120,
        needsHelp: false,
      },
      {
        month: "2027-01",
        machines: 5,
        added: 1,
        profitOre: 4_000_000,
        cashOre: 0,
        minutesPerPersonWeek: 150,
        needsHelp: true,
      },
    ]);
    expect(p.targetMonth).toBe("2027-01");
    expect(p.peakFundingOre).toBe(500_000);
    expect(p.peakFundingMonth).toBe("2026-12");
    expect(p.cashPositiveMonth).toBe("2027-01");
    // 2 × 2 h = 240 min; 240 / 60 = 4 automater ryms → hjälp från den 5:e.
    expect(p.helpFrom).toBe(5);
    expect(p.helpMonth).toBe("2027-01");
  });

  it("med vinsten: köper när kassan räcker", () => {
    const p = plan({ settings: { ...SETTINGS, targetMachines: 6 } });
    // Dec: +3 000 000 → 0 köp (3 500 000). Jan: 6 000 000 → 1 köp, 2 500 000 kvar.
    // Feb: 4 × 1 000 000 → 6 500 000 → 1 köp, 3 000 000. Mar: 5 → 8 000 000 → 1 köp → 6.
    expect(p.selfFundedTargetMonth).toBe("2027-03");
  });

  it("standardval: investeringssnittet och en månads inköp som startlager", () => {
    const p = plan({
      settings: {
        ...SETTINGS,
        machinePriceOre: null,
        startStockOre: null,
        perMonth: null,
        refillMinutesPerMachineWeek: null,
        targetMachines: 20,
      },
      fallbacks: { machinePriceOre: 2_000_000, refillMinutesPerMachineWeek: 30 },
    });
    expect(p.machinePriceSource).toBe("data");
    expect(p.startStockOre).toBe(608_750);
    expect(p.startStockSource).toBe("data");
    expect(p.capitalPerMachineOre).toBe(2_608_750);
    expect(p.refillMinutesPerMachineWeek).toBe(30);
    expect(p.refillSource).toBe("data");
    // 17 kvar på 12 månader → 2 per månad.
    expect(p.perMonth).toBe(2);
    expect(p.perMonthSource).toBe("default");
    expect(p.timeline).toHaveLength(9);
    expect(p.timeline.at(-1)!.added).toBe(1);
    expect(p.targetMonth).toBe("2027-08");
  });

  it("utan automatpris: inget kapital eller återbetalning, men tid och vinst", () => {
    const p = plan({ settings: { ...SETTINGS, machinePriceOre: null } });
    expect(p.capitalPerMachineOre).toBeNull();
    expect(p.paybackTenths.median).toBeNull();
    expect(p.selfFundedTargetMonth).toBeNull();
    expect(p.atTarget.profitPerMonthOre).toBe(5_000_000);
  });

  it("nya automater (färre än 14 dagar) räknas inte när det finns äldre", () => {
    const p = plan({ machines: [...FLEET, machine("d", 9_000_000, 5)] });
    expect(p.basis.machineIds).toEqual(["a", "b", "c"]);
    const young = plan({ machines: [machine("d", 900_000, 5)] });
    expect(young.basis.machineIds).toEqual(["d"]);
  });

  it("utan försäljning: no-data", () => {
    const p = plan({ machines: [], machinesNow: 0 });
    expect(p.status).toBe("no-data");
    expect(p.profitPerMonthOre).toBeNull();
    expect(p.timeline.every((t) => t.profitOre === 0)).toBe(true);
    expect(p.selfFundedTargetMonth).toBeNull();
  });

  it("målet redan nått: ingen tidslinje", () => {
    const p = plan({ machinesNow: 7 });
    expect(p.toAdd).toBe(0);
    expect(p.timeline).toEqual([]);
    expect(p.targetMonth).toBeNull();
    expect(p.atTarget.machines).toBe(7);
  });

  it("median med jämnt antal avrundas halva upp", () => {
    const p = plan({ machines: [machine("a", 101), machine("b", 200)] });
    expect(p.profitPerMonthOre!.median).toBe(151);
  });
});

describe("hjälpfunktioner", () => {
  it("paybackTenthsOf", () => {
    expect(paybackTenthsOf(1000, 0)).toBeNull();
    expect(paybackTenthsOf(1000, -1)).toBeNull();
    expect(paybackTenthsOf(1000, 300)).toBe(33);
  });
  it("defaultPerMonth", () => {
    expect(defaultPerMonth(0, 12)).toBe(1);
    expect(defaultPerMonth(5, 12)).toBe(1);
    expect(defaultPerMonth(13, 12)).toBe(2);
  });
  it("helpFromCount", () => {
    expect(helpFromCount(60, 2, 10, 20)).toBeNull(); // 20 ryms
    expect(helpFromCount(60, 2, 10, 21)).toBe(21);
    expect(helpFromCount(0, 2, 10, 50)).toBeNull();
  });
  it("refillMinutesFromMonthly", () => {
    // 600 min/mån, 3 automater: 600 × 12 / 156 = 46,15 → 46.
    expect(refillMinutesFromMonthly(600, 3)).toBe(46);
    expect(refillMinutesFromMonthly(600, 0)).toBeNull();
  });
  it("rimlighetskontroll: över 10 h per automat och vecka används inte (250 h/mån, 1 automat)", () => {
    // Ägarens inmatning: 250 h = 15 000 min i månaden för 1 automat → 3 462 min/vecka.
    const measured = refillMinutesFromMonthly(15_000, 1)!;
    expect(measured).toBe(3_462);
    const p = plan({
      settings: { ...SETTINGS, refillMinutesPerMachineWeek: null },
      fallbacks: { machinePriceOre: null, refillMinutesPerMachineWeek: measured },
    });
    expect(p.refillIgnored).toEqual({ minutes: 3_462, source: "data" });
    expect(p.refillSource).toBe("default");
    expect(p.refillMinutesPerMachineWeek).toBe(GROWTH_PLAN_DEFAULTS.refillMinutesPerMachineWeek);
    // Vid målet 5 automater × 45 min / 2 personer = 113 min, inte ~577 h.
    expect(p.atTarget.minutesPerPersonWeek).toBe(113);
  });
  it("rimlighetskontroll: ett sparat orimligt värde ger mätningen eller förvalet", () => {
    const p = plan({
      settings: {
        ...SETTINGS,
        refillMinutesPerMachineWeek: MAX_REFILL_MINUTES_PER_MACHINE_WEEK + 1,
      },
      fallbacks: { machinePriceOre: null, refillMinutesPerMachineWeek: 30 },
    });
    expect(p.refillIgnored).toEqual({ minutes: 601, source: "saved" });
    expect(p.refillSource).toBe("data");
    expect(p.refillMinutesPerMachineWeek).toBe(30);
    const ok = plan({
      settings: { ...SETTINGS, refillMinutesPerMachineWeek: MAX_REFILL_MINUTES_PER_MACHINE_WEEK },
    });
    expect(ok.refillIgnored).toBeNull();
    expect(ok.refillMinutesPerMachineWeek).toBe(600);
  });
});
