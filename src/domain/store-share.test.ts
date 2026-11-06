/**
 * Butikernas andel i vår vinst (store-share.ts): före andelen när vyn säger det, efter den
 * annars. Andelen i sig (det butikerna ska ha) ändras aldrig av flaggan.
 */
import { describe, expect, it } from "vitest";

import { buildLedger } from "./ledger";
import { profitability, profitabilityViews } from "./profitability";
import { entryProfitOre, storeShareDeducted } from "./store-share";
import type { ProfitabilityInput } from "./types";
import { unitEconomics } from "./unit-economics";

const PERIOD = { start: "2026-10-01", end: "2026-10-31" };

function input(deductStoreShare?: boolean): ProfitabilityInput {
  const orders = [];
  for (let i = 0; i < 20; i++) {
    orders.push({
      id: `o${i}`,
      externalId: String(i),
      titleId: i % 2 ? "A" : "B",
      machineId: i % 4 === 0 ? "m3" : i % 3 === 0 ? "m2" : "m1",
      businessDate: `2026-10-${String(1 + (i % 28)).padStart(2, "0")}`,
      amountOre: 17_500,
    });
  }
  return {
    period: PERIOD,
    orders,
    prices: [
      { titleId: "A", unitCostOre: 9_000, validFrom: "2026-01-01" },
      { titleId: "B", unitCostOre: 11_000, validFrom: "2026-01-01" },
    ],
    agreements: [
      // Vinstdelning 50 %, provision 10 % + hyra, och bara hyra.
      {
        storeId: "s1",
        validFrom: "2026-01-01",
        validTo: null,
        commissionBp: 5_000,
        monthlyRentOre: null,
        commissionBase: "profit_after_costs",
      },
      {
        storeId: "s2",
        validFrom: "2026-01-01",
        validTo: null,
        commissionBp: 1_000,
        monthlyRentOre: 50_000,
      },
      {
        storeId: "s3",
        validFrom: "2026-01-01",
        validTo: null,
        commissionBp: null,
        monthlyRentOre: 90_000,
      },
    ],
    placements: [
      { machineId: "m1", storeId: "s1", from: "2026-01-01", to: null },
      { machineId: "m2", storeId: "s2", from: "2026-01-01", to: null },
      { machineId: "m3", storeId: "s3", from: "2026-01-01", to: null },
    ],
    settings: {
      vatRateBp: 0,
      cardFeeBp: 250,
      ...(deductStoreShare === undefined ? {} : { deductStoreShare }),
    },
  };
}

describe("storeShareDeducted", () => {
  it("drar andelen när flaggan saknas (avräkningar, rapporter) och när den är på", () => {
    expect(storeShareDeducted({})).toBe(true);
    expect(storeShareDeducted({ deductStoreShare: true })).toBe(true);
    expect(storeShareDeducted({ deductStoreShare: false })).toBe(false);
  });
});

describe("profitability med och utan butikernas andel", () => {
  it("av: vinsten är intäkt − inköp − avgifter; på: minus andelen (provision + hyra)", () => {
    const off = profitability(input(false), "title");
    const on = profitability(input(true), "title");
    const legacy = profitability(input(), "title");
    const t = off.totals;
    expect(off.storeShareDeducted).toBe(false);
    expect(t.profitOre).toBe(t.revenueOre - t.costOre - t.feesOre - t.vmbVatOre);
    expect(t.profitOre).toBe(t.profitBeforeShareOre);
    expect(on.totals.profitOre).toBe(t.profitOre - on.totals.compensationOre);
    expect(on.totals.profitOre).toBe(t.profitAfterShareOre);
    // Utan flagga: som förut (efter andelen), så att rapporterna inte ändras.
    expect(legacy.totals).toEqual(on.totals);
    // Andelen i sig är densamma i båda lägena.
    expect(on.totals.compensationOre).toBe(t.compensationOre);
    expect(on.totals.commissionOre).toBe(t.commissionOre);
    expect(on.totals.rentOre).toBe(t.rentOre);
    expect(t.marginBp).toBe(t.marginBeforeShareBp);
    expect(on.totals.marginBp).toBe(on.totals.marginAfterShareBp);
  });

  it("raderna summerar till totalen i varje vy och i båda lägena", () => {
    for (const flag of [false, true]) {
      const views = profitabilityViews(input(flag), [
        "title",
        "machine",
        "store",
        "day",
        "week",
        "month",
      ] as const);
      for (const [g, r] of Object.entries(views)) {
        const sum = r.rows.reduce((n, x) => n + x.profitOre, 0);
        expect(sum, `${g} ${flag}`).toBe(r.totals.profitOre);
      }
    }
  });

  it("vattenfallet har ett steg för andelen bara när den dras", () => {
    const off = profitability(input(false), "title").waterfall.steps.map((s) => s.key);
    const on = profitability(input(true), "title").waterfall.steps.map((s) => s.key);
    expect(off).toEqual(["revenue", "cost", "fees", "profit"]);
    expect(on).toEqual(["revenue", "cost", "fees", "compensation", "profit"]);
    for (const flag of [false, true]) {
      const w = profitability(input(flag), "title").waterfall.steps;
      const sum = w.filter((s) => !s.total).reduce((n, s) => n + s.valueOre, 0);
      expect(sum).toBe(w.find((s) => s.total)!.valueOre);
    }
  });

  it("liggaren (det butikerna ska ha) är densamma oavsett flaggan", () => {
    const a = buildLedger(input(false));
    const b = buildLedger(input(true));
    expect(a.entries.map((e) => [e.commissionOre, e.rentOre])).toEqual(
      b.entries.map((e) => [e.commissionOre, e.rentOre]),
    );
    expect(a.profitSplits.map((s) => s.result)).toEqual(b.profitSplits.map((s) => s.result));
    expect(a.unallocatedRent).toEqual(b.unallocatedRent);
  });

  it("enhetsekonomin följer samma regel som lönsamheten per automat", () => {
    for (const flag of [false, true]) {
      const ue = unitEconomics({ ...input(flag), investments: [] });
      const rows = profitability(input(flag), "machine").rows;
      for (const u of ue) {
        const ledger = buildLedger(input(flag));
        const expected = ledger.entries
          .filter((e) => e.priced && e.order.machineId === u.machineId)
          .reduce((n, e) => n + entryProfitOre(e, flag), 0);
        expect(u.profitOre).toBe(expected);
        if (!flag) expect(u.profitOre).toBe(rows.find((r) => r.key === u.machineId)!.profitOre);
      }
    }
  });
});
