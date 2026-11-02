import { describe, expect, it } from "vitest";
import { createEconomicsContext, orderEconomics } from "./economics";
import { DomainError } from "./errors";
import { agreement, NO_TAX, order, placement, price } from "./testing/fixtures";
import type { EconomicsSources, Settings } from "./types";

function sources(settings: Settings, commissionBp: number | null = 1000): EconomicsSources {
  return {
    prices: [price("t-a", 2000, "2026-01-01")],
    agreements: [agreement("s-1", "2026-01-01", null, { commissionBp, monthlyRentOre: 50_000 })],
    placements: [placement("m-1", "s-1", "2026-01-01", null)],
    settings,
  };
}

describe("orderEconomics", () => {
  it("moms 0, kortavgift 0 (dagens inställningar)", () => {
    const e = orderEconomics(
      order({ businessDate: "2026-10-05", amountOre: 4900 }),
      sources(NO_TAX),
    );
    expect(e).toMatchObject({
      grossOre: 4900,
      vatOre: 0,
      netRevenueOre: 4900,
      costOre: 2000,
      cardFeeOre: 0,
      commissionOre: 490, // 10 % av 49,00 kr
      commissionBp: 1000,
      storeId: "s-1",
    });
  });

  it("moms 25 %, kortavgift 250 bp: provision på netto, avgift på brutto", () => {
    // moms = round(4900 × 2500 / 12500) = 980 → netto 3920
    // kortavgift = round(4900 × 250 / 10000) = round(122,5) = 123
    // provision = round(3920 × 1000 / 10000) = 392
    const e = orderEconomics(
      order({ businessDate: "2026-10-05", amountOre: 4900 }),
      sources({ vatRateBp: 2500, cardFeeBp: 250 }),
    );
    expect(e).toMatchObject({
      vatOre: 980,
      netRevenueOre: 3920,
      cardFeeOre: 123,
      commissionOre: 392,
    });
  });

  it("halva öre avrundas uppåt i moms och provision", () => {
    // 6 % moms på 53 öre: 53 × 600 / 10600 = 3 exakt → netto 50
    // provision 1 % av 50 = 0,5 → 1
    const e = orderEconomics(
      order({ businessDate: "2026-10-05", amountOre: 53 }),
      sources({ vatRateBp: 600, cardFeeBp: 0 }, 100),
    );
    expect(e).toMatchObject({ vatOre: 3, netRevenueOre: 50, commissionOre: 1 });
    // 12 % moms på 14 öre: 14 × 1200 / 11200 = 1,5 → 2; netto 12
    const f = orderEconomics(
      order({ businessDate: "2026-10-05", amountOre: 14 }),
      sources({ vatRateBp: 1200, cardFeeBp: 0 }),
    );
    expect(f).toMatchObject({ vatOre: 2, netRevenueOre: 12 });
    // kortavgift 250 bp på 2 öre: 0,05 → 0; på 20 öre: 0,5 → 1
    const g = sources({ vatRateBp: 0, cardFeeBp: 250 });
    expect(orderEconomics(order({ businessDate: "2026-10-05", amountOre: 2 }), g).cardFeeOre).toBe(
      0,
    );
    expect(orderEconomics(order({ businessDate: "2026-10-05", amountOre: 20 }), g).cardFeeOre).toBe(
      1,
    );
  });

  it("utan pris: costOre null", () => {
    const e = orderEconomics(order({ businessDate: "2025-12-31" }), sources(NO_TAX));
    expect(e.costOre).toBeNull();
    expect(e.storeId).toBeNull(); // placeringen börjar 2026-01-01
    expect(e.commissionOre).toBe(0);
  });

  it("automat saknas eller avtal saknar provision → ingen provision", () => {
    expect(
      orderEconomics(order({ businessDate: "2026-10-05", machineId: null }), sources(NO_TAX))
        .commissionOre,
    ).toBe(0);
    expect(
      orderEconomics(order({ businessDate: "2026-10-05" }), sources(NO_TAX, null)).commissionOre,
    ).toBe(0);
  });

  it("stora belopp räknas exakt", () => {
    // 50 miljoner kr: 5e9 öre × 2500 överstiger inte 2^53, men 5e12 × 2500 gör det.
    const amount = 5_000_000_000_000;
    const ctx = createEconomicsContext(sources({ vatRateBp: 2500, cardFeeBp: 250 }));
    const e = orderEconomics(order({ businessDate: "2026-10-05", amountOre: amount }), ctx);
    expect(e.vatOre).toBe(1_000_000_000_000);
    expect(e.netRevenueOre).toBe(4_000_000_000_000);
    expect(e.cardFeeOre).toBe(125_000_000_000);
    expect(e.commissionOre).toBe(400_000_000_000);
  });

  it("ogiltig order och inställningar kastar", () => {
    expect(() =>
      orderEconomics(order({ businessDate: "2026-10-05", amountOre: 49.5 }), sources(NO_TAX)),
    ).toThrow(DomainError);
    expect(() =>
      orderEconomics(order({ businessDate: "2026-10-05", amountOre: -1 }), sources(NO_TAX)),
    ).toThrow(DomainError);
    expect(() => orderEconomics(order({ businessDate: "2026-02-30" }), sources(NO_TAX))).toThrow(
      DomainError,
    );
    expect(() =>
      orderEconomics(
        order({ businessDate: "2026-10-05" }),
        sources({ vatRateBp: -1, cardFeeBp: 0 }),
      ),
    ).toThrow(DomainError);
    expect(() =>
      orderEconomics(
        order({ businessDate: "2026-10-05" }),
        sources({ vatRateBp: 0, cardFeeBp: 10_001 }),
      ),
    ).toThrow(DomainError);
  });
});
