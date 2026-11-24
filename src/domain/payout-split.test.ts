import { describe, expect, it } from "vitest";

import {
  shareTruncated,
  splitPayout,
  type PartnerSegment,
  type SplitInput,
  type SplitSlice,
} from "./payout-split";

const kr = (v: number) => Math.round(v * 100);

function slice(over: Partial<SplitSlice> & { storeId: string | null }): SplitSlice {
  return {
    payee: over.storeId ? { kind: "store", id: over.storeId } : null,
    month: "2026-11",
    from: "2026-11-03",
    to: "2026-11-09",
    orders: 10,
    grossOre: 0,
    refundsOre: 0,
    costOre: 0,
    unpricedOrders: 0,
    storeShareOre: 0,
    shareSource: "live",
    hasAgreement: true,
    ...over,
  };
}

function segment(over: Partial<PartnerSegment> = {}): PartnerSegment {
  return {
    agreementId: "p1",
    reimburse: true,
    bp: 5000,
    from: "2026-11-03",
    to: "2026-11-09",
    costOre: 0,
    packs: 0,
    weightOre: 1,
    ...over,
  };
}

/** Det genomräknade exemplet i designen: 48 210 kr för 3–9 nov. */
function example(over: Partial<SplitInput> = {}): SplitInput {
  return {
    amountOre: kr(48_210),
    slices: [
      slice({ storeId: "A", grossOre: kr(32_000), costOre: kr(16_000), storeShareOre: kr(6_500) }),
      slice({ storeId: "B", grossOre: kr(20_000), costOre: kr(10_000), storeShareOre: kr(3_200) }),
    ],
    trueUps: [],
    vat: { mode: "vmb", carryInOre: 0, vatRateBp: 0 },
    partner: { segments: [segment({ costOre: kr(26_000), packs: 520 })], carryInOre: 0 },
    expectedNetOre: kr(48_300),
    ...over,
  };
}

const sumLines = (r: ReturnType<typeof splitPayout>) =>
  r.lines.reduce((a, l) => a + l.amountOre, 0);
const line = (r: ReturnType<typeof splitPayout>, kind: string) =>
  r.lines.find((l) => l.kind === kind)!;

describe("splitPayout", () => {
  it("räknar designens exempel exakt", () => {
    const r = splitPayout(example());
    expect(r.totals.storesOre).toBe(kr(9_700));
    expect(r.totals.vatOre).toBe(kr(5_200));
    expect(r.totals.profitOre).toBe(kr(7_310));
    expect(r.totals.partnerReimbOre).toBe(kr(26_000));
    expect(r.totals.partnerProfitOre).toBe(kr(3_655));
    expect(line(r, "partner").amountOre).toBe(kr(29_655));
    expect(line(r, "owner").amountOre).toBe(kr(3_655));
    expect(sumLines(r)).toBe(kr(48_210));
    expect(r.lines.filter((l) => l.kind === "store").map((l) => l.amountOre)).toEqual([
      kr(6_500),
      kr(3_200),
    ]);
    // 48 210 mot väntade 48 300: 90 kr är inom 1 %.
    expect(r.warnings.map((w) => w.code)).not.toContain("DIFF_EXPECTED");
  });

  it("ger ägaren det udda öret", () => {
    const r = splitPayout(example({ amountOre: kr(48_210) + 1 }));
    expect(r.totals.profitOre).toBe(731_001);
    expect(r.totals.partnerProfitOre).toBe(365_500);
    expect(line(r, "owner").amountOre).toBe(365_501);
    expect(sumLines(r)).toBe(kr(48_210) + 1);
  });

  it("drar återbetalningar från marginalen för momsen", () => {
    const r = splitPayout(
      example({
        slices: [
          slice({
            storeId: "A",
            grossOre: kr(52_000),
            refundsOre: kr(1_000),
            costOre: kr(26_000),
            storeShareOre: kr(9_700),
          }),
        ],
      }),
    );
    expect(r.totals.vatOre).toBe(kr(5_000));
    expect(sumLines(r)).toBe(kr(48_210));
  });

  it("delar en utbetalning över okt/nov i två delar med olika källa", () => {
    const r = splitPayout(
      example({
        slices: [
          slice({
            storeId: "A",
            month: "2026-10",
            from: "2026-10-28",
            to: "2026-10-31",
            grossOre: kr(20_000),
            costOre: kr(10_000),
            storeShareOre: kr(3_000),
            shareSource: "settlement",
          }),
          slice({
            storeId: "A",
            month: "2026-11",
            from: "2026-11-01",
            to: "2026-11-03",
            grossOre: kr(32_000),
            costOre: kr(16_000),
            storeShareOre: kr(6_700),
          }),
        ],
      }),
    );
    const a = r.lines.find((l) => l.kind === "store")!;
    expect(a.amountOre).toBe(kr(9_700));
    expect("stores" in a && a.stores.map((c) => c.source)).toEqual(["settlement", "live"]);
    expect(line(r, "vat_reserve").amountOre).toBe(kr(2_000) + kr(3_200));
    expect(r.warnings.find((w) => w.code === "LIVE_ESTIMATE")).toEqual({
      code: "LIVE_ESTIMATE",
      months: ["2026-11"],
    });
  });

  it("för för liten utbetalning: ägaren negativ, partnern skuld till nästa gång", () => {
    const r = splitPayout(example({ amountOre: kr(30_000) }));
    // vinst = 30 000 − 9 700 − 26 000 − 5 200 = −10 900, partnerns del −5 450
    expect(r.totals.profitOre).toBe(kr(-10_900));
    expect(line(r, "partner").amountOre).toBe(kr(20_550));
    expect(line(r, "owner").amountOre).toBe(kr(-5_450));
    expect(r.warnings.map((w) => w.code)).toContain("NEGATIVE_OWNER");
    expect(sumLines(r)).toBe(kr(30_000));
  });

  it("för partnerns förlust vidare när den är större än inköpet", () => {
    const r = splitPayout(
      example({
        amountOre: kr(100),
        partner: { segments: [segment({ costOre: kr(100), packs: 2 })], carryInOre: 0 },
        slices: [
          slice({ storeId: "A", grossOre: kr(500), costOre: kr(100), storeShareOre: kr(5_000) }),
        ],
      }),
    );
    expect(line(r, "partner").amountOre).toBe(0);
    expect(r.totals.partnerCarryOutOre).toBeLessThan(0);
    expect(sumLines(r)).toBe(kr(100));
    const next = splitPayout(
      example({
        partner: {
          segments: [segment({ costOre: kr(26_000), packs: 520 })],
          carryInOre: r.totals.partnerCarryOutOre,
        },
      }),
    );
    expect(line(next, "partner").amountOre).toBe(kr(29_655) + r.totals.partnerCarryOutOre);
    expect(sumLines(next)).toBe(kr(48_210));
  });

  it("lägger en justering efter månadsavräkningen på butikens rad", () => {
    const r = splitPayout(
      example({
        trueUps: [
          { storeId: "A", payee: { kind: "store", id: "A" }, month: "2026-10", deltaOre: 300 },
        ],
      }),
    );
    const a = r.lines.find((l) => l.kind === "store" && l.payeeId === "A")!;
    expect(a.amountOre).toBe(kr(6_500) + 300);
    expect(r.totals.profitOre).toBe(kr(7_310) - 300);
    expect(sumLines(r)).toBe(kr(48_210));
  });

  it("håller butikens rad på 0 när justeringen nedåt är större än andelen", () => {
    const r = splitPayout(
      example({
        trueUps: [
          {
            storeId: "B",
            payee: { kind: "store", id: "B" },
            month: "2026-10",
            deltaOre: kr(-5_000),
          },
        ],
      }),
    );
    const b = r.lines.find((l) => l.kind === "store" && l.payeeId === "B")!;
    expect(b.amountOre).toBe(0);
    expect(r.warnings).toContainEqual({ code: "SHARE_HELD", payeeId: "B", ore: kr(1_800) });
    expect(sumLines(r)).toBe(kr(48_210));
  });

  it("utan återbetalning av inköpet får partnern bara vinstdelen", () => {
    const r = splitPayout(
      example({
        partner: {
          segments: [segment({ reimburse: false, costOre: kr(26_000) })],
          carryInOre: 0,
        },
      }),
    );
    // vinst = 48 210 − 9 700 − 5 200 = 33 310
    expect(r.totals.profitOre).toBe(kr(33_310));
    expect(line(r, "partner").amountOre).toBe(kr(16_655));
    expect(sumLines(r)).toBe(kr(48_210));
  });

  it("delar vinsten när avtalet ändras mitt i perioden", () => {
    const r = splitPayout(
      example({
        partner: {
          segments: [
            segment({ agreementId: "p1", bp: 5000, costOre: kr(13_000), weightOre: 1 }),
            segment({ agreementId: "p2", bp: 4000, costOre: kr(13_000), weightOre: 1 }),
          ],
          carryInOre: 0,
        },
      }),
    );
    // vinsten 7 310 delas 3 655 / 3 655 → 1 827,50 + 1 462,00
    expect(r.totals.partnerProfitOre).toBe(182_750 + 146_200);
    expect(sumLines(r)).toBe(kr(48_210));
  });

  it("för underskottet i momsen på vinsten vidare", () => {
    const loss = splitPayout(
      example({
        amountOre: kr(1_000),
        slices: [
          slice({ storeId: "A", grossOre: kr(1_000), costOre: kr(3_000), storeShareOre: 0 }),
        ],
        partner: { segments: [segment({ costOre: kr(3_000) })], carryInOre: 0 },
      }),
    );
    expect(loss.totals.vatOre).toBe(0);
    expect(loss.totals.vatCarryOutOre).toBe(kr(2_000));
    const next = splitPayout(
      example({ vat: { mode: "vmb", carryInOre: kr(2_000), vatRateBp: 0 } }),
    );
    expect(next.totals.vatOre).toBe(kr(4_800));
    expect(sumLines(next)).toBe(kr(48_210));
  });

  it("varnar för order utan inköpspris och butik utan avtal", () => {
    const r = splitPayout(
      example({
        slices: [
          ...example().slices,
          slice({ storeId: "C", grossOre: kr(1_000), unpricedOrders: 3, hasAgreement: false }),
        ],
      }),
    );
    const codes = r.warnings.map((w) => w.code);
    expect(codes).toContain("UNPRICED");
    expect(codes).toContain("NO_AGREEMENT");
  });

  it("ger bolaget en rad för två butiker", () => {
    const owner = { kind: "store_owner" as const, id: "K" };
    const r = splitPayout(
      example({
        slices: example().slices.map((s) => ({ ...s, payee: owner })),
      }),
    );
    const k = r.lines.filter((l) => l.kind === "store_owner");
    expect(k).toHaveLength(1);
    expect(k[0]!.amountOre).toBe(kr(9_700));
    expect("stores" in k[0]! && k[0]!.stores).toHaveLength(2);
  });

  it("utan partneravtal går vinsten till ägaren", () => {
    const r = splitPayout(example({ partner: null }));
    expect(r.lines.find((l) => l.kind === "partner")).toBeUndefined();
    expect(line(r, "owner").amountOre).toBe(kr(48_210 - 9_700 - 5_200));
    expect(r.warnings.map((w) => w.code)).toContain("NO_PARTNER_AGREEMENT");
  });

  it("varnar när Nayax betalade mycket mindre än väntat", () => {
    const r = splitPayout(example({ expectedNetOre: kr(49_500) }));
    expect(r.warnings).toContainEqual({
      code: "DIFF_EXPECTED",
      diffOre: kr(-1_290),
      expectedNetOre: kr(49_500),
    });
  });

  it("klarar 1 000 000 kr", () => {
    const r = splitPayout(
      example({
        amountOre: kr(1_000_000),
        slices: [
          slice({
            storeId: "A",
            grossOre: kr(1_100_000),
            costOre: kr(500_000),
            storeShareOre: kr(100_000),
          }),
        ],
        partner: { segments: [segment({ costOre: kr(500_000) })], carryInOre: 0 },
      }),
    );
    expect(sumLines(r)).toBe(kr(1_000_000));
  });

  it("summerar alltid till beloppet (slumpade indata)", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed % n;
    };
    for (let i = 0; i < 500; i++) {
      const slices = Array.from({ length: 1 + rnd(6) }, (_, j) =>
        slice({
          storeId: rnd(5) === 0 ? null : `S${j}`,
          payee: rnd(3) === 0 ? { kind: "store_owner", id: "K" } : { kind: "store", id: `S${j}` },
          month: rnd(2) === 0 ? "2026-10" : "2026-11",
          grossOre: rnd(10_000_000),
          refundsOre: rnd(50_000),
          costOre: rnd(5_000_000),
          storeShareOre: rnd(2_000_000) - 200_000,
        }),
      );
      const r = splitPayout({
        amountOre: rnd(20_000_000) - 1_000_000,
        slices,
        trueUps: [],
        vat: {
          mode: (["vmb", "standard", "none"] as const)[rnd(3)]!,
          carryInOre: rnd(100_000),
          vatRateBp: 2500,
        },
        partner:
          rnd(4) === 0
            ? null
            : {
                segments: [
                  segment({ costOre: rnd(5_000_000), bp: rnd(10_001), weightOre: rnd(1000) }),
                ],
                carryInOre: -rnd(10_000),
              },
        expectedNetOre: rnd(20_000_000),
      });
      expect(sumLines(r)).toBe(r.totals.amountOre);
      const p = r.lines.find((l) => l.kind === "partner");
      if (p) expect(p.amountOre).toBeGreaterThanOrEqual(0);
    }
  });

  it("avkortar vinstdelen mot noll", () => {
    expect(shareTruncated(731_001, 5000)).toBe(365_500);
    expect(shareTruncated(-731_001, 5000)).toBe(-365_500);
    expect(shareTruncated(1, 5000)).toBe(0);
  });
});

describe("splitPayout: rättelser, återbetalningar och VMB på prissatta order", () => {
  it("lägger rättelsen från låsta utbetalningar på partnern och momsen, summan exakt", () => {
    const base = splitPayout(example());
    const r = splitPayout(
      example({
        vat: { mode: "vmb", carryInOre: 0, vatRateBp: 0, adjustOre: kr(-400) },
        partner: {
          segments: [segment({ costOre: kr(26_000), packs: 520 })],
          carryInOre: 0,
          adjustOre: kr(1_200),
        },
      }),
    );
    expect(line(r, "vat_reserve").amountOre).toBe(line(base, "vat_reserve").amountOre - kr(400));
    expect(r.totals.vatAdjustOre).toBe(kr(-400));
    expect(r.totals.partnerAdjustOre).toBe(kr(1_200));
    // Vinsten blir 400 kr större (mindre moms); partnern får hälften av den + rättelsen.
    expect(line(r, "partner").amountOre).toBe(line(base, "partner").amountOre + kr(200 + 1_200));
    expect(r.warnings.map((w) => w.code)).toContain("LOCKED_ADJUST");
    expect(sumLines(r)).toBe(kr(48_210));
  });

  it("momsraden blir aldrig negativ: det som inte ryms väntar", () => {
    const r = splitPayout(
      example({ vat: { mode: "vmb", carryInOre: 0, vatRateBp: 0, adjustOre: kr(-999_999) } }),
    );
    expect(line(r, "vat_reserve").amountOre).toBe(0);
    expect(r.totals.vatAdjustOre).toBe(-kr(5_200));
    expect(sumLines(r)).toBe(kr(48_210));
  });

  it("återbetalningar ägaren gjort själv dras från vinsten före delningen", () => {
    const base = splitPayout(example());
    const r = splitPayout(example({ refundsOutsideOre: kr(1_000) }));
    expect(r.totals.profitOre).toBe(base.totals.profitOre - kr(1_000));
    expect(line(r, "partner").amountOre).toBe(line(base, "partner").amountOre - kr(500));
    expect(line(r, "owner").amountOre).toBe(line(base, "owner").amountOre + kr(500));
    expect(sumLines(r)).toBe(kr(48_210));
  });

  it("VMB räknas på order med inköpspris, som liggaren", () => {
    const r = splitPayout(
      example({
        slices: [
          slice({
            storeId: "A",
            grossOre: kr(32_000),
            pricedGrossOre: kr(22_000),
            costOre: kr(16_000),
            storeShareOre: kr(6_500),
          }),
          slice({
            storeId: "B",
            grossOre: kr(20_000),
            costOre: kr(10_000),
            storeShareOre: kr(3_200),
          }),
        ],
      }),
    );
    // (22 000 + 20 000 − 26 000) × 20 % = 3 200 kr i stället för 5 200 kr.
    expect(r.totals.vatOre).toBe(kr(3_200));
    expect(sumLines(r)).toBe(kr(48_210));
  });

  it("utan partneravtal förs partnerns skuld vidare i stället för att försvinna", () => {
    const r = splitPayout(
      example({
        partner: {
          segments: [segment({ agreementId: null, costOre: kr(26_000) })],
          carryInOre: kr(-300),
          adjustOre: kr(50),
        },
      }),
    );
    expect(r.totals.partnerCarryOutOre).toBe(kr(-300));
    expect(r.totals.partnerAdjustOre).toBe(0);
    expect(sumLines(r)).toBe(kr(48_210));
  });
});
