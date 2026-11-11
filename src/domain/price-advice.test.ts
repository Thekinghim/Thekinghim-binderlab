import { describe, expect, it } from "vitest";

import {
  currentSalePrices,
  isPricePoint,
  priceAdvice,
  suggestedPriceOre,
  unitMargin,
} from "./price-advice";

const NO_FEES = { vatRateBp: 0, cardFeeBp: 0 };
const FEES = { vatRateBp: 2_500, cardFeeBp: 250 };

describe("unitMargin", () => {
  it("utan moms och avgift: pris − inköp", () => {
    expect(unitMargin(24_900, 22_000, NO_FEES)).toEqual({
      netOre: 24_900,
      cardFeeOre: 0,
      profitOre: 2_900,
      marginBp: 1_165, // 29 / 249
    });
  });

  it("samma formler som liggaren: moms i priset och kortavgift på hela beloppet", () => {
    // 49,00 kr: moms 9,80, netto 39,20, kortavgift 1,23 (economics.ts).
    const m = unitMargin(4_900, 2_000, FEES);
    expect(m.netOre).toBe(3_920);
    expect(m.cardFeeOre).toBe(123);
    expect(m.profitOre).toBe(1_797);
    expect(m.marginBp).toBe(4_584);
  });

  it("förlust ger negativ marginal, pris 0 ingen marginal", () => {
    expect(unitMargin(10_000, 12_000, NO_FEES).marginBp).toBe(-2_000);
    expect(unitMargin(0, 100, NO_FEES).marginBp).toBeNull();
  });
});

describe("suggestedPriceOre", () => {
  it("lägsta pris som slutar på 5 eller 9 och når målet", () => {
    // Inköp 220 kr, mål 25 %: behöver minst 293,33 kr → 295 kr (25,4 %).
    expect(suggestedPriceOre(22_000, 2_500, NO_FEES)).toBe(29_500);
    // Inköp 213 kr: behöver 284 kr → 285 kr.
    expect(suggestedPriceOre(21_300, 2_500, NO_FEES)).toBe(28_500);
    // Inköp 74 kr: behöver 98,67 kr → 99 kr.
    expect(suggestedPriceOre(7_400, 2_500, NO_FEES)).toBe(9_900);
  });

  it("alltid över dagens pris", () => {
    expect(suggestedPriceOre(100, 2_500, NO_FEES, 4_900)).toBe(5_500);
  });

  it("räknar med moms och kortavgift, och målet nås verkligen", () => {
    const p = suggestedPriceOre(22_000, 2_500, FEES)!;
    expect(isPricePoint(p / 100)).toBe(true);
    expect(unitMargin(p, 22_000, FEES).marginBp!).toBeGreaterThanOrEqual(2_500);
    // Prispunkten närmast under når inte målet.
    const below = [1, 2, 3, 4, 5, 6].map((d) => p - d * 100).find((x) => isPricePoint(x / 100))!;
    expect(unitMargin(below, 22_000, FEES).marginBp!).toBeLessThan(2_500);
  });

  it("omöjligt mål ger inget pris", () => {
    expect(suggestedPriceOre(1_000, 10_000, NO_FEES)).toBeNull();
    // Avgifterna äter upp allt: av priset utan moms (80 %) blir 3 % kvar vid mål 97 %,
    // alltså 2,4 % av priset, men kortavgiften är 2,5 %.
    expect(suggestedPriceOre(1_000, 9_700, FEES)).toBeNull();
  });

  it("isPricePoint: bara 5 och 9", () => {
    expect([295, 299, 290, 294, 5, 9, 10].map(isPricePoint)).toEqual([
      true,
      true,
      false,
      false,
      true,
      true,
      false,
    ]);
  });
});

describe("currentSalePrices", () => {
  const o = (
    titleId: string,
    machineId: string | null,
    businessDate: string,
    amountOre: number,
    orderedAt?: string,
  ) => ({ titleId, machineId, businessDate, amountOre, ...(orderedAt ? { orderedAt } : {}) });

  it("senaste betalda köpet per titel; gratis-pack och gamla köp räknas inte", () => {
    const prices = currentSalePrices(
      [
        o("a", "m1", "2026-10-20", 19_900),
        o("a", "m1", "2026-10-30", 24_900),
        o("a", "m1", "2026-10-31", 0),
        o("b", "m1", "2026-09-01", 9_900),
      ],
      "2026-10-04",
    );
    expect([...prices]).toEqual([["a", 24_900]]);
  });

  it("samma dag avgör betaltidpunkten", () => {
    const prices = currentSalePrices(
      [
        o("a", "m1", "2026-10-30", 24_900, "2026-10-30T15:00:00.000Z"),
        o("a", "m1", "2026-10-30", 19_900, "2026-10-30T09:00:00.000Z"),
      ],
      "2026-10-04",
    );
    expect(prices.get("a")).toBe(24_900);
  });

  it("olika pris i automaterna: det lägsta (sämst marginal)", () => {
    const prices = currentSalePrices(
      [o("a", "m1", "2026-10-30", 24_900), o("a", "m2", "2026-10-29", 22_900)],
      "2026-10-04",
    );
    expect(prices.get("a")).toBe(22_900);
  });
});

describe("priceAdvice", () => {
  const input = {
    titleIds: ["fusion", "ok", "unsold", "unpriced"],
    salePrices: new Map([
      ["fusion", 24_900],
      ["ok", 9_900],
      ["unpriced", 9_900],
    ]),
    costOf: (id: string) => ({ fusion: 22_000, ok: 5_000, unsold: 100 })[id] ?? null,
    settings: NO_FEES,
    targetBp: 2_500,
  };

  it("bara produkter under målet, med pris, inköp, marginal och förslaget", () => {
    expect(priceAdvice(input)).toEqual([
      {
        titleId: "fusion",
        salePriceOre: 24_900,
        unitCostOre: 22_000,
        profitOre: 2_900,
        marginBp: 1_165,
        suggestedPriceOre: 29_500,
        suggestedMarginBp: 2_542,
      },
    ]);
  });

  it("sämst marginal först, och målet styr", () => {
    const rows = priceAdvice({ ...input, targetBp: 6_000 });
    expect(rows.map((r) => r.titleId)).toEqual(["fusion", "ok"]);
    expect(priceAdvice({ ...input, targetBp: 1_000 })).toEqual([]);
  });

  it("exakt på målet flaggas inte", () => {
    const rows = priceAdvice({
      ...input,
      titleIds: ["x"],
      salePrices: new Map([["x", 10_000]]),
      costOf: () => 7_500,
    });
    expect(rows).toEqual([]);
  });
});
