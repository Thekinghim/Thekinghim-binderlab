import { describe, expect, it } from "vitest";
import { order } from "./testing/fixtures";
import {
  dailyUnits,
  daysOfStockLeft,
  salesVelocity,
  salesVelocitySeries,
  stockoutDate,
  type DailyUnits,
} from "./velocity";

// 1–7 nov: 3, 0, 5, 2, 4, 6, 1 = 21 pack
const week: DailyUnits[] = [
  { date: "2026-11-01", units: 3 },
  { date: "2026-11-03", units: 5 },
  { date: "2026-11-04", units: 2 },
  { date: "2026-11-05", units: 4 },
  { date: "2026-11-06", units: 6 },
  { date: "2026-11-07", units: 1 },
  { date: "2026-10-31", units: 100 }, // utanför fönstret
];

describe("salesVelocity", () => {
  it("pack per dag över fönstret", () => {
    expect(salesVelocity(week, { asOf: "2026-11-07", days: 7 })).toEqual({
      units: 21,
      days: 7,
      perDay: 3,
      start: "2026-11-01",
      end: "2026-11-07",
    });
  });

  it("fönstret kortas av startdagen", () => {
    expect(
      salesVelocity(week, { asOf: "2026-11-07", days: 7, activeFrom: "2026-11-05" }),
    ).toMatchObject({
      units: 11,
      days: 3,
    });
    expect(
      salesVelocity(week, { asOf: "2026-11-07", days: 7, activeFrom: "2026-11-08" }),
    ).toMatchObject({
      units: 0,
      days: 0,
    });
  });

  it("glidande serie", () => {
    const s = salesVelocitySeries(week, ["2026-11-06", "2026-11-07"], 2);
    expect(s.map((x) => [x.date, x.velocity.units])).toEqual([
      ["2026-11-06", 10],
      ["2026-11-07", 7],
    ]);
  });

  it("dailyUnits räknar en order som ett pack", () => {
    const orders = [
      order({ businessDate: "2026-11-02" }),
      order({ businessDate: "2026-11-01" }),
      order({ businessDate: "2026-11-02" }),
    ];
    expect(dailyUnits(orders)).toEqual([
      { date: "2026-11-01", units: 1 },
      { date: "2026-11-02", units: 2 },
    ]);
  });
});

describe("daysOfStockLeft och stockoutDate", () => {
  const v = salesVelocity(week, { asOf: "2026-11-07", days: 7 }); // 3 pack/dag

  it("hela dagar som lagret räcker och dagen då det tar slut", () => {
    expect(daysOfStockLeft(10, v)).toBe(3); // 3,33
    expect(stockoutDate("2026-11-07", 10, v)).toBe("2026-11-11"); // tak(3,33) = 4
    expect(daysOfStockLeft(9, v)).toBe(3);
    expect(stockoutDate("2026-11-07", 9, v)).toBe("2026-11-10");
  });

  it("takt 0 → null; tomt lager → 0 och i dag", () => {
    const zero = salesVelocity([], { asOf: "2026-11-07", days: 7 });
    expect(daysOfStockLeft(10, zero)).toBeNull();
    expect(stockoutDate("2026-11-07", 10, zero)).toBeNull();
    expect(daysOfStockLeft(10, null)).toBeNull();
    expect(daysOfStockLeft(0, v)).toBe(0);
    expect(daysOfStockLeft(-2, v)).toBe(0);
    expect(stockoutDate("2026-11-07", 0, v)).toBe("2026-11-07");
  });

  it("ogiltigt fönster kastar", () => {
    expect(() => salesVelocity(week, { asOf: "2026-11-07", days: 0 })).toThrow();
  });
});
