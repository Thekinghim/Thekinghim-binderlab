import { describe, expect, it } from "vitest";

import { agreementGaps } from "./agreement-gaps";
import type { StoreAgreement } from "./types";

const deal = (storeId: string, validFrom: string, validTo: string | null): StoreAgreement => ({
  storeId,
  validFrom,
  validTo,
  commissionBp: 5_000,
  monthlyRentOre: null,
  commissionBase: "profit_after_costs",
});

const OCT = { start: "2026-10-01", end: "2026-10-31" };

describe("agreementGaps", () => {
  it("butik med automat och inget avtal: hela perioden, 0 % alla dagar", () => {
    const gaps = agreementGaps({
      placements: [{ machineId: "m3", storeId: "s3", from: "2026-10-27", to: null }],
      agreements: [deal("s1", "2026-01-01", null)],
      period: OCT,
    });
    expect(gaps).toEqual([
      {
        storeId: "s3",
        days: 5,
        placedDays: 5,
        ranges: [{ start: "2026-10-27", end: "2026-10-31" }],
        machineIds: ["m3"],
      },
    ]);
  });

  it("lucka mellan två avtal ger bara de dagarna; butik utan automat räknas inte", () => {
    const gaps = agreementGaps({
      placements: [
        { machineId: "m1", storeId: "s1", from: "2026-09-01", to: null },
        // Butik utan avtal men utan automat i perioden: ingen varning.
        { machineId: "m2", storeId: "s2", from: "2026-11-01", to: null },
      ],
      agreements: [deal("s1", "2026-01-01", "2026-10-09"), deal("s1", "2026-10-13", null)],
      period: OCT,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({
      storeId: "s1",
      days: 3,
      placedDays: 31,
      ranges: [{ start: "2026-10-10", end: "2026-10-12" }],
    });
  });

  it("ett avtal utan andel och hyra är ett avtal (medvetet 0 kr); storeIds begränsar", () => {
    const zero: StoreAgreement = {
      storeId: "s1",
      validFrom: "2026-01-01",
      validTo: null,
      commissionBp: null,
      monthlyRentOre: null,
    };
    const placements = [
      { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
      { machineId: "m2", storeId: "s2", from: "2026-01-01", to: "2026-10-02" },
    ];
    expect(agreementGaps({ placements, agreements: [zero], period: OCT })).toEqual([
      expect.objectContaining({ storeId: "s2", days: 2, placedDays: 2 }),
    ]);
    expect(
      agreementGaps({ placements, agreements: [zero], period: OCT, storeIds: ["s1"] }),
    ).toEqual([]);
    expect(
      agreementGaps({
        placements,
        agreements: [],
        period: { start: "2026-10-02", end: "2026-10-01" },
      }),
    ).toEqual([]);
  });

  it("två automater i samma butik räknas som en dag; luckor med och utan automat", () => {
    const gaps = agreementGaps({
      placements: [
        { machineId: "b", storeId: "s1", from: "2026-10-01", to: "2026-10-03" },
        { machineId: "a", storeId: "s1", from: "2026-10-02", to: "2026-10-05" },
        { machineId: "a", storeId: "s1", from: "2026-10-08", to: "2026-10-08" },
      ],
      agreements: [],
      period: OCT,
    });
    expect(gaps[0]).toEqual({
      storeId: "s1",
      days: 6,
      placedDays: 6,
      ranges: [
        { start: "2026-10-01", end: "2026-10-05" },
        { start: "2026-10-08", end: "2026-10-08" },
      ],
      machineIds: ["a", "b"],
    });
  });
});
