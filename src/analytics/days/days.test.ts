import { describe, expect, it } from "vitest";

import { dataCoverage } from "@/server/data/core/period";

import { lastCompleteDay, measuredDays, measuredPeriod } from "./days";

/** Produktionen 4 nov. 2026: första ordern 14 okt., inga order ännu i dag. */
const OPTS = { dataStart: "2026-10-14", today: "2026-11-04" } as const;

describe("dagregeln: bara hela dagar med data, aldrig i dag", () => {
  it("30 dagar bakåt: 14 okt.–3 nov. = 21 dagar (inte 28, inte 22)", () => {
    const p = { start: "2026-10-06", end: "2026-11-04" };
    expect(measuredPeriod(p, OPTS)).toEqual({ start: "2026-10-14", end: "2026-11-03" });
    expect(measuredDays(p, OPTS)).toBe(21);
    // 28 dagars fönster för Mål: också 21.
    expect(measuredDays({ start: "2026-10-08", end: "2026-11-04" }, OPTS)).toBe(21);
  });

  it("november hittills: 1–3 nov. = 3 dagar (inte 4)", () => {
    expect(measuredDays({ start: "2026-11-01", end: "2026-11-30" }, OPTS)).toBe(3);
  });

  it("i dag och utan data: inga dagar", () => {
    expect(measuredPeriod({ start: "2026-11-04", end: "2026-11-04" }, OPTS)).toBeNull();
    expect(
      measuredDays({ start: "2026-10-01", end: "2026-10-31" }, { ...OPTS, dataStart: null }),
    ).toBe(0);
    expect(lastCompleteDay("2026-11-01")).toBe("2026-10-31");
  });

  it("dataCoverage (Hem, Butiker, Lönsamhet) bygger på samma regel", () => {
    const p = { start: "2026-10-06", end: "2026-11-04" };
    expect(dataCoverage(p, "2026-10-14", "2026-11-04", false)).toEqual(measuredPeriod(p, OPTS));
    // Med order i dag räknas dagens order i summorna, och då dagen också.
    expect(dataCoverage(p, "2026-10-14", "2026-11-04", true)).toEqual({
      start: "2026-10-14",
      end: "2026-11-04",
    });
    expect(
      dataCoverage({ start: "2026-11-04", end: "2026-11-04" }, "2026-10-14", "2026-11-04", true),
    ).toEqual({
      start: "2026-11-04",
      end: "2026-11-04",
    });
  });
});
