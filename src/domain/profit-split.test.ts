import { describe, expect, it } from "vitest";
import { buildLedger } from "./ledger";
import { profitability } from "./profitability";
import { profitSplit, vmbVatOfMargin } from "./profit-split";
import { agreement, NO_TAX, order, placement, price } from "./testing/fixtures";
import type { ProfitabilityInput } from "./types";

describe("profitSplit", () => {
  it("50/50: försäljning − VMB-moms − inköp − kortavgift, hälften till butiken", () => {
    // 10 000 kr sålt, 6 000 kr inköp: marginal 4 000, VMB-moms 800.
    // Vinst = 10 000 − 800 − 6 000 − 150 = 3 050 kr; butiken 1 525 kr.
    const r = profitSplit({
      salesInclVatOre: 1_000_000,
      purchasesOre: 600_000,
      cardFeesOre: 15_000,
      shareBp: 5_000,
      lossTreatment: "zero",
      vmbBeforeSplit: true,
    });
    expect(r).toMatchObject({
      marginOre: 400_000,
      vmbVatOre: 80_000,
      profitOre: 305_000,
      storeShareOre: 152_500,
      operatorShareOre: 152_500,
    });
  });

  it("avrundar en gång, halva öre bort från noll; resten blir vår del", () => {
    const r = profitSplit({
      salesInclVatOre: 101,
      purchasesOre: 0,
      cardFeesOre: 0,
      shareBp: 5_000,
      lossTreatment: "zero",
      vmbBeforeSplit: true,
    });
    // VMB = round(101 × 0,2) = 20; vinst 81; butiken round(40,5) = 41; vi 40.
    expect([r.vmbVatOre, r.profitOre, r.storeShareOre, r.operatorShareOre]).toEqual([
      20, 81, 41, 40,
    ]);
  });

  it("standard utan VMB-avdrag: butikens andel = andel × vinst efter inköp och kortavgifter", () => {
    const base = {
      salesInclVatOre: 1_000_000,
      purchasesOre: 600_000,
      cardFeesOre: 15_000,
      shareBp: 5_000,
      lossTreatment: "zero" as const,
    };
    const r = profitSplit(base);
    expect(profitSplit({ ...base, vmbBeforeSplit: false })).toEqual(r);
    // Vinst = 10 000 − 6 000 − 150 = 3 850 kr; butiken 1 925 kr.
    expect(r).toMatchObject({
      marginOre: 400_000,
      vmbVatOre: 0,
      vmbBeforeSplit: false,
      profitOre: 385_000,
      storeShareOre: 192_500,
      operatorShareOre: 192_500,
    });
  });

  it("negativ marginal ger ingen VMB-moms", () => {
    expect(vmbVatOfMargin(-500)).toBe(0);
    expect(vmbVatOfMargin(0)).toBe(0);
    expect(vmbVatOfMargin(12_345)).toBe(2_469);
  });

  it("förlust: 'zero' ger butiken 0, 'proportional' delar förlusten", () => {
    const base = {
      salesInclVatOre: 10_000,
      purchasesOre: 9_000,
      cardFeesOre: 1_401,
      shareBp: 5_000,
      vmbBeforeSplit: true,
    };
    // marginal 1 000 → VMB 200; vinst 10 000 − 200 − 9 000 − 1 401 = −601
    const zero = profitSplit({ ...base, lossTreatment: "zero" });
    expect(zero).toMatchObject({ profitOre: -601, storeShareOre: 0, operatorShareOre: -601 });
    const prop = profitSplit({ ...base, lossTreatment: "proportional" });
    expect(prop).toMatchObject({ profitOre: -601, storeShareOre: -301, operatorShareOre: -300 });
  });

  it("ogiltig andel stoppas", () => {
    expect(() =>
      profitSplit({
        salesInclVatOre: 1,
        purchasesOre: 0,
        cardFeesOre: 0,
        shareBp: 10_001,
        lossTreatment: "zero",
      }),
    ).toThrow();
  });
});

describe("liggaren med vinstdelning", () => {
  // Avtalet drar av VMB före delningen (valet på); standard utan VMB testas nedan.
  const split = agreement("s-1", "2026-01-01", null, {
    commissionBp: 5_000,
    commissionBase: "profit_after_costs",
    vmbBeforeSplit: true,
  });
  function input(extra: Partial<ProfitabilityInput> = {}): ProfitabilityInput {
    return {
      orders: [
        order({ id: "a", businessDate: "2026-11-02", amountOre: 19_900, titleId: "t-a" }),
        order({ id: "b", businessDate: "2026-11-03", amountOre: 19_900, titleId: "t-a" }),
        order({ id: "c", businessDate: "2026-11-20", amountOre: 24_900, titleId: "t-b" }),
      ],
      prices: [price("t-a", 13_000, "2026-01-01"), price("t-b", 16_500, "2026-01-01")],
      agreements: [split],
      placements: [placement("m-1", "s-1", "2026-01-01", null)],
      settings: NO_TAX,
      period: { start: "2026-11-01", end: "2026-11-30" },
      ...extra,
    };
  }

  it("standardavtal (utan VMB-avdrag): butikens andel = bp × vinst efter inköp och kortavgifter", () => {
    const plain = agreement("s-1", "2026-01-01", null, {
      commissionBp: 5_000,
      commissionBase: "profit_after_costs",
    });
    const ledger = buildLedger(input({ agreements: [plain] }));
    const s = ledger.profitSplits[0]!;
    const fees = ledger.entries.reduce((a, e) => a + e.cardFeeOre, 0);
    // Försäljning 64 700, inköp 42 500, ingen VMB-moms.
    expect(s.result.vmbVatOre).toBe(0);
    expect(s.result.vmbBeforeSplit).toBe(false);
    expect(s.result.profitOre).toBe(64_700 - 42_500 - fees);
    expect(s.result.storeShareOre).toBe(Math.round((5_000 * (64_700 - 42_500 - fees)) / 10_000));
    expect(ledger.entries.reduce((a, e) => a + e.commissionOre, 0)).toBe(s.result.storeShareOre);
  });

  it("räknar per butik och månad och fördelar andelen exakt på orderna", () => {
    const ledger = buildLedger(input());
    // Försäljning 64 700, inköp 42 500, marginal 22 200, VMB 4 440, vinst 17 760, butiken 8 880.
    expect(ledger.profitSplits).toHaveLength(1);
    const s = ledger.profitSplits[0]!;
    expect(s).toMatchObject({ storeId: "s-1", month: "2026-11", orders: 3, unpricedOrders: 0 });
    expect(s.result).toMatchObject({
      salesInclVatOre: 64_700,
      purchasesOre: 42_500,
      vmbVatOre: 4_440,
      profitOre: 17_760,
      storeShareOre: 8_880,
    });
    const shares = ledger.entries.map((e) => e.commissionOre);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(8_880);
    // Vikt = belopp: 8 880 × 19 900 / 64 700 = 2 731,2…, 24 900 → 3 417,5…
    expect(shares).toEqual([2_731, 2_731, 3_418]);
    const totals = profitability(input(), "store").totals;
    expect(totals.commissionOre).toBe(8_880);
  });

  it("order utan inköpspris bär ingen andel och räknas upp", () => {
    const ledger = buildLedger(input({ prices: [price("t-a", 13_000, "2026-01-01")] }));
    const s = ledger.profitSplits[0]!;
    expect(s.unpricedOrders).toBe(1);
    expect(s.unpricedTitleIds).toEqual(["t-b"]);
    expect(s.result.salesInclVatOre).toBe(39_800);
    expect(ledger.entries.find((e) => e.order.id === "c")!.commissionOre).toBe(0);
  });

  it("avtalsbyte mitt i månaden: en uträkning per avtal", () => {
    const ledger = buildLedger(
      input({
        agreements: [
          agreement("s-1", "2026-01-01", "2026-11-10", { commissionBp: 1_000 }),
          agreement("s-1", "2026-11-11", null, {
            commissionBp: 5_000,
            commissionBase: "profit_after_costs",
          }),
        ],
      }),
    );
    expect(ledger.profitSplits.map((s) => [s.range.start, s.range.end, s.orders])).toEqual([
      ["2026-11-11", "2026-11-30", 1],
    ]);
    // Provision 10 % på de två första orderna, vinstdelning på den sista (utan VMB-avdrag:
    // 50 % av 24 900 − 16 500 = 4 200).
    expect(ledger.entries.map((e) => e.commissionOre)).toEqual([1_990, 1_990, 4_200]);
  });

  it("månad utan försäljning ger en rad med 0", () => {
    const ledger = buildLedger(input({ orders: [] }));
    expect(ledger.profitSplits[0]!.result.storeShareOre).toBe(0);
  });

  it("återbetalningar dras från försäljningen i återbetalningens månad", () => {
    const refunds = [
      { machineId: "m-1", refundedOn: "2026-11-15", amountOre: 19_900 },
      // Utanför perioden och utan automat: räknas inte.
      { machineId: "m-1", refundedOn: "2026-12-01", amountOre: 5_000 },
      { machineId: null, refundedOn: "2026-11-15", amountOre: 5_000 },
    ];
    const ledger = buildLedger(input({ refunds }));
    const r = ledger.profitSplits[0]!.result;
    // 64 700 − 19 900 = 44 800; marginal 2 300 → VMB 460; vinst 44 800 − 460 − 42 500 = 1 840.
    expect(r).toMatchObject({
      salesInclVatOre: 64_700,
      refundsOre: 19_900,
      marginOre: 2_300,
      vmbVatOre: 460,
      profitOre: 1_840,
      storeShareOre: 920,
    });
    expect(ledger.entries.reduce((a, e) => a + e.commissionOre, 0)).toBe(920);
  });

  it("delmånad markeras som preliminär", () => {
    const whole = buildLedger(input());
    expect(whole.profitSplits[0]!.partialMonth).toBe(false);
    const part = buildLedger(input({ period: { start: "2026-11-01", end: "2026-11-10" } }));
    expect(part.profitSplits[0]!.partialMonth).toBe(true);
  });
});
