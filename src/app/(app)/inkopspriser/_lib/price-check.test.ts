import { describe, expect, it } from "vitest";

import { isPriceDoubt, priceDoubt, priceDoubtText } from "./price-check";

const sp = (s: string) => s.replace(/ /g, " ");

describe("priceDoubt: rimlighetskoll av ett nytt inköpspris", () => {
  it("1125 mot 112,50 behöver ett extra tryck, 118 gör det inte", () => {
    const d = priceDoubt({ newOre: 112_500, oldOre: 11_250, saleOre: 14_900 });
    expect(d).toEqual({ kind: "higher", newOre: 112_500, refOre: 11_250 });
    expect(sp(priceDoubtText(d!))).toBe(
      "1 125,00 kr är mycket mer än förra priset 112,50 kr. Stämmer det?",
    );
    expect(priceDoubt({ newOre: 11_800, oldOre: 11_250, saleOre: 14_900 })).toBeNull();
  });
  it("mer än 30 % under det förra priset", () => {
    const d = priceDoubt({ newOre: 1_125, oldOre: 11_250 });
    expect(d?.kind).toBe("lower");
    expect(sp(priceDoubtText(d!))).toContain("mycket mindre än förra priset 112,50 kr");
    // Precis 30 % är fortfarande rimligt.
    expect(priceDoubt({ newOre: 13_000, oldOre: 10_000 })).toBeNull();
    expect(priceDoubt({ newOre: 13_001, oldOre: 10_000 })?.kind).toBe("higher");
    expect(priceDoubt({ newOre: 7_000, oldOre: 10_000 })).toBeNull();
  });
  it("över vad packet säljs för, även utan gammalt pris", () => {
    const d = priceDoubt({ newOre: 16_000, oldOre: null, saleOre: 14_900 });
    expect(d).toEqual({ kind: "aboveSale", newOre: 16_000, refOre: 14_900 });
    expect(sp(priceDoubtText(d!))).toBe(
      "160,00 kr är mer än packet säljs för (ca 149,00 kr). Stämmer det?",
    );
    expect(priceDoubt({ newOre: 16_000, oldOre: 15_000, saleOre: 14_900 })?.kind).toBe("aboveSale");
  });
  it("inget att jämföra med, eller samma pris: ingen fråga", () => {
    expect(priceDoubt({ newOre: 11_250 })).toBeNull();
    expect(priceDoubt({ newOre: 11_250, oldOre: 0, saleOre: 0 })).toBeNull();
    expect(priceDoubt({ newOre: 11_250, oldOre: 11_250 })).toBeNull();
  });
  it("isPriceDoubt känner igen serverns svar", () => {
    expect(isPriceDoubt({ ok: false, error: "x", doubt: { kind: "higher" } })).toBe(true);
    expect(isPriceDoubt({ ok: false, error: "x" })).toBe(false);
    expect(isPriceDoubt({ ok: true })).toBe(false);
  });
});
