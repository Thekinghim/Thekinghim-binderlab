import { describe, expect, it } from "vitest";

import { addDays } from "./dates";
import { coverageRangeText, inferCoverage, wholeKrText } from "./payout-coverage";

const days = (start: string, values: number[]) =>
  values.map((v, i) => ({ date: addDays(start, i), expectedNetOre: v }));

describe("inferCoverage", () => {
  it("hittar dagarna som exakt ger beloppet", () => {
    const r = inferCoverage({
      days: days("2026-11-03", [1000, 2000, 3000, 4000]),
      lastCoveredEnd: "2026-11-02",
      paidOn: "2026-11-13",
      amountOre: 6000,
    });
    expect(r).toMatchObject({ ok: true, from: "2026-11-03", to: "2026-11-05", diffOre: 0 });
    expect(r.ok && r.note).toContain("3–5 nov.");
  });

  it("väljer närmaste dagen och den tidigare vid lika", () => {
    const close = inferCoverage({
      days: days("2026-11-01", [1000, 1000, 1000]),
      lastCoveredEnd: null,
      paidOn: "2026-11-10",
      amountOre: 2400,
    });
    expect(close).toMatchObject({ ok: true, to: "2026-11-02", diffOre: 400 });
    const tie = inferCoverage({
      days: days("2026-11-01", [1000, 1000]),
      lastCoveredEnd: null,
      paidOn: "2026-11-10",
      amountOre: 1500,
    });
    expect(tie).toMatchObject({ ok: true, to: "2026-11-01" });
  });

  it("räknar dagar utan försäljning som 0 och stannar före betaldagen", () => {
    const r = inferCoverage({
      days: days("2026-11-01", [1000, 0, 0, 0, 5000]),
      lastCoveredEnd: "2026-10-31",
      paidOn: "2026-11-05",
      amountOre: 6000,
    });
    // 5 nov är betaldagen: bara 1–4 nov får vara med.
    expect(r).toMatchObject({ ok: true, from: "2026-11-01", to: "2026-11-01", diffOre: 5000 });
    expect(r.ok && r.note).toContain("Skiljer 50 kr");
  });

  it("säger till när allt redan är täckt eller inget sålts", () => {
    expect(
      inferCoverage({ days: [], lastCoveredEnd: "2026-11-10", paidOn: "2026-11-11", amountOre: 1 }),
    ).toEqual({ ok: false, reason: "covered" });
    expect(
      inferCoverage({ days: [], lastCoveredEnd: null, paidOn: "2026-11-11", amountOre: 1 }),
    ).toEqual({
      ok: false,
      reason: "no_days",
    });
  });

  it("tar högst 366 dagar", () => {
    const r = inferCoverage({
      days: days(
        "2025-01-01",
        Array.from({ length: 700 }, () => 100),
      ),
      lastCoveredEnd: "2024-12-31",
      paidOn: "2026-12-31",
      amountOre: 10_000_000,
    });
    expect(r).toMatchObject({ ok: true, from: "2025-01-01", to: addDays("2025-01-01", 366) });
  });
});

describe("texterna", () => {
  it("skriver perioder och kronor", () => {
    expect(coverageRangeText("2026-11-03", "2026-11-09")).toBe("3–9 nov.");
    expect(coverageRangeText("2026-10-28", "2026-11-03")).toBe("28 okt.–3 nov.");
    expect(coverageRangeText("2026-12-28", "2027-01-03")).toBe("28 dec. 2026–3 jan. 2027");
    expect(wholeKrText(1_234_000)).toBe("12 340");
    expect(wholeKrText(-50)).toBe("−1");
  });
});
