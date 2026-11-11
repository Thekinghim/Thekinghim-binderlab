/**
 * Att göra: "Mystery pack premium kostar nu 213 kr, inte 174 kr" när kalkylen (innehållet ×
 * dagens inköpspriser) inte är mystery-packets eget inköpspris.
 */
import { describe, expect, it } from "vitest";

import type { MysteryRecipeRef, PurchasePrice } from "@/domain";

import { applyDismissals } from "./dismissals";
import { computeTodos } from "./index";
import { input, NOW, title } from "./test-helpers";

const RECIPE: MysteryRecipeRef = {
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

const TITLES = [
  title("premium", "Mystery pack premium", { mysteryBatchSize: 14 }),
  title("fusion", "Fusion Strike"),
  title("celebration", "30th Celebration"),
  title("flames", "Phantasmal Flames"),
  title("prismatic", "Prismatic Evolution"),
  title("heroes", "Ascended Heroes"),
  title("hit", "Hit"),
];

const price = (titleId: string, unitCostOre: number, validFrom = "2026-10-01"): PurchasePrice => ({
  titleId,
  unitCostOre,
  validFrom,
});

/** Fusion Strike 133 kr → kalkylen 188,14 kr; med 220 kr → 213 kr. */
const prices = (extra: PurchasePrice[] = []) => [
  price("fusion", 13_300),
  price("celebration", 25_000),
  price("flames", 15_000),
  price("prismatic", 30_000),
  price("heroes", 20_000),
  price("hit", 25_200),
  price("premium", 17_400),
  ...extra,
];

const todos = (p: PurchasePrice[], recipes: MysteryRecipeRef[] = [RECIPE]) =>
  computeTodos(input({ titles: TITLES, prices: p, mysteryRecipes: recipes }), NOW).filter(
    (t) => t.kind === "mystery-cost",
  );

describe("mystery pack med fel inköpspris", () => {
  it("delens pris rättas från 133 till 220 kr: kostar nu 213 kr, inte 174 kr", () => {
    const [t, ...rest] = todos(prices([price("fusion", 22_000, "2026-11-01")]));
    expect(rest).toEqual([]);
    expect(t).toMatchObject({
      key: "mystery-cost:premium",
      kind: "mystery-cost",
      level: "soon",
      title: "Mystery pack premium kostar nu 213 kr, inte 174 kr",
      link: "/vart-lager/mystery/premium#kalkyl",
      action: { kind: "open-mystery", label: "Uppdatera priset" },
      fingerprint: "17400|21300",
    });
    expect(t?.evidence.titleIds).toEqual(["premium"]);
  });

  it("ören visas när kalkylen inte är jämn", () => {
    expect(todos(prices())[0]?.title).toBe("Mystery pack premium kostar nu 188,14 kr, inte 174 kr");
  });

  it("ingen punkt när priset stämmer, utan innehåll eller när en del saknar pris", () => {
    expect(todos(prices([price("premium", 18_814, "2026-11-01")]))).toEqual([]);
    expect(todos(prices(), [])).toEqual([]);
    // Påfyllarens underlag har inget innehåll alls.
    const none = computeTodos(input({ titles: TITLES, prices: prices() }), NOW);
    expect(none.filter((t) => t.kind === "mystery-cost")).toEqual([]);
    expect(todos(prices().filter((p) => p.titleId !== "hit"))).toEqual([]);
  });

  it("ett pris som börjar gälla i morgon räknas inte än", () => {
    expect(todos(prices([price("premium", 18_814, "2026-11-03")]))).toHaveLength(1);
  });

  it("saknar mystery-packet eget pris sägs det", () => {
    const [t] = todos(prices().filter((p) => p.titleId !== "premium"));
    expect(t?.title).toBe("Mystery pack premium kostar 188,14 kr men saknar inköpspris");
    expect(t?.fingerprint).toBe("-|18814");
    // Inget har "ändrats": priset har aldrig lagts in.
    expect(t?.detail).toBe("Utan inköpspris räknas ingen vinst på sålda pack. Lägg in priset.");
  });

  it("arkiverat mystery pack ger ingen punkt", () => {
    const archived = TITLES.map((t) => (t.id === "premium" ? { ...t, archived: true } : t));
    const items = computeTodos(
      input({ titles: archived, prices: prices(), mysteryRecipes: [RECIPE] }),
      NOW,
    );
    expect(items.filter((t) => t.kind === "mystery-cost")).toEqual([]);
  });

  it("en avbockad punkt kommer tillbaka när skillnaden ändras", () => {
    const before = todos(prices());
    const dismissed = [{ key: before[0]!.key, fingerprint: before[0]!.fingerprint }];
    expect(applyDismissals(before, dismissed)).toEqual([]);
    const after = todos(prices([price("fusion", 22_000, "2026-11-01")]));
    expect(applyDismissals(after, dismissed)).toHaveLength(1);
  });
});
