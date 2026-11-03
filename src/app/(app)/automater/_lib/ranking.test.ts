import { describe, expect, it } from "vitest";

import type { UnitEconomicsComparison } from "@/analytics/expansion/unit-economics-compare";

import { rankingView } from "./ranking";

function comparison(
  rows: Array<{
    id: string;
    perDay: number | null;
    days: number;
    rank: number | null;
    vs: number | null;
  }>,
  avg: number | null,
): UnitEconomicsComparison {
  return {
    rows: rows.map((r) => ({
      machineId: r.id,
      activeDays: r.days,
      profitPerDayOre: r.perDay,
      rank: r.rank,
      vsAverageBp: r.vs,
    })),
    averageProfitPerDayOre: avg,
  } as unknown as UnitEconomicsComparison;
}

const machines = [
  { id: "a", code: "BL-001", name: "A" },
  { id: "b", code: "BL-002", name: "B" },
  { id: "c", code: "BL-003", name: "C" },
  { id: "d", code: "BL-004", name: "D" },
];
const hrefOf = (code: string) => `/automater/${code}`;

describe("rankingView", () => {
  it("rangordnar efter vinst per dag och föreslår flytt för den som tjänar minst", () => {
    const v = rankingView({
      comparison: comparison(
        [
          { id: "c", perDay: 2_000, days: 30, rank: 3, vs: -6_000 },
          { id: "a", perDay: 10_000, days: 30, rank: 1, vs: 6_000 },
          { id: "b", perDay: 5_000, days: 30, rank: 2, vs: 0 },
          { id: "d", perDay: null, days: 0, rank: null, vs: null },
        ],
        5_000,
      ),
      machines,
      hrefOf,
    });
    expect(v.rows.map((r) => r.code)).toEqual(["BL-001", "BL-002", "BL-003"]);
    expect(v.rows.map((r) => r.move)).toEqual([false, false, true]);
    expect(v.rows[0]?.bar).toBe(1);
    expect(v.rows[2]?.bar).toBeCloseTo(0.2);
    expect(v.moveCount).toBe(1);
    expect(v.aside).toBe("BL-003 tjänar minst. Flytta?");
    expect(v.rows[2]?.vsAverage).toMatch(/^−30/);
  });

  it("förlust per dag ger Flytta? och ingen stapel", () => {
    const v = rankingView({
      comparison: comparison(
        [
          { id: "a", perDay: 8_000, days: 20, rank: 1, vs: 3_000 },
          { id: "b", perDay: 6_000, days: 20, rank: 2, vs: 1_000 },
          { id: "c", perDay: -500, days: 20, rank: 3, vs: -11_000 },
        ],
        4_500,
      ),
      machines,
      hrefOf,
    });
    expect(v.rows[2]).toMatchObject({ move: true, bar: 0 });
  });

  it("nya automater och för få automater får inget Flytta?", () => {
    const fewDays = rankingView({
      comparison: comparison(
        [
          { id: "a", perDay: 8_000, days: 30, rank: 1, vs: 5_000 },
          { id: "b", perDay: 6_000, days: 30, rank: 2, vs: 1_000 },
          { id: "c", perDay: 500, days: 5, rank: 3, vs: -9_000 },
        ],
        5_000,
      ),
      machines,
      hrefOf,
    });
    expect(fewDays.moveCount).toBe(0);
    expect(fewDays.aside).toMatch(/^Snitt/);
    const two = rankingView({
      comparison: comparison(
        [
          { id: "a", perDay: 8_000, days: 30, rank: 1, vs: 6_000 },
          { id: "b", perDay: -100, days: 30, rank: 2, vs: -10_000 },
        ],
        4_000,
      ),
      machines,
      hrefOf,
    });
    expect(two.moveCount).toBe(0);
    expect(two.rows[1]?.vsAverage).toBeNull();
  });
});
