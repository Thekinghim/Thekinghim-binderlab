import { describe, expect, it } from "vitest";

import { addDays, dayOfWeek } from "@/domain/dates";

import { demoCatalog, DEMO_DEFAULT_CLOCK } from "./calendar";
import {
  DEMO_AGREEMENTS,
  DEMO_CONTRACTS,
  DEMO_INCIDENTS,
  DEMO_MACHINES,
  DEMO_PERIOD,
  DEMO_REVENUE_GOALS_KR,
  DEMO_TITLES,
} from "./catalog";
import { demoOrderFiles, demoPayoutFiles, planIncidents } from "./files";
import { generateDemo } from "./generate";

describe("demons kalender", () => {
  it("originalets nu ger exakt originalkatalogen", () => {
    const cat = demoCatalog(DEMO_DEFAULT_CLOCK);
    expect(cat.shiftDays).toBe(0);
    expect(cat.period).toEqual(DEMO_PERIOD);
    expect(cat.machines).toEqual(DEMO_MACHINES);
    expect(cat.titles).toEqual(DEMO_TITLES);
    expect(cat.contracts).toEqual(DEMO_CONTRACTS);
    expect(cat.incidents).toEqual(DEMO_INCIDENTS);
    expect(cat.purchaseOrderPrefix).toBe("IO-2026-");
  });

  it("flyttar berättelsen till nu: datum, månadsnycklar och fritext", () => {
    const cat = demoCatalog({ date: "2027-03-20", hour: 15 });
    const shift = cat.shiftDays;
    expect(shift).toBe(138);
    expect(cat.period).toEqual({ start: addDays(DEMO_PERIOD.start, shift), end: "2027-03-20" });
    expect(cat.now).toEqual({ date: "2027-03-20", time: "15:00:00" });
    // Automat 07 slutar sälja två dygn före nu, som i originalet.
    const faulty = cat.machines.find((m) => m.code === "NA-07");
    expect(faulty?.faultFrom).toBe("2027-03-18");
    // Månadsnycklar flyttas hela månader (138 dagar ≈ 5 månader).
    expect(Object.keys(cat.revenueGoalsKr)).toHaveLength(Object.keys(DEMO_REVENUE_GOALS_KR).length);
    expect(cat.revenueGoalsKr["2027-01"]).toBe(DEMO_REVENUE_GOALS_KR["2026-08"]);
    expect(cat.payout.deviationMonth).toBe("2027-01");
    expect(cat.baselinePeriod).toEqual({ from: "2026-06-01", to: "2026-06-30" });
    // Fritext: "löper ut 31 dec" följer avtalets slutdatum.
    const kvarnhagen = cat.agreements.find((a) => a.validTo === addDays("2026-12-31", shift));
    expect(kvarnhagen?.note).toContain("löper ut 18 maj");
    expect(DEMO_AGREEMENTS.some((a) => a.note?.includes("31 dec"))).toBe(true);
    // Veckodagen i ärendet räknas om (originalet: lördag 31 okt).
    const fault = cat.incidents.find((i) => i.machineCode === "NA-07");
    expect(fault?.date).toBe("2027-03-18");
    expect(fault?.description).toContain("sedan torsdag");
    expect(dayOfWeek("2027-03-18")).toBe(4);
    expect(cat.purchaseOrderPrefix).toBe("IO-2027-");
  });

  it("samma nu ger samma demo, och sista dagen säljer bara före timmen", () => {
    const clock = { date: "2026-12-09", hour: 15 };
    const a = generateDemo({ catalog: demoCatalog(clock) });
    const b = generateDemo({ catalog: demoCatalog(clock) });
    expect(a.orders.length).toBe(b.orders.length);
    expect(a.orders.at(-1)).toEqual(b.orders.at(-1));
    const last = a.orders.at(-1);
    expect(last?.businessDate).toBe("2026-12-09");
    expect(Number(last?.stockholmTime.slice(11, 13))).toBeLessThan(15);
  });

  it.each(["2026-11-05", "2027-01-01", "2027-06-17", "2028-02-29"])(
    "hela demon går att skapa för nu = %s",
    (date) => {
      const cat = demoCatalog({ date, hour: 12 });
      const gen = generateDemo({ catalog: cat });
      expect(gen.orders.length).toBeGreaterThan(12_000);
      // Lördag säljer mest även efter flytten (veckodagen ur det verkliga datumet).
      const perWeekday = new Map<number, number>();
      for (const o of gen.orders) {
        const d = dayOfWeek(o.businessDate);
        perWeekday.set(d, (perWeekday.get(d) ?? 0) + 1);
      }
      const top = [...perWeekday].sort((x, y) => y[1] - x[1])[0]?.[0];
      expect(top).toBe(6);
      const files = demoOrderFiles(gen.orders);
      expect(files.length).toBeGreaterThanOrEqual(9);
      const incidents = planIncidents(gen.orders, cat);
      const payouts = demoPayoutFiles(gen.orders, incidents, cat);
      expect(payouts.payouts.some((p) => p.missing.length === 2)).toBe(true);
      expect(payouts.linesCsv.lines).toBeGreaterThan(0);
    },
  );

  it("vägrar ett ogiltigt nu", () => {
    expect(() => demoCatalog({ date: "2027-02-30x", hour: 1 })).toThrow();
    expect(() => demoCatalog({ date: "2027-02-03", hour: 24 })).toThrow();
  });
});
