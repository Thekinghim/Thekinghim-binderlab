/**
 * Efter vinsten på Lönsamhet: återbetalningar och fasta kostnader som egna rader. Vinsten
 * ovanför ändras inte, och raderna per automat summerar till totalen.
 *
 * Handräknat: moms 0, kortavgift 0, provision 10 %, ingen hyra.
 *   m1: 10 order à 100 kr, inköp 60 kr → intäkt 1 000, inköp 600, provision 100, vinst 300 kr
 *   m2:  5 order à 100 kr, inköp 60 kr → intäkt   500, inköp 300, provision  50, vinst 150 kr
 *   återbetalningar i perioden: m1 40 kr (1 okt.), m2 25 kr (2 okt.); en 3 nov. (utanför)
 *   fasta kostnader i oktober: försäkring 300 kr/mån gemensam (2:1 efter intäkt → 200 + 100),
 *                              service 90 kr/mån på m2
 */

import { describe, expect, it } from "vitest";

import type { FixedCost } from "@/analytics/cashflow";
import { profitability, type OrderLine, type ProfitabilityInput } from "@/domain";
import type { Refund } from "@/domain/refunds";

import { resultAfterProfit } from "./result";

const OCT = { start: "2026-10-01", end: "2026-10-31" };

let seq = 0;
function orders(n: number, machineId: string, date: string): OrderLine[] {
  return Array.from({ length: n }, () => {
    seq += 1;
    return {
      id: `o${seq}`,
      externalId: String(seq),
      titleId: "t1",
      machineId,
      businessDate: date,
      amountOre: 10_000,
    };
  });
}

const ORG: ProfitabilityInput = {
  period: OCT,
  orders: [...orders(10, "m1", "2026-10-05"), ...orders(5, "m2", "2026-10-06")],
  prices: [{ titleId: "t1", unitCostOre: 6_000, validFrom: "2026-01-01" }],
  agreements: [
    {
      storeId: "s1",
      validFrom: "2026-01-01",
      validTo: null,
      commissionBp: 1_000,
      monthlyRentOre: null,
    },
    {
      storeId: "s2",
      validFrom: "2026-01-01",
      validTo: null,
      commissionBp: 1_000,
      monthlyRentOre: null,
    },
  ],
  placements: [
    { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
    { machineId: "m2", storeId: "s2", from: "2026-01-01", to: null },
  ],
  settings: { vatRateBp: 0, cardFeeBp: 0 },
};

const REFUNDS: Refund[] = [
  { id: "i1", machineId: "m1", titleId: "t1", refundedOn: "2026-10-01", amountOre: 4_000 },
  { id: "i2", machineId: "m2", titleId: "t1", refundedOn: "2026-10-02", amountOre: 2_500 },
  { id: "i3", machineId: "m2", titleId: "t1", refundedOn: "2026-11-03", amountOre: 9_900 },
];

const COSTS: FixedCost[] = [
  {
    id: "f1",
    name: "Försäkring",
    amountOre: 30_000,
    interval: "month",
    start: "2026-01-01",
    end: null,
  },
  {
    id: "f2",
    name: "Service",
    amountOre: 9_000,
    interval: "month",
    start: "2026-01-01",
    end: null,
    machineId: "m2",
  },
];

const NO_SCOPE = { storeId: null, machineId: null };

describe("resultAfterProfit", () => {
  it("drar återbetalningar och fasta kostnader från vinsten, i två separata steg", () => {
    const r = resultAfterProfit({
      current: ORG,
      organization: ORG,
      refunds: REFUNDS,
      fixedCosts: COSTS,
      scope: NO_SCOPE,
    });
    // Vinsten är vattenfallets (profitability) och ändras inte.
    expect(r.profitOre).toBe(profitability(ORG, "title").totals.profitOre);
    expect(r.profitOre).toBe(45_000);
    expect(r.refundOre).toBe(6_500);
    expect(r.refundCount).toBe(2);
    expect(r.profitAfterRefundsOre).toBe(38_500);
    expect(r.fixedCostOre).toBe(39_000);
    expect(r.sharedFixedOre).toBe(30_000);
    expect(r.directFixedOre).toBe(9_000);
    expect(r.resultOre).toBe(-500);
    expect(r.resultMarginBp).toBe(-33); // −5 kr / 1 500 kr
  });

  it("raderna per automat summerar till totalen i varje kolumn", () => {
    const r = resultAfterProfit({
      current: ORG,
      organization: ORG,
      refunds: REFUNDS,
      fixedCosts: COSTS,
      scope: NO_SCOPE,
    });
    const sum = (k: "profitOre" | "refundOre" | "fixedCostOre" | "resultOre") =>
      r.machines.reduce((n, m) => n + m[k], 0);
    expect(sum("profitOre")).toBe(r.profitOre);
    expect(sum("refundOre")).toBe(r.refundOre);
    expect(sum("fixedCostOre")).toBe(r.fixedCostOre);
    expect(sum("resultOre")).toBe(r.resultOre);
    const m1 = r.machines.find((m) => m.key === "m1")!;
    const m2 = r.machines.find((m) => m.key === "m2")!;
    expect([m1.profitOre, m1.refundOre, m1.fixedCostOre, m1.resultOre]).toEqual([
      30_000, 4_000, 20_000, 6_000,
    ]);
    expect([m2.profitOre, m2.refundOre, m2.fixedCostOre, m2.resultOre]).toEqual([
      15_000, 2_500, 19_000, -6_500,
    ]);
  });

  it("automatfilter: automatens återbetalningar och dess del av fördelningen på hela organisationen", () => {
    const current: ProfitabilityInput = {
      ...ORG,
      orders: ORG.orders.filter((o) => o.machineId === "m2"),
      placements: ORG.placements.filter((p) => p.machineId === "m2"),
    };
    const r = resultAfterProfit({
      current,
      organization: ORG,
      refunds: REFUNDS,
      fixedCosts: COSTS,
      scope: { storeId: null, machineId: "m2" },
    });
    expect(r.profitOre).toBe(15_000);
    expect(r.refundOre).toBe(2_500);
    // Inte alla 300 kr gemensamma: m2:s tredjedel (100 kr) plus servicen 90 kr.
    expect(r.fixedCostOre).toBe(19_000);
    expect(r.resultOre).toBe(-6_500);
  });

  it("automat- och butiksfilter (som skalet skickar): automaten går före butiken", () => {
    // Båda automaterna i s1: butikens återbetalningar (65 kr) får inte räknas på m2.
    const org: ProfitabilityInput = {
      ...ORG,
      placements: [
        { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
        { machineId: "m2", storeId: "s1", from: "2026-01-01", to: null },
      ],
    };
    const current: ProfitabilityInput = {
      ...org,
      orders: org.orders.filter((o) => o.machineId === "m2"),
      placements: org.placements.filter((p) => p.machineId === "m2"),
      agreements: org.agreements.filter((a) => a.storeId === "s1"),
    };
    const r = resultAfterProfit({
      current,
      organization: org,
      refunds: REFUNDS,
      fixedCosts: COSTS,
      scope: { storeId: "s1", machineId: "m2" },
    });
    expect(r.fixedNote).toBeNull();
    expect(r.profitOre).toBe(15_000);
    expect(r.refundOre).toBe(2_500);
    expect(r.fixedCostOre).toBe(19_000);
    expect(r.resultOre).toBe(-6_500);
    expect(r.machines.map((m) => m.key)).toEqual(["m2"]);
    expect(r.machines[0]!.resultOre).toBe(r.resultOre);
  });

  it("butiksfilter: butikens återbetalningar, fasta kostnader visas inte", () => {
    const current: ProfitabilityInput = {
      ...ORG,
      orders: ORG.orders.filter((o) => o.machineId === "m1"),
      placements: ORG.placements.filter((p) => p.storeId === "s1"),
      agreements: ORG.agreements.filter((a) => a.storeId === "s1"),
    };
    const r = resultAfterProfit({
      current,
      organization: ORG,
      refunds: REFUNDS,
      fixedCosts: COSTS,
      scope: { storeId: "s1", machineId: null },
    });
    expect(r.refundOre).toBe(4_000);
    expect(r.fixedCostOre).toBeNull();
    expect(r.fixedNote).toMatch(/per automat/);
    expect(r.resultOre).toBe(r.profitAfterRefundsOre);
    expect(r.machines).toEqual([]);
  });

  it("utan återbetalningar och fasta kostnader är resultatet vinsten", () => {
    const r = resultAfterProfit({
      current: ORG,
      organization: ORG,
      refunds: [],
      fixedCosts: [],
      scope: NO_SCOPE,
    });
    expect(r.resultOre).toBe(r.profitOre);
    expect(r.fixedSummary).toBeNull();
  });
});
