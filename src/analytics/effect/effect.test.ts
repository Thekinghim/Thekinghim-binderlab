import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain";
import { agreement, NO_TAX, placement, price } from "@/domain/testing/fixtures";
import { dailyOrders } from "../expansion/test-fixtures";
import { binderlabEffect, minutesText, type Baseline, type EffectInput } from "./effect";

/**
 * Oktober: m-1 i s-1 hela månaden och m-2 i s-1 från 17 okt. (15 dagar), ett pack à 49 kr per
 * automat och dag (vinst 29 kr). November till och med 10 nov.: bara m-1 säljer.
 */
const BASELINES: Baseline[] = [
  {
    id: "b-profit",
    metric: "profit_per_machine_month",
    value: 70_000,
    unit: "ore",
    scope: "organization",
    source: "Egen uppskattning, sommaren 2026",
  },
  { id: "b-stock", metric: "stockout_days_month", value: 6, unit: "days", scope: "organization" },
  {
    id: "b-refill",
    metric: "refill_hours_month",
    value: 300,
    unit: "minutes",
    scope: "organization",
  },
  {
    id: "b-admin",
    metric: "admin_hours_month",
    value: 120,
    unit: "minutes",
    scope: "organization",
  },
];

function input(extra: Partial<EffectInput> = {}): EffectInput {
  return {
    orders: [...dailyOrders("m-1", "2026-10-01", 41), ...dailyOrders("m-2", "2026-10-17", 15)],
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [agreement("s-1", "2026-01-01", null, { commissionBp: 0 })],
    placements: [
      placement("m-1", "s-1", "2026-10-01", null),
      placement("m-2", "s-1", "2026-10-17", null),
    ],
    settings: NO_TAX,
    baselines: BASELINES,
    observations: [
      {
        metric: "stockout_days_month",
        month: "2026-10",
        value: 2,
        scope: "organization",
        dates: ["2026-10-06", "2026-10-05"],
        machineIds: ["m-2"],
      },
      { metric: "refill_hours_month", month: "2026-10", value: 200, scope: "organization" },
      { metric: "refill_hours_month", month: "2026-11", value: 150, scope: "organization" },
    ],
    months: ["2026-12", "2026-10", "2026-11"],
    asOf: "2026-11-10",
    options: { hourlyCostOre: 36_000 },
    ...extra,
  };
}

const series = (res: ReturnType<typeof binderlabEffect>, id: string) =>
  res.find((s) => s.baselineId === id)!;

describe("binderlabEffect: vinst per automat", () => {
  const res = binderlabEffect(input());
  const s = series(res, "b-profit");

  it("vinst × dagar i månaden / automatdagar", () => {
    const oct = s.points[0]!;
    // 46 pack × 29 kr = 1 334 kr på 46 automatdagar → 29 kr × 31 = 899 kr per automatmånad
    expect(oct).toMatchObject({
      month: "2026-10",
      value: 89_900,
      partial: false,
      machineDays: 46,
      improvement: 19_900,
      improvementBp: 2_843,
      // 199 kr × 46/31 automatmånader
      improvementOre: 29_529,
    });
    expect(oct.evidence.machineIds).toEqual(["m-1", "m-2"]);
    expect(oct.evidence.period).toEqual({ start: "2026-10-01", end: "2026-10-31" });
  });

  it("pågående månad räknas till och med asOf och markeras; senare månader hoppas över", () => {
    expect(s.points.map((p) => p.month)).toEqual(["2026-10", "2026-11"]);
    const nov = s.points[1]!;
    // 10 pack × 29 kr på 20 automatdagar → 14,50 kr × 30 = 435 kr
    expect(nov).toMatchObject({
      value: 43_500,
      partial: true,
      machineDays: 20,
      improvement: -26_500,
      improvementBp: -3_786,
      improvementOre: -17_667,
    });
    expect(s.latest).toBe(nov);
  });

  it("text och sammanfattning", () => {
    expect(s.higherIsBetter).toBe(true);
    expect(s.text).toBe(
      "Vinst per automat: 435 kr per månad i november (hittills) mot 700 kr före Binderlab (−38 %, −265 kr per automat och månad).",
    );
    expect(s.averageValue).toBe(66_700);
    expect(s.totalImprovementOre).toBe(11_862);
    expect(s.detail).toBe("Snitt 667 kr över 2 månader, sammanlagt +119 kr sedan oktober.");
    expect(s.evidence.rule).toContain("Egen uppskattning, sommaren 2026");
  });

  it("per automat", () => {
    const m2 = binderlabEffect(
      input({
        baselines: [
          {
            id: "m",
            metric: "profit_per_machine_month",
            value: 70_000,
            unit: "ore",
            scope: "machine",
            machineId: "m-2",
          },
        ],
        months: ["2026-10"],
      }),
    )[0]!;
    // 15 pack × 29 kr på 15 dagar → 29 kr × 31
    expect(m2.points[0]).toMatchObject({ value: 89_900, machineDays: 15 });
  });

  it("utan automatdagar: inget värde", () => {
    const r = binderlabEffect(input({ months: ["2026-09"], asOf: "2026-11-10" }));
    const p = series(r, "b-profit");
    expect(p.points[0]!.value).toBeNull();
    expect(p.latest).toBeNull();
    expect(p.text).toBe("Vinst per automat: inga värden ännu att jämföra med utgångsläget 700 kr.");
  });
});

describe("binderlabEffect: mätvärden", () => {
  const res = binderlabEffect(input());

  it("slutsålda dagar: färre är bättre, kronor uppskattade med vinst per automat och dag", () => {
    const s = series(res, "b-stock");
    expect(s.higherIsBetter).toBe(false);
    expect(s.points[0]).toMatchObject({
      value: 2,
      improvement: 4,
      improvementBp: 6_667,
      improvementOre: 4 * 2_900,
    });
    expect(s.points[1]).toMatchObject({ value: null, improvement: null, improvementOre: null });
    expect(s.points[0]!.evidence.dates).toEqual(["2026-10-05", "2026-10-06"]);
    expect(s.points[0]!.evidence.machineIds).toEqual(["m-2"]);
    expect(s.text).toBe(
      "Slutsålda dagar: 2 i oktober mot 6 före Binderlab (67 % färre, värt +116 kr).",
    );
    expect(s.detail).toBe(
      "Sammanlagt +116 kr sedan oktober, kronor uppskattade med vinst per automat och dag.",
    );
  });

  it("slutsålda dagar med angivet värde per dag", () => {
    const s = series(
      binderlabEffect(input({ options: { stockoutDayValueOre: 5_000 } })),
      "b-stock",
    );
    expect(s.points[0]!.improvementOre).toBe(20_000);
    expect(s.detail).toBe("Sammanlagt +200 kr sedan oktober.");
  });

  it("tid för påfyllning i kronor med timkostnad", () => {
    const s = series(res, "b-refill");
    expect(
      s.points.map((p) => [p.value, p.improvement, p.improvementBp, p.improvementOre]),
    ).toEqual([
      [200, 100, 3_333, 60_000],
      [150, 150, 5_000, 90_000],
    ]);
    expect(s.text).toBe(
      "Tid för påfyllning: 2 h 30 min i november (hittills) mot 5 h före Binderlab (50 % mindre, värt +900 kr).",
    );
    expect(s.detail).toBe("Snitt 2 h 55 min över 2 månader, sammanlagt +1 500 kr sedan oktober.");
    expect(s.points[0]!.evidence.figures.find((f) => f.key === "value")!.unit).toBe("minutes");
  });

  it("utan timkostnad visas tiden bara i tid", () => {
    const s = series(binderlabEffect(input({ options: {} })), "b-refill");
    expect(s.points[0]!.improvementOre).toBeNull();
    expect(s.totalImprovementOre).toBeNull();
    expect(s.text).toBe(
      "Tid för påfyllning: 2 h 30 min i november (hittills) mot 5 h före Binderlab (50 % mindre).",
    );
    expect(s.detail).toContain("ange timkostnad för att räkna tiden i kronor");
  });

  it("sämre än utgångsläget ger negativ förbättring", () => {
    const s = series(
      binderlabEffect(
        input({
          observations: [
            { metric: "refill_hours_month", month: "2026-10", value: 360, scope: "organization" },
          ],
        }),
      ),
      "b-refill",
    );
    expect(s.points[0]).toMatchObject({
      improvement: -60,
      improvementBp: -2_000,
      improvementOre: -36_000,
    });
    expect(s.text).toContain("(20 % mer, värt −360 kr)");
  });

  it("inga mätvärden", () => {
    const s = series(res, "b-admin");
    expect(s.latest).toBeNull();
    expect(s.text).toBe(
      "Tid för administration: inga värden ännu att jämföra med utgångsläget 2 h.",
    );
    expect(s.detail).toBe("Lägg in mätvärden per månad.");
  });
});

describe("binderlabEffect: indata", () => {
  it("fel enhet, dubbla mätvärden och saknad butik kastar", () => {
    expect(() =>
      binderlabEffect(input({ baselines: [{ ...BASELINES[2]!, unit: "count" }] })),
    ).toThrow(DomainError);
    expect(() =>
      binderlabEffect(
        input({
          observations: [
            { metric: "refill_hours_month", month: "2026-10", value: 1, scope: "organization" },
            { metric: "refill_hours_month", month: "2026-10", value: 2, scope: "organization" },
          ],
        }),
      ),
    ).toThrow(DomainError);
    expect(() =>
      binderlabEffect(input({ baselines: [{ ...BASELINES[0]!, scope: "store" }] })),
    ).toThrow(DomainError);
    expect(() => binderlabEffect(input({ options: { hourlyCostOre: -1 } }))).toThrow(DomainError);
    expect(() => binderlabEffect(input({ months: ["2026-13"] }))).toThrow(DomainError);
  });

  it("utgångsläge 0 ger ingen procent", () => {
    const s = binderlabEffect(input({ baselines: [{ ...BASELINES[1]!, value: 0 }] }))[0]!;
    expect(s.points[0]!.improvementBp).toBeNull();
    expect(s.averageImprovementBp).toBeNull();
  });

  it("mätvärden för en butik matchas bara mot butikens utgångsläge", () => {
    const s = binderlabEffect(
      input({
        baselines: [
          {
            id: "x",
            metric: "stockout_days_month",
            value: 6,
            unit: "days",
            scope: "store",
            storeId: "s-1",
          },
        ],
      }),
    )[0]!;
    expect(s.latest).toBeNull();
  });

  it("utan asOf räknas hela månader", () => {
    const s = series(binderlabEffect(input({ asOf: undefined, months: ["2026-10"] })), "b-profit");
    expect(s.points[0]!.partial).toBe(false);
  });
});

describe("minutesText", () => {
  it("timmar och minuter", () => {
    expect(minutesText(200)).toBe("3 h 20 min");
    expect(minutesText(60)).toBe("1 h");
    expect(minutesText(45)).toBe("45 min");
    expect(minutesText(0)).toBe("0 min");
    expect(minutesText(-90)).toBe("−1 h 30 min");
  });
});
