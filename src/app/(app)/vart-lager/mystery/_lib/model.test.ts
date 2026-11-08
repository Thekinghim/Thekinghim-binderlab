import { describe, expect, it } from "vitest";

import {
  averageCost,
  batchesForPacks,
  checkDraft,
  defaultPlace,
  listText,
  maxBatches,
  packPlan,
  recipeOdds,
  shortages,
  type Recipe,
} from "./model";

/** Mystery Pack Plus 179 kr: 14 per omgång, två HIT-rader (3 av 14). */
const PLUS: Recipe = {
  id: "r1",
  titleId: "mp",
  version: 1,
  validFrom: "2026-11-08",
  batchSize: 14,
  note: null,
  items: [
    { titleId: "pf", name: "Phantasmal Flames", quantity: 4, hit: false },
    { titleId: "dr", name: "Delta Reign", quantity: 3, hit: false },
    { titleId: "ds", name: "Destined Rivals", quantity: 2, hit: false },
    { titleId: "ss", name: "Surging Sparks", quantity: 2, hit: false },
    { titleId: "ah", name: "Ascended Heroes", quantity: 2, hit: true },
    { titleId: "pe", name: "Prismatic Evolutions", quantity: 1, hit: true },
  ],
};

describe("recipeOdds", () => {
  it("räknar chans till hit och per rad i baspunkter", () => {
    const odds = recipeOdds(PLUS);
    expect(odds.hits).toBe(3);
    expect(odds.hitBp).toBe(2143); // 3/14 = 21,43 %
    expect(odds.items.map((i) => i.bp)).toEqual([2857, 2143, 1429, 1429, 1429, 714]);
  });

  it("utan hit är chansen 0", () => {
    const odds = recipeOdds({ batchSize: 2, items: [{ ...PLUS.items[0]!, quantity: 2 }] });
    expect(odds.hits).toBe(0);
    expect(odds.hitBp).toBe(0);
  });
});

describe("averageCost", () => {
  const prices = new Map([
    ["pf", 6000],
    ["dr", 5500],
    ["ds", 7000],
    ["ss", 6500],
    ["ah", 12000],
    ["pe", 15000],
  ]);

  it("snittet per pack är summan för omgången delat med storleken", () => {
    // 4×60 + 3×55 + 2×70 + 2×65 + 2×120 + 1×150 = 1 065 kr → 76,07 kr per pack.
    const cost = averageCost(PLUS, prices);
    expect(cost.perBatchOre).toBe(106_500);
    expect(cost.perPackOre).toBe(7607);
    expect(cost.missing).toEqual([]);
  });

  it("saknar en del pris finns inget snitt, och delen nämns", () => {
    const partial = new Map(prices);
    partial.delete("dr");
    const cost = averageCost(PLUS, partial);
    expect(cost.perPackOre).toBeNull();
    expect(cost.missing).toEqual(["Delta Reign"]);
  });
});

describe("maxBatches", () => {
  it("räknar hela omgångar och nämner delen som tar slut först", () => {
    const stock = { pf: 20, dr: 6, ds: 10, ss: 10, ah: 10, pe: 5 };
    const cap = maxBatches(PLUS, stock);
    expect(cap.batches).toBe(2); // 6 Delta Reign räcker till 2 omgångar
    expect(cap.limiting?.name).toBe("Delta Reign");
  });

  it("lika: den som står först i innehållet", () => {
    const cap = maxBatches(PLUS, { pf: 4, dr: 3, ds: 2, ss: 2, ah: 2, pe: 1 });
    expect(cap.batches).toBe(1);
    expect(cap.limiting?.name).toBe("Phantasmal Flames");
  });

  it("saknas en del helt (eller är minus) går det inte att packa", () => {
    const cap = maxBatches(PLUS, { pf: 40, dr: 30, ds: 20, ss: 20, ah: -3 });
    expect(cap.batches).toBe(0);
    expect(cap.limiting?.name).toBe("Ascended Heroes");
  });

  it("utan rader: 0 och ingen begränsning", () => {
    expect(maxBatches({ items: [] }, {})).toEqual({ batches: 0, limiting: null });
  });
});

describe("packPlan och shortages", () => {
  it("två omgångar tar dubbelt och lägger till 28", () => {
    const plan = packPlan(PLUS, 2);
    expect(plan.packs).toBe(28);
    expect(plan.takes.map((t) => t.quantity)).toEqual([8, 6, 4, 4, 4, 2]);
    expect(plan.takes.reduce((n, t) => n + t.quantity, 0)).toBe(plan.packs);
  });

  it("visar vad som fattas och hur många", () => {
    const missing = shortages(PLUS, 2, { pf: 8, dr: 4, ds: 4, ss: 4, ah: 4 });
    expect(missing).toEqual([
      { titleId: "dr", name: "Delta Reign", quantity: 2 },
      { titleId: "pe", name: "Prismatic Evolutions", quantity: 2 },
    ]);
    expect(listText(missing)).toBe("2 Delta Reign och 2 Prismatic Evolutions");
  });
});

describe("batchesForPacks", () => {
  it("avrundar uppåt och håller sig inom 1–10", () => {
    expect(batchesForPacks(28, 14)).toBe(2);
    expect(batchesForPacks(15, 14)).toBe(2);
    expect(batchesForPacks(0, 14)).toBe(1);
    expect(batchesForPacks(500, 14)).toBe(10);
  });
});

describe("defaultPlace", () => {
  const places = [
    { id: "hem", name: "Hemma", isDefault: true },
    { id: "kontor", name: "Kontoret", isDefault: false },
  ];

  it("väljer lagret med flest delar", () => {
    const pick = defaultPlace(PLUS, places, { hem: { pf: 2 }, kontor: { pf: 4, dr: 3 } });
    expect(pick?.id).toBe("kontor");
  });

  it("lika: standardlagret", () => {
    expect(defaultPlace(PLUS, [...places].reverse(), {})?.id).toBe("hem");
  });
});

describe("checkDraft", () => {
  const items = PLUS.items.map((i) => ({ titleId: i.titleId, quantity: i.quantity, hit: i.hit }));

  it("godkänner när summan är omgångens storlek", () => {
    expect(checkDraft(14, items)).toEqual({ ok: true, sum: 14, error: null });
  });

  it("säger hur många som fattas eller är för många", () => {
    expect(checkDraft(15, items).error).toBe("1 kvar att lägga till.");
    expect(checkDraft(13, items).error).toBe("1 för många.");
  });

  it("minst en rad, ingen dubblett, ingen tom rad", () => {
    expect(checkDraft(14, []).error).toBe("Lägg till minst en titel.");
    expect(checkDraft(8, [items[0]!, items[0]!]).error).toBe("Samma titel står två gånger.");
    expect(checkDraft(4, [{ titleId: "", quantity: 4, hit: false }]).error).toBe(
      "Välj en titel på varje rad.",
    );
  });
});
