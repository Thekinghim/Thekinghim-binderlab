import { describe, expect, it } from "vitest";

import { DomainError } from "./errors";
import {
  applyRefunds,
  profitAfterRefunds,
  REFUND_NONE_KEY,
  refundsInPeriod,
  summarizeRefunds,
  type Refund,
} from "./refunds";

const NOV = { start: "2026-11-01", end: "2026-11-30" } as const;

const refunds: Refund[] = [
  { id: "r1", machineId: "m1", titleId: "t1", refundedOn: "2026-11-03", amountOre: 4_900 },
  { id: "r2", machineId: "m1", titleId: "t2", refundedOn: "2026-11-20", amountOre: 5_900 },
  { id: "r3", machineId: "m2", titleId: "t1", refundedOn: "2026-11-30", amountOre: 4_900 },
  // Utanför perioden.
  { id: "r4", machineId: "m2", titleId: "t1", refundedOn: "2026-10-31", amountOre: 12_900 },
  // Ärende utan återbetalning.
  { id: "r5", machineId: "m2", titleId: null, refundedOn: "2026-11-10", amountOre: 0 },
  // Utan automat och titel.
  { id: "r6", machineId: null, titleId: null, refundedOn: "2026-11-15", amountOre: 1_000 },
];

describe("refundsInPeriod", () => {
  it("tar bara med belopp > 0 med dag i perioden, båda ändar inräknade", () => {
    expect(refundsInPeriod(refunds, NOV).map((r) => r.id)).toEqual(["r1", "r2", "r3", "r6"]);
  });

  it("avvisar negativa belopp, flyttal och ogiltiga datum", () => {
    const bad = (r: Partial<Refund>) => () => refundsInPeriod([{ ...refunds[0]!, ...r }], NOV);
    expect(bad({ amountOre: -1 })).toThrow(DomainError);
    expect(bad({ amountOre: 49.5 })).toThrow(DomainError);
    expect(bad({ refundedOn: "2026-11-31" })).toThrow(DomainError);
    expect(bad({ id: "" })).toThrow(DomainError);
  });
});

describe("summarizeRefunds", () => {
  it("per automat: summan av raderna är totalen", () => {
    const s = summarizeRefunds(refunds, NOV, "machine");
    expect(s.count).toBe(4);
    expect(s.amountOre).toBe(4_900 + 5_900 + 4_900 + 1_000);
    expect(s.rows).toEqual([
      { key: "m1", count: 2, amountOre: 10_800, refundIds: ["r1", "r2"] },
      { key: "m2", count: 1, amountOre: 4_900, refundIds: ["r3"] },
      { key: REFUND_NONE_KEY, count: 1, amountOre: 1_000, refundIds: ["r6"] },
    ]);
    expect(s.rows.reduce((a, r) => a + r.amountOre, 0)).toBe(s.amountOre);
  });

  it("per titel och per månad", () => {
    expect(summarizeRefunds(refunds, NOV, "title").rows.map((r) => [r.key, r.amountOre])).toEqual([
      ["t1", 9_800],
      ["t2", 5_900],
      [REFUND_NONE_KEY, 1_000],
    ]);
    const months = summarizeRefunds(refunds, { start: "2026-10-01", end: "2026-11-30" }, "month");
    expect(months.rows.map((r) => [r.key, r.amountOre])).toEqual([
      ["2026-10", 12_900],
      ["2026-11", 16_700],
    ]);
  });

  it("per butik följer placeringen på återbetalningsdagen", () => {
    const placements = [
      { machineId: "m1", storeId: "s1", from: "2026-01-01", to: "2026-11-10" },
      { machineId: "m1", storeId: "s2", from: "2026-11-11", to: null },
    ];
    const s = summarizeRefunds(refunds, NOV, "store", placements);
    expect(s.rows.map((r) => [r.key, r.amountOre, r.refundIds])).toEqual([
      // m2 och ärendet utan automat har ingen placering.
      [REFUND_NONE_KEY, 5_900, ["r3", "r6"]],
      ["s2", 5_900, ["r2"]],
      ["s1", 4_900, ["r1"]],
    ]);
  });
});

describe("vinst efter återbetalningar", () => {
  it("drar återbetalningen från vinsten och räknar marginalen på oförändrad intäkt", () => {
    // Avsnitt 3 i berakningar.md: intäkt 30 400, vinst 7 660. En återbetalning à 49,00.
    const r = profitAfterRefunds({ key: "total", revenueOre: 30_400, profitOre: 7_660 }, 4_900, 1);
    expect(r.profitAfterRefundsOre).toBe(2_760);
    // 2 760 / 30 400 = 9,078 % → 908 bp.
    expect(r.marginAfterRefundsBp).toBe(908);
    expect(r.revenueOre).toBe(30_400);
  });

  it("marginalen saknas när intäkten är 0", () => {
    expect(
      profitAfterRefunds({ key: "x", revenueOre: 0, profitOre: 0 }, 100).marginAfterRefundsBp,
    ).toBeNull();
  });

  it("applyRefunds lägger på rätt rad och ger egen rad för nycklar utan försäljning", () => {
    const lines = [
      { key: "m1", revenueOre: 30_400, profitOre: 7_660 },
      { key: "m3", revenueOre: 10_000, profitOre: 2_000 },
    ];
    const out = applyRefunds(lines, refunds, NOV, "machine");
    expect(out.map((r) => [r.key, r.refundOre, r.profitAfterRefundsOre])).toEqual([
      ["m1", 10_800, -3_140],
      ["m3", 0, 2_000],
      ["m2", 4_900, -4_900],
      [REFUND_NONE_KEY, 1_000, -1_000],
    ]);
    const totalRefund = out.reduce((a, r) => a + r.refundOre, 0);
    expect(totalRefund).toBe(summarizeRefunds(refunds, NOV, "total").amountOre);
  });

  it("ordningen på indata påverkar inte resultatet", () => {
    const a = summarizeRefunds(refunds, NOV, "title");
    const b = summarizeRefunds([...refunds].reverse(), NOV, "title");
    expect(b).toEqual(a);
  });
});
