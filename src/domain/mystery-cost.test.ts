import { describe, expect, it } from "vitest";

import { mysteryCostDrifts, recipeCost, type MysteryRecipeRef } from "./mystery-cost";

/** Mystery pack premium: 14 per omgång (ägarens recept). */
const PREMIUM: MysteryRecipeRef = {
  titleId: "premium",
  batchSize: 14,
  items: [
    { titleId: "fusion", quantity: 4 },
    { titleId: "celebration", quantity: 3 },
    { titleId: "flames", quantity: 4 },
    { titleId: "prismatic", quantity: 1 },
    { titleId: "heroes", quantity: 1 },
    { titleId: "hit", quantity: 1 },
  ],
};

const prices = (fusion: number, own: number | null = 17_400) => {
  const map: Record<string, number | null> = {
    fusion,
    celebration: 25_000,
    flames: 15_000,
    prismatic: 30_000,
    heroes: 20_000,
    hit: 25_200,
    premium: own,
  };
  return (id: string) => map[id];
};

describe("recipeCost", () => {
  it("räknar omgången och ett pack med dagens priser", () => {
    // 4×220 + 3×250 + 4×150 + 300 + 200 + 252 = 2 982 kr → 213 kr per pack.
    const cost = recipeCost(PREMIUM, prices(22_000));
    expect(cost.perBatchOre).toBe(298_200);
    expect(cost.perPackOre).toBe(21_300);
    expect(cost.quantity).toBe(14);
    expect(cost.lines[0]).toEqual({
      titleId: "fusion",
      quantity: 4,
      unitCostOre: 22_000,
      totalOre: 88_000,
    });
  });

  it("följer delens pris: Fusion Strike 133 kr ger en annan kostnad", () => {
    // 4×133 = 532 → 2 634 kr → 188,14 kr per pack (avrundat till öre).
    expect(recipeCost(PREMIUM, prices(13_300)).perPackOre).toBe(18_814);
  });

  it("saknar en del pris är kostnaden okänd, aldrig en gissning", () => {
    const cost = recipeCost(PREMIUM, (id) => (id === "hit" ? null : 10_000));
    expect(cost.perPackOre).toBeNull();
    expect(cost.perBatchOre).toBeNull();
    expect(cost.missingTitleIds).toEqual(["hit"]);
    expect(cost.lines.at(-1)).toMatchObject({ unitCostOre: null, totalOre: null });
  });

  it("tomt innehåll eller omgång 0 ger ingen kostnad", () => {
    expect(recipeCost({ batchSize: 14, items: [] }, () => 100).perPackOre).toBeNull();
    expect(
      recipeCost({ batchSize: 0, items: [{ titleId: "a", quantity: 1 }] }, () => 100).perPackOre,
    ).toBeNull();
  });
});

describe("mysteryCostDrifts", () => {
  it("flaggar när titelns pris inte är kalkylen: kostar nu 213 kr, inte 174 kr", () => {
    expect(mysteryCostDrifts([PREMIUM], prices(22_000))).toEqual([
      { titleId: "premium", currentOre: 17_400, calculatedOre: 21_300 },
    ]);
  });

  it("ingen rad när priset stämmer på öret", () => {
    expect(mysteryCostDrifts([PREMIUM], prices(22_000, 21_300))).toEqual([]);
  });

  it("titeln saknar eget pris: rad med currentOre null", () => {
    expect(mysteryCostDrifts([PREMIUM], prices(22_000, null))).toEqual([
      { titleId: "premium", currentOre: null, calculatedOre: 21_300 },
    ]);
  });

  it("okänd kalkyl (en del saknar pris) ger ingen rad", () => {
    expect(mysteryCostDrifts([PREMIUM], (id) => (id === "fusion" ? null : 100))).toEqual([]);
  });
});
