import { describe, expect, it } from "vitest";

import { cardFeeBpOn, profitability, setCardFeeFrom, parseCardFeeHistory } from "./index";
import type { OrderLine, Settings } from "./index";

const order = (id: string, day: string, amountOre: number): OrderLine => ({
  id,
  externalId: id,
  titleId: "t1",
  machineId: "m1",
  businessDate: day,
  amountOre,
});

describe("kortavgiften gäller från ett datum", () => {
  it("utan lista gäller en sats alla datum, som förut", () => {
    expect(cardFeeBpOn({ cardFeeBp: 250 }, "2020-01-01")).toBe(250);
    expect(cardFeeBpOn({ cardFeeBp: 250, cardFeeRates: [] }, "2030-01-01")).toBe(250);
  });

  it("en order får satsen som gällde orderns dag", () => {
    const s: Settings = {
      vatRateBp: 0,
      cardFeeBp: 400,
      cardFeeRates: [
        { validFrom: "2000-01-01", cardFeeBp: 0 },
        { validFrom: "2026-11-01", cardFeeBp: 400 },
      ],
    };
    expect(cardFeeBpOn(s, "2026-10-31")).toBe(0);
    expect(cardFeeBpOn(s, "2026-11-01")).toBe(400);
    // Före första raden gäller grundsatsen.
    expect(cardFeeBpOn(s, "1999-12-31")).toBe(0);
  });

  it("ändringen från 1 nov. rör inte oktober: avgiften i liggaren", () => {
    const base = {
      period: { start: "2026-10-01", end: "2026-11-30" },
      orders: [order("a", "2026-10-15", 10_000), order("b", "2026-11-15", 10_000)],
      prices: [{ titleId: "t1", unitCostOre: 4_000, validFrom: "2026-01-01" }],
      placements: [],
      agreements: [],
    };
    const flat = profitability({ ...base, settings: { vatRateBp: 0, cardFeeBp: 0 } }, "month");
    expect(flat.totals.feesOre).toBe(0);
    const rates = setCardFeeFrom({ cardFeeBp: 0 }, "2026-11-01", 400);
    const dated = profitability(
      { ...base, settings: { vatRateBp: 0, cardFeeBp: 400, cardFeeRates: rates } },
      "month",
    );
    // Bara novemberordern: 100,00 kr × 4 % = 4,00 kr.
    expect(dated.totals.feesOre).toBe(400);
    // Gamla sättet (en sats för alla datum) hade gett 8,00 kr.
    const old = profitability({ ...base, settings: { vatRateBp: 0, cardFeeBp: 400 } }, "month");
    expect(old.totals.feesOre).toBe(800);
  });
});

describe("setCardFeeFrom", () => {
  it("första daterade ändringen behåller den gamla satsen för dagarna före", () => {
    expect(setCardFeeFrom({ cardFeeBp: 150 }, "2026-11-01", 400)).toEqual([
      { validFrom: "2000-01-01", cardFeeBp: 150 },
      { validFrom: "2026-11-01", cardFeeBp: 400 },
    ]);
  });

  it("en ny sats från ett tidigare datum tar bort senare rader", () => {
    const rates = [
      { validFrom: "2000-01-01", cardFeeBp: 0 },
      { validFrom: "2026-11-01", cardFeeBp: 400 },
    ] as const;
    expect(setCardFeeFrom({ cardFeeBp: 400, cardFeeRates: rates }, "2026-10-01", 300)).toEqual([
      { validFrom: "2000-01-01", cardFeeBp: 0 },
      { validFrom: "2026-10-01", cardFeeBp: 300 },
    ]);
  });

  it("samma sats som redan gällde ger ingen ny rad", () => {
    expect(setCardFeeFrom({ cardFeeBp: 400 }, "2026-11-01", 400)).toEqual([
      { validFrom: "2000-01-01", cardFeeBp: 400 },
    ]);
  });

  it("null = alla datum (en enda sats)", () => {
    const rates = [
      { validFrom: "2000-01-01", cardFeeBp: 0 },
      { validFrom: "2026-11-01", cardFeeBp: 400 },
    ] as const;
    expect(setCardFeeFrom({ cardFeeBp: 400, cardFeeRates: rates }, null, 250)).toEqual([
      { validFrom: "2000-01-01", cardFeeBp: 250 },
    ]);
  });

  it("läser den sparade listan och hoppar över skräp", () => {
    expect(
      parseCardFeeHistory([
        { from: "2026-11-01", bp: 400 },
        { from: "x", bp: 1 },
        { from: "2000-01-01", bp: 0 },
        null,
      ]),
    ).toEqual([
      { validFrom: "2000-01-01", cardFeeBp: 0 },
      { validFrom: "2026-11-01", cardFeeBp: 400 },
    ]);
  });
});
