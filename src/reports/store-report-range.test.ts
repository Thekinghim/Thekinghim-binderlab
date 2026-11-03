import { describe, expect, it } from "vitest";
import type { StoreAgreement } from "@/domain";
import { buildStoreReport } from "./store-report";
import { octoberExample, ord, price, sources } from "./testing/fixtures";

const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

describe("butiksrapport med eget datum", () => {
  it("15–31 okt.: bara dagarna i intervallet, hyra per dag och jämförelse mot lika många dagar före", () => {
    const r = buildStoreReport(octoberExample(), "s-1", { start: "2026-10-15", end: "2026-10-31" });
    expect(r.period).toEqual({ start: "2026-10-15", end: "2026-10-31" });
    expect(r.month).toBe("2026-10");
    // o3 (15), o4 (16), o5 (20) à 49 kr och o6 (31) à 59 kr.
    expect(r.sales.orders).toBe(4);
    expect(r.sales.revenueOre).toBe(3 * 4_900 + 5_900);
    // Provision 10 % per order, hyra 62 kr × 17 / 31 dagar = 34 kr.
    expect(r.compensation.commissionOre).toBe(2_060);
    expect(r.compensation.rentOre).toBe(3_400);
    expect(r.compensation.totalOre).toBe(5_460);
    const rent = r.compensation.steps.find((s) => s.kind === "rent")!;
    expect(plain(rent.calculation)).toBe(
      "62,00 kr per månad × 17 av 31 dagar (15–31 okt. 2026) = 34,00 kr",
    );
    // Jämförelsen: 17 dagar före = 28 sep.–14 okt. (o1 och o2).
    expect(r.comparison.period).toEqual({ start: "2026-09-28", end: "2026-10-14" });
    expect(r.comparison.orders).toBe(2);
    expect(r.comparison.revenueOre).toBe(9_800);
    expect(plain(r.conclusion.text)).toContain("perioden före (28 sep.–14 okt. 2026)");
    // Veckor och automater räknas inom intervallet.
    expect(r.weeks[0]!.range.start).toBe("2026-10-15");
    expect(r.machines[0]!.placedDays).toBe(17);
  });

  it("en hel månad som period ger exakt månadsrapporten", () => {
    const src = octoberExample();
    expect(buildStoreReport(src, "s-1", { start: "2026-10-01", end: "2026-10-31" })).toEqual(
      buildStoreReport(src, "s-1", "2026-10"),
    );
  });

  it("inga order i intervallet: slutsatsen nämner perioden", () => {
    const r = buildStoreReport(octoberExample(), "s-1", { start: "2026-10-21", end: "2026-10-30" });
    expect(r.sales.orders).toBe(0);
    expect(plain(r.conclusion.text)).toMatch(/^Ingen försäljning i 21–30 okt\. 2026/);
  });

  it("över ett månadsskifte: ett hyressteg per månad", () => {
    const r = buildStoreReport(octoberExample(), "s-1", { start: "2026-10-15", end: "2026-11-14" });
    const rent = r.compensation.steps.filter((s) => s.kind === "rent");
    // 62 × 17/31 = 34 kr och 62 × 14/30 = 28,93 kr.
    expect(rent.map((s) => s.amountOre)).toEqual([3_400, 2_893]);
    expect(r.compensation.rentOre).toBe(6_293);
  });
});

describe("vinstdelning över eget datum: per kalendermånad, som liggaren", () => {
  const split = (lossTreatment: StoreAgreement["lossTreatment"]): StoreAgreement => ({
    storeId: "s-1",
    validFrom: "2026-10-15",
    validTo: null,
    commissionBp: 5_000,
    monthlyRentOre: null,
    commissionBase: "profit_after_costs",
    lossTreatment,
  });
  // Oktober går med 50 kr förlust, november med 100 kr vinst.
  const src = (lossTreatment: StoreAgreement["lossTreatment"]) =>
    sources({
      orders: [
        ord("2026-10-20", { amountOre: 10_000, titleId: "t-a" }),
        ord("2026-11-05", { amountOre: 20_000, titleId: "t-b" }),
      ],
      prices: [price("t-a", 15_000, "2026-10-01"), price("t-b", 10_000, "2026-10-01")],
      agreements: [split(lossTreatment)],
    });

  it("förlust 'zero': oktober ger 0 kr och november 50 kr, som månadsrapporterna", () => {
    const range = buildStoreReport(src("zero"), "s-1", { start: "2026-10-15", end: "2026-11-30" });
    expect(range.compensation.splits).toHaveLength(2);
    expect(range.compensation.splits[0]).toMatchObject({
      range: { start: "2026-10-15", end: "2026-10-31" },
      orders: 1,
      profitOre: -5_000,
      storeShareOre: 0,
    });
    expect(range.compensation.splits[1]).toMatchObject({
      range: { start: "2026-11-01", end: "2026-11-30" },
      orders: 1,
      profitOre: 10_000,
      storeShareOre: 5_000,
    });
    const oct = buildStoreReport(src("zero"), "s-1", "2026-10").compensation.shareOre;
    const nov = buildStoreReport(src("zero"), "s-1", "2026-11").compensation.shareOre;
    expect(range.compensation.shareOre).toBe(oct + nov);
    expect(range.compensation.shareOre).toBe(5_000);
    const labels = range.compensation.steps
      .filter((s) => s.kind === "share")
      .map((s) => plain(s.label));
    expect(labels).toEqual(["Er andel 50 % (15–31 okt. 2026)", "Er andel 50 % (november 2026)"]);
  });

  it("förlust 'proportional': summan av månaderna", () => {
    const range = buildStoreReport(src("proportional"), "s-1", {
      start: "2026-10-15",
      end: "2026-11-14",
    });
    expect(range.compensation.shareOre).toBe(-2_500 + 5_000);
  });

  it("inom en månad: andelen räknas bara på intervallets dagar", () => {
    const r = buildStoreReport(src("zero"), "s-1", { start: "2026-11-01", end: "2026-11-14" });
    expect(r.compensation.splits).toHaveLength(1);
    expect(r.compensation.splits[0]).toMatchObject({ profitOre: 10_000, storeShareOre: 5_000 });
  });
});
