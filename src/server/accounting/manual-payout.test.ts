import { describe, expect, it } from "vitest";

import {
  manualReference,
  manualSourceHash,
  nextPayoutPeriod,
  overlappingPayout,
} from "./manual-payout";

const OCT = { periodStart: "2026-10-01", periodEnd: "2026-10-31" };

describe("nextPayoutPeriod", () => {
  it("ingen utbetalning: förra kalendermånaden", () => {
    expect(nextPayoutPeriod([], "2026-11-05")).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(nextPayoutPeriod([], "2027-01-01")).toEqual({ start: "2026-12-01", end: "2026-12-31" });
  });

  it("efter en hel månad kommer nästa hela månad, när den är slut", () => {
    expect(nextPayoutPeriod([OCT], "2026-11-30")).toBeNull();
    expect(nextPayoutPeriod([OCT], "2026-12-01")).toEqual({
      start: "2026-11-01",
      end: "2026-11-30",
    });
  });

  it("veckovis: nästa vecka efter den senaste, oavsett ordning i listan", () => {
    const weeks = [
      { periodStart: "2026-10-19", periodEnd: "2026-10-25" },
      { periodStart: "2026-10-12", periodEnd: "2026-10-18" },
    ];
    expect(nextPayoutPeriod(weeks, "2026-11-02")).toEqual({
      start: "2026-10-26",
      end: "2026-11-01",
    });
    expect(nextPayoutPeriod(weeks, "2026-11-01")).toBeNull();
  });

  it("en halv första månad följs av lika många dagar, inte av en hel månad", () => {
    expect(
      nextPayoutPeriod([{ periodStart: "2026-10-14", periodEnd: "2026-10-31" }], "2026-12-01"),
    ).toEqual({ start: "2026-11-01", end: "2026-11-18" });
  });
});

describe("overlappingPayout", () => {
  it("hittar utbetalningen som täcker någon av dagarna", () => {
    expect(overlappingPayout([OCT], { start: "2026-10-31", end: "2026-11-06" })).toBe(OCT);
    expect(overlappingPayout([OCT], { start: "2026-11-01", end: "2026-11-30" })).toBeNull();
  });
});

describe("manualReference och manualSourceHash", () => {
  it("hel månad, egna dagar och en dag", () => {
    const none = new Set<string>();
    expect(manualReference({ start: "2026-10-01", end: "2026-10-31" }, none)).toBe(
      "Inskriven 2026-10",
    );
    expect(manualReference({ start: "2026-10-14", end: "2026-10-31" }, none)).toBe(
      "Inskriven 2026-10-14 till 2026-10-31",
    );
    expect(manualReference({ start: "2026-10-14", end: "2026-10-14" }, none)).toBe(
      "Inskriven 2026-10-14",
    );
  });

  it("upptagen referens får en siffra", () => {
    const taken = new Set(["Inskriven 2026-10", "Inskriven 2026-10 (2)"]);
    expect(manualReference({ start: "2026-10-01", end: "2026-10-31" }, taken)).toBe(
      "Inskriven 2026-10 (3)",
    );
  });

  it("fingeravtrycket är 64 hextecken och följer innehållet", () => {
    const base = {
      reference: "Inskriven 2026-10",
      period: { start: "2026-10-01", end: "2026-10-31" },
      paidOn: "2026-11-03",
      amountOre: 1_217_200,
    };
    expect(manualSourceHash(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(manualSourceHash(base)).toBe(manualSourceHash({ ...base }));
    expect(manualSourceHash({ ...base, amountOre: 1_217_300 })).not.toBe(manualSourceHash(base));
  });
});
