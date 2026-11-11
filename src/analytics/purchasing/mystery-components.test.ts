/** Inköp: delarna som mystery packs äter upp (runda 2, T3-5). */
import { describe, expect, it } from "vitest";

import { componentNeed, componentNeeds, mysteryShare } from "./mystery-components";
import { purchasePlan, purchaseQty } from "./plan";
import type { PurchasingInput } from "./types";

/** En omgång om 14: 4 Pokémon 151, 9 Paldea och 1 träff. */
const RECIPE = {
  titleId: "MP",
  batchSize: 14,
  items: [
    { titleId: "151", quantity: 4 },
    { titleId: "PAL", quantity: 9 },
    { titleId: "HIT", quantity: 1 },
  ],
};

describe("componentNeed", () => {
  it("2 omgångar med 4 Pokémon 151 per omgång höjer behovet med 8", () => {
    const need = componentNeed(2, RECIPE);
    expect(need.get("151")).toBe(8);
    expect(need.get("PAL")).toBe(18);
    expect(need.get("HIT")).toBe(2);
  });

  it("färdiga pack hemma sänker behovet bara när en hel omgång ligger där", () => {
    expect(componentNeed(2, RECIPE, 13).get("151")).toBe(8);
    expect(componentNeed(2, RECIPE, 14).get("151")).toBe(4);
    expect(componentNeed(2, RECIPE, 27).get("151")).toBe(4);
    expect(componentNeed(2, RECIPE, 28).size).toBe(0);
    // Fler färdiga än som behövs: aldrig under 0.
    expect(componentNeed(1, RECIPE, 100).size).toBe(0);
    // Under 0 hemma (ska räknas om) räknas som 0.
    expect(componentNeed(1, RECIPE, -5).get("151")).toBe(4);
  });

  it("inga omgångar: inget behov", () => {
    expect(componentNeed(0, RECIPE).size).toBe(0);
    expect(componentNeed(-1, RECIPE).size).toBe(0);
    expect(componentNeed(Number.NaN, RECIPE).size).toBe(0);
  });
});

describe("componentNeeds", () => {
  it("lägger ihop två mystery packs som delar på samma titel, mest först", () => {
    const other = { titleId: "MP2", batchSize: 10, items: [{ titleId: "151", quantity: 10 }] };
    const needs = componentNeeds([RECIPE, other], (id) => (id === "MP" ? 2 : 1));
    expect(needs.get("151")).toEqual({
      packs: 18,
      parts: [
        { titleId: "MP2", batches: 1, packs: 10 },
        { titleId: "MP", batches: 2, packs: 8 },
      ],
    });
    expect(needs.get("PAL")?.packs).toBe(18);
  });

  it("ett mystery pack utan omgångar ger inget", () => {
    expect(componentNeeds([RECIPE], () => 0).size).toBe(0);
    expect(componentNeeds([RECIPE], () => null).size).toBe(0);
  });
});

describe("mysteryShare", () => {
  it("högst det som köps och högst det som mystery packen behöver", () => {
    expect(mysteryShare(24, 16)).toBe(16);
    expect(mysteryShare(5, 16)).toBe(5);
    expect(mysteryShare(null, 16)).toBe(0);
    expect(mysteryShare(24, 0)).toBe(0);
  });
});

/**
 * Planen: MP säljer `mpPerDay` pack/dag, 151 säljer `perDay151`. Ledtid 7 + intervall 7 =
 * 14 dagars behov, ingen varians (inget säkerhetslager).
 */
function input(over: {
  mpPerDayMilli?: number;
  perDay151Milli?: number;
  home?: Record<string, number>;
  recipes?: PurchasingInput["mysteryRecipes"];
  mysteryBatches?: PurchasingInput["mysteryBatches"];
  supplier151?: boolean;
}): PurchasingInput {
  const home = over.home ?? {};
  const demand = (titleId: string, milli: number) => ({
    titleId,
    dailyMilli: new Array<number>(28).fill(milli),
    dayVarianceMilli2: 0,
  });
  return {
    today: "2026-11-02",
    titles: [
      { id: "MP", name: "Mystery Pack", mysteryBatchSize: 14 },
      { id: "151", name: "Pokémon 151" },
      { id: "PAL", name: "Paldea" },
      { id: "HIT", name: "Träffen" },
    ],
    suppliers: over.supplier151 ? [{ id: "S", name: "Grossisten", defaultLeadTimeDays: 7 }] : [],
    supplierItems: over.supplier151
      ? [
          {
            id: "I",
            supplierId: "S",
            titleId: "151",
            packSize: 12,
            minOrderQty: 0,
            leadTimeDays: null,
            unitCostOre: 5_000,
          },
        ]
      : [],
    warehouseStock: Object.entries(home).map(([titleId, onHand]) => ({ titleId, onHand })),
    machineStock: [],
    openPurchaseOrders: [],
    demand: [
      demand("MP", over.mpPerDayMilli ?? 1_500),
      ...(over.perDay151Milli ? [demand("151", over.perDay151Milli)] : []),
    ],
    ...(over.recipes === undefined
      ? { mysteryRecipes: [RECIPE] }
      : { mysteryRecipes: over.recipes }),
    ...(over.mysteryBatches ? { mysteryBatches: over.mysteryBatches } : {}),
  };
}

const lineOf = (plan: ReturnType<typeof purchasePlan>, id: string) =>
  plan.lines.find((l) => l.titleId === id);

describe("inköpsplanen: delarna som mystery packs äter upp", () => {
  it("omgångarna × innehållet läggs på delens behov innan antalet räknas", () => {
    // MP: 1,5/dag × 14 = 21 pack → 2 omgångar. 151 säljer 1/dag × 14 = 14, + 8 till MP = 22.
    const plan = purchasePlan(input({ perDay151Milli: 1_000 }));
    expect(purchaseQty(lineOf(plan, "MP")!)).toBe(28);
    const l = lineOf(plan, "151")!;
    expect(l.status).toBe("no-supplier");
    expect(purchaseQty(l)).toBe(22);
    expect(l.mysteryNeed).toEqual({
      packs: 8,
      parts: [{ titleId: "MP", batches: 2, packs: 8 }],
    });
    expect(mysteryShare(purchaseQty(l), l.mysteryNeed!.packs)).toBe(8);
    expect(l.text).toMatch(/\+ 8 pack till 2\somgångar Mystery Pack = 22;/);
    expect(l.evidence.figures.find((f) => f.key === "mysteryNeedPacks")?.value).toBe(8);
    // Utan innehåll: som förr.
    const before = purchasePlan(input({ perDay151Milli: 1_000, recipes: [] }));
    expect(purchaseQty(lineOf(before, "151")!)).toBe(14);
    expect(lineOf(before, "151")!.mysteryNeed).toBeUndefined();
  });

  it("en del som inte säljs själv ska ändå köpas", () => {
    const plan = purchasePlan(input({}));
    const pal = lineOf(plan, "PAL")!;
    expect(pal.status).toBe("no-supplier");
    expect(purchaseQty(pal)).toBe(18);
    expect(purchaseQty(lineOf(plan, "HIT")!)).toBe(2);
  });

  it("det som ligger hemma av delen dras av", () => {
    const plan = purchasePlan(input({ home: { PAL: 10, HIT: 2 } }));
    expect(purchaseQty(lineOf(plan, "PAL")!)).toBe(8);
    const hit = lineOf(plan, "HIT")!;
    expect(hit.status).toBe("ok");
    expect(purchaseQty(hit)).toBe(0);
  });

  it("färdiga mystery packs sänker delarnas behov när de sänker omgångarna", () => {
    // 21 behövs. 14 färdiga hemma → 7 saknas → 1 omgång → 4 st 151.
    const one = purchasePlan(input({ home: { MP: 14 } }));
    expect(purchaseQty(lineOf(one, "MP")!)).toBe(14);
    expect(purchaseQty(lineOf(one, "151")!)).toBe(4);
    // 28 färdiga: inget att packa, inget extra behov och ingen rad för delen.
    const none = purchasePlan(input({ home: { MP: 28 } }));
    expect(purchaseQty(lineOf(none, "MP")!)).toBe(0);
    expect(lineOf(none, "151")).toBeUndefined();
  });

  it("med leverantör avrundas hela behovet till boxar", () => {
    // 14 + 8 = 22 → 2 boxar om 12 = 24. 8 av dem går till Mystery Pack.
    const plan = purchasePlan(input({ perDay151Milli: 1_000, supplier151: true }));
    const l = lineOf(plan, "151")!;
    expect(l.status).toBe("order");
    expect(purchaseQty(l)).toBe(24);
    expect(mysteryShare(purchaseQty(l), l.mysteryNeed!.packs)).toBe(8);
  });

  it("fackens antal (R2-9): raden visar det, men delarna köps aldrig för mindre än planen", () => {
    // Planen: 2 omgångar (ledtid + dagar till nästa beställning). Facken: 1 omgång i veckan.
    const plan = purchasePlan(
      input({ perDay151Milli: 1_000, mysteryBatches: [{ titleId: "MP", batches: 1 }] }),
    );
    // Raden för mystery packet säger det som ska packas NU, samma som Mystery-sidan.
    const mp = lineOf(plan, "MP")!;
    expect(mp.packNow).toEqual({ batches: 1, packs: 14 });
    expect(purchaseQty(mp)).toBe(14);
    // Delarna: fortfarande 2 omgångar × 4 = 8 till. Delar tar ca en vecka att få hem, så
    // fackens 7 dagar får inte sänka det som köps.
    expect(purchaseQty(lineOf(plan, "151")!)).toBe(22);
    expect(lineOf(plan, "151")!.mysteryNeed?.parts[0]?.batches).toBe(2);
  });

  it("fackens antal är ett golv för delarna: fler tomma fack än planen ser", () => {
    // T.ex. nya automater utan försäljning: planen säger 2, facken 3 → delar till 3.
    const plan = purchasePlan(
      input({ perDay151Milli: 1_000, mysteryBatches: [{ titleId: "MP", batches: 3 }] }),
    );
    expect(purchaseQty(lineOf(plan, "MP")!)).toBe(42);
    expect(purchaseQty(lineOf(plan, "151")!)).toBe(26);
    expect(lineOf(plan, "151")!.mysteryNeed?.parts[0]?.batches).toBe(3);
  });

  it("facken säger 0: inget att packa nu, men delarna till planens omgångar köps ändå", () => {
    const plan = purchasePlan(
      input({ perDay151Milli: 1_000, mysteryBatches: [{ titleId: "MP", batches: 0 }] }),
    );
    expect(purchaseQty(lineOf(plan, "MP")!)).toBe(0);
    expect(purchaseQty(lineOf(plan, "151")!)).toBe(22);
  });

  it("mystery-packets egen rad ändras inte av innehållet", () => {
    const withRecipe = lineOf(purchasePlan(input({})), "MP")!;
    const without = lineOf(purchasePlan(input({ recipes: [] })), "MP")!;
    expect(withRecipe).toEqual(without);
  });
});
