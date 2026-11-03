import { describe, expect, it } from "vitest";
import { DomainError, type StoreAgreement } from "@/domain";
import { MISSING_PRICES_MESSAGE, assertStoreReportSafe, buildStoreReport } from "./store-report";
import { ord, price, sources } from "./testing/fixtures";

const plain = (s: string) => s.replace(/ /g, " ");

const split = (extra: Partial<StoreAgreement> = {}): StoreAgreement => ({
  storeId: "s-1",
  validFrom: "2026-10-15",
  validTo: null,
  commissionBp: 5_000,
  monthlyRentOre: null,
  commissionBase: "profit_after_costs",
  lossTreatment: "zero",
  ...extra,
});

// Två pack à 199 kr (inköp 130 kr) och ett à 249 kr (inköp 165 kr).
const orders = [
  ord("2026-11-02", { amountOre: 19_900, titleId: "t-a" }),
  ord("2026-11-09", { amountOre: 19_900, titleId: "t-a" }),
  ord("2026-11-20", { amountOre: 24_900, titleId: "t-b" }),
];
const prices = [price("t-a", 13_000, "2026-10-15"), price("t-b", 16_500, "2026-10-15")];

describe("butiksrapport med vinstdelning 50/50", () => {
  it("avtal med VMB-avdrag: visar försäljning, VMB-moms, inköp, kortavgifter, vinst och andel", () => {
    const src = sources({
      orders,
      prices,
      agreements: [split({ vmbBeforeSplit: true })],
      settings: { vatRateBp: 0, cardFeeBp: 200 },
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    const c = r.compensation;
    expect(c.model).toBe("profit_split");
    expect(plain(c.modelText)).toBe(
      "50 % av vinsten efter kostnader (VMB-moms dras före delning), giltigt från 15 oktober 2026.",
    );
    expect(c.splits).toHaveLength(1);
    // Försäljning 647 kr, inköp 425 kr → marginal 222 kr, VMB-moms 44,40 kr.
    // Kortavgift 2 % per order: 398 + 398 + 498 = 1 294 öre.
    // Vinst = 64 700 − 4 440 − 42 500 − 1 294 = 16 466 öre; butiken 8 233 öre.
    expect(c.splits[0]).toMatchObject({
      salesInclVatOre: 64_700,
      vmbVatOre: 4_440,
      purchasesOre: 42_500,
      cardFeesOre: 1_294,
      profitOre: 16_466,
      storeShareOre: 8_233,
      operatorShareOre: 8_233,
      pending: false,
    });
    expect(c.shareOre).toBe(8_233);
    expect(c.totalOre).toBe(8_233);
    expect(c.steps.map((s) => s.kind)).toEqual(["share", "total"]);
    expect(plain(c.steps[0]!.label)).toBe("Er andel 50 %");
    expect(plain(c.steps[0]!.calculation)).toBe("50 % av 164,66 kr = 82,33 kr");
    expect(c.steps[1]!.label).toBe("Er ersättning");
    // Rapporten får ändå inte visa inköp utanför ersättningen.
    expect(() => assertStoreReportSafe(r)).not.toThrow();
    expect(JSON.stringify(r.topTitles)).not.toMatch(/purchase|profit/i);
  });

  it("standard utan VMB-avdrag: andelen räknas på vinsten efter inköp och kortavgifter", () => {
    const src = sources({
      orders,
      prices,
      agreements: [split()],
      settings: { vatRateBp: 0, cardFeeBp: 200 },
    });
    const c = buildStoreReport(src, "s-1", "2026-11").compensation;
    expect(plain(c.modelText)).toBe(
      "50 % av vinsten efter kostnader, giltigt från 15 oktober 2026.",
    );
    // Vinst = 64 700 − 42 500 − 1 294 = 20 906 öre; butiken 10 453 öre.
    expect(c.splits[0]).toMatchObject({
      vmbBeforeSplit: false,
      vmbVatOre: 0,
      profitOre: 20_906,
      storeShareOre: 10_453,
    });
  });

  it("förlust: butiken får 0 kr", () => {
    const src = sources({
      orders: [ord("2026-11-02", { amountOre: 10_000, titleId: "t-a" })],
      prices: [price("t-a", 13_000, "2026-10-15")],
      agreements: [split()],
    });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.compensation.splits[0]!.profitOre).toBe(-3_000);
    expect(r.compensation.totalOre).toBe(0);
    expect(plain(r.compensation.steps[0]!.calculation)).toBe(
      "Ingen vinst (−30,00 kr), andelen blir 0 kr",
    );
  });

  it("hyra läggs till andelen", () => {
    const src = sources({ orders, prices, agreements: [split({ monthlyRentOre: 50_000 })] });
    const r = buildStoreReport(src, "s-1", "2026-11");
    expect(r.compensation.model).toBe("profit_split_and_rent");
    expect(r.compensation.totalOre).toBe(r.compensation.shareOre + 50_000);
    expect(r.compensation.steps.map((s) => s.kind)).toEqual(["share", "rent", "total"]);
  });

  it("saknat inköpspris stoppar rapporten med en rad om vad som saknas", () => {
    const src = sources({ orders, prices: [prices[0]!], agreements: [split()] });
    let error: unknown;
    try {
      buildStoreReport(src, "s-1", "2026-11");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("missing_price");
    expect((error as DomainError).message.startsWith(MISSING_PRICES_MESSAGE)).toBe(true);
    expect(plain((error as DomainError).message)).toContain("1 order saknar inköpspris");
  });

  it("portalen (pendingSplit): andelen visas som ej räknad, inga inköp", () => {
    const src = sources({ orders, prices: [], agreements: [split()] });
    const r = buildStoreReport(src, "s-1", "2026-11", { pendingSplit: true });
    expect(r.compensation.pending).toBe(true);
    expect(r.compensation.splits[0]).toMatchObject({
      pending: true,
      salesInclVatOre: 64_700,
      purchasesOre: 0,
      storeShareOre: 0,
    });
    expect(r.compensation.steps[0]!.calculation).toBe("Räknas i månadsrapporten");
  });
});
