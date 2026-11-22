/**
 * Butikens andel vid vinstdelning räknas på pris mot kund från CUSTOMER_PRICE_SHARE_FROM
 * (ägarens beslut, profit-split.ts `shareCostOre`). Vår vinst räknas fortfarande på vårt
 * inköpspris, så skillnaden stannar hos oss. Före datumet, utan pris mot kund och för
 * avtal med provision eller hyra ändras ingenting.
 */

import { describe, expect, it } from "vitest";

import { priceChangeScenario } from "@/analytics/scenarios/price-change";
import { buildStoreReport, type ReportSources } from "@/reports";

import { addDays } from "./dates";
import { buildLedger } from "./ledger";
import { profitability } from "./profitability";
import { CUSTOMER_PRICE_SHARE_FROM, shareCostOre } from "./profit-split";
import { agreement, NO_TAX, order, placement } from "./testing/fixtures";
import type { ProfitabilityInput, PurchasePrice } from "./types";

const FROM = CUSTOMER_PRICE_SHARE_FROM;
const DAY_BEFORE = addDays(FROM, -1);

const split = agreement("s-1", "2026-01-01", null, {
  commissionBp: 5_000,
  commissionBase: "profit_after_costs",
});

function cp(
  titleId: string,
  unitCostOre: number,
  customerPriceOre: number | null,
  validFrom = "2026-01-01",
): PurchasePrice {
  return { titleId, unitCostOre, customerPriceOre, validFrom };
}

function input(extra: Partial<ProfitabilityInput> = {}): ProfitabilityInput {
  return {
    orders: [
      order({ id: "a", businessDate: "2026-11-02", amountOre: 20_000, titleId: "t-a" }),
      order({ id: "b", businessDate: "2026-11-03", amountOre: 20_000, titleId: "t-a" }),
      order({ id: "c", businessDate: "2026-11-20", amountOre: 30_000, titleId: "t-b" }),
    ],
    prices: [cp("t-a", 10_000, 12_000), cp("t-b", 15_000, 18_000)],
    agreements: [split],
    placements: [placement("m-1", "s-1", "2026-01-01", null)],
    settings: NO_TAX,
    period: { start: "2026-11-01", end: "2026-11-30" },
    ...extra,
  };
}

const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);

describe("shareCostOre", () => {
  it("datumet är 1 nov. 2026", () => {
    expect(CUSTOMER_PRICE_SHARE_FROM).toBe("2026-11-01");
  });

  it("från datumet: pris mot kund; före: vårt pris; utan pris mot kund: vårt pris", () => {
    const p = { unitCostOre: 10_000, customerPriceOre: 12_000 };
    expect(shareCostOre(p, FROM)).toBe(12_000);
    expect(shareCostOre(p, "2027-03-15")).toBe(12_000);
    expect(shareCostOre(p, DAY_BEFORE)).toBe(10_000);
    expect(shareCostOre({ unitCostOre: 10_000, customerPriceOre: null }, FROM)).toBe(10_000);
    expect(shareCostOre({ unitCostOre: 10_000 }, FROM)).toBe(10_000);
    // 0 kr är ett angivet pris (inte "saknas").
    expect(shareCostOre({ unitCostOre: 10_000, customerPriceOre: 0 }, FROM)).toBe(0);
    expect(shareCostOre(null, FROM)).toBeNull();
  });
});

describe("liggaren: andelen på pris mot kund, vår vinst på vårt pris", () => {
  it("butikens andel blir mindre och vår del större, med exakt skillnaden × 50 %", () => {
    const withCp = buildLedger(input());
    const without = buildLedger(
      input({ prices: [cp("t-a", 10_000, null), cp("t-b", 15_000, null)] }),
    );
    const s = withCp.profitSplits[0]!;
    // Försäljning 70 000. Andelens inköp = 2 × 12 000 + 18 000 = 42 000 (vårt: 35 000).
    expect(s.result).toMatchObject({
      salesInclVatOre: 70_000,
      purchasesOre: 42_000,
      profitOre: 28_000,
      storeShareOre: 14_000,
    });
    expect(s.ourPurchasesOre).toBe(35_000);
    // Utan pris mot kund: andelen på vårt pris (som före beslutet).
    expect(without.profitSplits[0]!.result).toMatchObject({
      purchasesOre: 35_000,
      storeShareOre: 17_500,
    });
    expect(without.profitSplits[0]!.ourPurchasesOre).toBe(35_000);

    // Vår vinst räknas på vårt verkliga inköp: intäkt − 35 000 − butikens andel.
    const ours = profitability(input(), "store").totals;
    expect(ours.costOre).toBe(35_000);
    expect(ours.commissionOre).toBe(14_000);
    expect(ours.profitAfterShareOre).toBe(70_000 - 35_000 - 14_000);
    const before = profitability(
      input({ prices: [cp("t-a", 10_000, null), cp("t-b", 15_000, null)] }),
      "store",
    ).totals;
    expect(before.profitAfterShareOre).toBe(70_000 - 35_000 - 17_500);
    // Skillnaden (pris mot kund − vårt pris) × pack = 7 000 kr; hälften stannar hos oss.
    expect(ours.profitAfterShareOre - before.profitAfterShareOre).toBe(3_500);
    // Liggarens order bär vårt inköp; andelen är fördelad exakt.
    expect(sum(withCp.entries.map((e) => e.costOre))).toBe(35_000);
    expect(sum(withCp.entries.map((e) => e.shareCostOre))).toBe(42_000);
    expect(sum(withCp.entries.map((e) => e.commissionOre))).toBe(14_000);
  });

  it("andelen fördelas på orderna efter andelens vinst per order (pris mot kund)", () => {
    const ledger = buildLedger(input());
    const byId = new Map(ledger.entries.map((e) => [e.order.id, e.commissionOre]));
    // Vinst per order på pris mot kund: 8 000, 8 000, 12 000 (summa 28 000), andel 14 000.
    expect([byId.get("a"), byId.get("b"), byId.get("c")]).toEqual([4_000, 4_000, 6_000]);
  });

  it("före datumet ändras ingenting, inte ens med pris mot kund", () => {
    const oct = {
      orders: [
        order({ id: "a", businessDate: "2026-10-02", amountOre: 20_000, titleId: "t-a" }),
        order({ id: "c", businessDate: DAY_BEFORE, amountOre: 30_000, titleId: "t-b" }),
      ],
      period: { start: "2026-10-01", end: "2026-10-31" },
    };
    const withCp = buildLedger(input(oct));
    const without = buildLedger(
      input({ ...oct, prices: [cp("t-a", 10_000, null), cp("t-b", 15_000, null)] }),
    );
    expect(withCp.profitSplits[0]!.result).toEqual(without.profitSplits[0]!.result);
    expect(withCp.profitSplits[0]!.result).toMatchObject({
      purchasesOre: 25_000,
      storeShareOre: 12_500,
    });
    expect(withCp.entries.map((e) => e.commissionOre)).toEqual(
      without.entries.map((e) => e.commissionOre),
    );
  });

  it("blandade prisperioder i en månad: varje order får sin periods pris mot kund, eller vårt pris", () => {
    const ledger = buildLedger(
      input({
        orders: [
          order({ id: "a", businessDate: "2026-11-02", amountOre: 20_000, titleId: "t-a" }),
          order({ id: "b", businessDate: "2026-11-15", amountOre: 20_000, titleId: "t-a" }),
          order({ id: "c", businessDate: "2026-11-25", amountOre: 20_000, titleId: "t-a" }),
        ],
        prices: [
          cp("t-a", 10_000, 12_000, "2026-01-01"),
          // Ny period utan pris mot kund: vårt pris gäller för andelen.
          cp("t-a", 11_000, null, "2026-11-10"),
          cp("t-a", 11_000, 16_000, "2026-11-20"),
        ],
      }),
    );
    const s = ledger.profitSplits[0]!;
    expect(ledger.entries.map((e) => e.shareCostOre)).toEqual([12_000, 11_000, 16_000]);
    expect(ledger.entries.map((e) => e.costOre)).toEqual([10_000, 11_000, 11_000]);
    expect(s.result.purchasesOre).toBe(39_000);
    expect(s.ourPurchasesOre).toBe(32_000);
    expect(s.result.storeShareOre).toBe((60_000 - 39_000) / 2);
  });

  it("en period som börjar före datumet: bara dagarna från datumet räknas på pris mot kund", () => {
    const ledger = buildLedger(
      input({
        orders: [
          order({ id: "a", businessDate: "2026-10-31", amountOre: 20_000, titleId: "t-a" }),
          order({ id: "b", businessDate: "2026-11-01", amountOre: 20_000, titleId: "t-a" }),
        ],
        period: { start: "2026-10-01", end: "2026-11-30" },
      }),
    );
    const [oct, nov] = ledger.profitSplits;
    expect(oct!.month).toBe("2026-10");
    expect(oct!.result.purchasesOre).toBe(10_000);
    expect(oct!.result.storeShareOre).toBe(5_000);
    expect(nov!.result.purchasesOre).toBe(12_000);
    expect(nov!.result.storeShareOre).toBe(4_000);
  });

  it("förlust: underlaget på pris mot kund kan gå med förlust; 'zero' ger 0, vi behåller vår vinst", () => {
    const loss = input({
      orders: [order({ id: "a", businessDate: "2026-11-05", amountOre: 11_000, titleId: "t-a" })],
      // Vårt pris 10 000 (vinst 1 000), pris mot kund 12 000 (underlaget −1 000).
      prices: [cp("t-a", 10_000, 12_000)],
    });
    const s = buildLedger(loss).profitSplits[0]!;
    expect(s.result.profitOre).toBe(-1_000);
    expect(s.result.storeShareOre).toBe(0);
    const totals = profitability(loss, "store").totals;
    expect(totals.commissionOre).toBe(0);
    expect(totals.profitAfterShareOre).toBe(1_000);

    const prop = buildLedger({
      ...loss,
      agreements: [
        agreement("s-1", "2026-01-01", null, {
          commissionBp: 5_000,
          commissionBase: "profit_after_costs",
          lossTreatment: "proportional",
        }),
      ],
    }).profitSplits[0]!;
    expect(prop.result.storeShareOre).toBe(-500);
  });

  it("provision på försäljningen och hyra påverkas inte", () => {
    const commission = agreement("s-1", "2026-01-01", null, {
      commissionBp: 1_000,
      monthlyRentOre: 30_000,
    });
    const a = profitability(input({ agreements: [commission] }), "store").totals;
    const b = profitability(
      input({
        agreements: [commission],
        prices: [cp("t-a", 10_000, null), cp("t-b", 15_000, null)],
      }),
      "store",
    ).totals;
    expect(a).toEqual(b);
    expect(buildLedger(input({ agreements: [commission] })).profitSplits).toEqual([]);
  });

  it("VMB före delningen räknas på underlagets marginal (pris mot kund)", () => {
    const vmb = agreement("s-1", "2026-01-01", null, {
      commissionBp: 5_000,
      commissionBase: "profit_after_costs",
      vmbBeforeSplit: true,
    });
    const s = buildLedger(input({ agreements: [vmb] })).profitSplits[0]!;
    // Marginal 70 000 − 42 000 = 28 000, VMB 5 600, vinst 22 400, butiken 11 200.
    expect(s.result).toMatchObject({ marginOre: 28_000, vmbVatOre: 5_600, storeShareOre: 11_200 });
  });

  it("ogiltigt pris mot kund stoppas", () => {
    expect(() => buildLedger(input({ prices: [cp("t-a", 10_000, -1)] }))).toThrow(
      /Priset mot kund/,
    );
  });
});

describe("butiksrapporten visar underlaget på pris mot kund, aldrig vårt pris", () => {
  const sources = (prices: PurchasePrice[]): ReportSources => ({
    ...input({ prices }),
    stores: [{ id: "s-1", name: "Butiken" }],
    machines: [{ id: "m-1", name: "Automat", code: "BL-001" }],
    titles: [
      { id: "t-a", name: "Titel A" },
      { id: "t-b", name: "Titel B" },
    ],
  });

  it("inköpet i uträkningen är pris mot kund, och vårt inköp finns ingenstans i rapporten", () => {
    const report = buildStoreReport(
      sources([cp("t-a", 10_003, 12_000), cp("t-b", 15_007, 18_000)]),
      "s-1",
      "2026-11",
    );
    const [x] = report.compensation.splits;
    expect(x).toMatchObject({ purchasesOre: 42_000, profitOre: 28_000, storeShareOre: 14_000 });
    expect(report.compensation.shareOre).toBe(14_000);
    // Vårt inköp (2 × 10 003 + 15 007 = 35 013) och våra styckpriser syns inte, inte heller
    // vår verkliga vinst (70 000 − 35 013 − 14 000 = 20 987) eller resten efter andelen.
    const text = JSON.stringify(report);
    for (const ours of ["35013", "10003", "15007", "20987", "34987", "17493", "17494"]) {
      expect(text, ours).not.toContain(ours);
    }
    expect(text).not.toMatch(/ourPurchases|shareCost/);
  });

  it("utan pris mot kund: som förut (vårt pris är underlaget, enligt avtalet)", () => {
    const report = buildStoreReport(
      sources([cp("t-a", 10_000, null), cp("t-b", 15_000, null)]),
      "s-1",
      "2026-11",
    );
    expect(report.compensation.splits[0]).toMatchObject({
      purchasesOre: 35_000,
      storeShareOre: 17_500,
    });
  });
});

describe("prisändringsscenariot räknar andelens ändring på pris mot kund", () => {
  it("andelen ändras med andel × ändringen i underlagets vinst", () => {
    const base = { ...input(), titleId: "t-a", deltaOre: 1_000 };
    const r = priceChangeScenario(base);
    const s = priceChangeScenario({
      ...base,
      prices: [cp("t-a", 10_000, null), cp("t-b", 15_000, null)],
    });
    // Ingen VMB: ordervinstens ändring är densamma (+1 000 per order), så skillnaden mellan
    // scenarierna är bara utgångsläget (andelen på pris mot kund är 2 000 kr mindre per
    // titel A-order × 2 ⇒ vårt bidrag 2 000 större).
    expect(r.base.contributionOre - s.base.contributionOre).toBe(2_000);
    expect(r.selected.profitChangeOre).toBe(s.selected.profitChangeOre);
  });
});
