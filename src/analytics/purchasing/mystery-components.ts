/**
 * Delarna som mystery packs äter upp (runda 2, T3-5).
 *
 * Ett mystery pack packas hemma av andra titlar ("delar"): innehållet säger hur många pack
 * av varje del som går åt till EN omgång (mystery_recipe_items.quantity). Ska två omgångar
 * packas och innehållet har 4 Pokémon 151 per omgång behövs 8 Pokémon 151 till, utöver det
 * som titeln säljer själv i automaterna. Inköpsplanen lägger det på delens behov innan
 * antalet att köpa räknas, och inköpslistan säger hur många av packen som går dit:
 * "16 av dem går till Mystery Pack".
 *
 * Rena funktioner. Antal i hela pack.
 */

import type { MysteryRecipeRef } from "@/domain";

type Recipe = Pick<MysteryRecipeRef, "batchSize" | "items">;

const whole = (n: number | null | undefined): number =>
  n === null || n === undefined || !Number.isFinite(n) ? 0 : Math.max(0, Math.trunc(n));

/**
 * Pack av varje del som går åt till `batches` omgångar (delens titel → pack).
 *
 * `finishedAtHome` är färdiga mystery packs som redan ligger hemma. De sänker behovet bara
 * i hela omgångar: 14 färdiga (omgång 14) tar bort en omgång, 13 färdiga tar inte bort
 * någon, för en omgång packas alltid hel. Lämna den som 0 när `batches` redan är räknat
 * efter det som ligger hemma (inköpsplanens antal är det), annars dras det av två gånger.
 *
 * componentNeed(2, { batchSize: 14, items: [{ titleId: "151", quantity: 4 }, …] }) → 151: 8
 */
export function componentNeed(
  batches: number,
  recipe: Recipe,
  finishedAtHome: number = 0,
): Map<string, number> {
  const out = new Map<string, number>();
  const size = whole(recipe.batchSize);
  const ready = size > 0 ? Math.floor(whole(finishedAtHome) / size) : 0;
  const toPack = Math.max(0, whole(batches) - ready);
  if (toPack === 0) return out;
  for (const item of recipe.items) {
    const q = whole(item.quantity);
    if (q === 0) continue;
    out.set(item.titleId, (out.get(item.titleId) ?? 0) + q * toPack);
  }
  return out;
}

/** Varifrån en dels extra behov kommer: ett mystery pack och dess omgångar. */
export interface MysteryNeedPart {
  /** Mystery-packets titel. */
  readonly titleId: string;
  /** Omgångar som ska packas. */
  readonly batches: number;
  /** Pack av delen som går åt till dem. */
  readonly packs: number;
}

/** En dels behov till mystery packs. */
export interface MysteryNeed {
  /** Pack av delen som går åt, alla mystery packs tillsammans. */
  readonly packs: number;
  /** Per mystery pack, mest först. */
  readonly parts: readonly MysteryNeedPart[];
}

/**
 * Behovet per del för alla mystery packs som ska packas. `batchesOf` ger omgångarna för ett
 * mystery pack (0 eller okänt = inget). Delar utan behov finns inte med.
 */
export function componentNeeds(
  recipes: readonly MysteryRecipeRef[],
  batchesOf: (mysteryTitleId: string) => number | null | undefined,
): Map<string, MysteryNeed> {
  const parts = new Map<string, MysteryNeedPart[]>();
  for (const recipe of recipes) {
    const batches = whole(batchesOf(recipe.titleId));
    for (const [componentId, packs] of componentNeed(batches, recipe)) {
      // Ett mystery pack kan inte vara en del av sig självt (databasen stoppar det också).
      if (componentId === recipe.titleId) continue;
      const list = parts.get(componentId) ?? [];
      list.push({ titleId: recipe.titleId, batches, packs });
      parts.set(componentId, list);
    }
  }
  const out = new Map<string, MysteryNeed>();
  for (const [componentId, list] of parts) {
    list.sort((a, b) => b.packs - a.packs || (a.titleId < b.titleId ? -1 : 1));
    out.set(componentId, { packs: list.reduce((s, p) => s + p.packs, 0), parts: list });
  }
  return out;
}

/**
 * Hur många av packen som köps som går till mystery packs: högst det som köps och högst det
 * som mystery packen behöver. "Köp 24, 16 av dem går till Mystery Pack" · köps bara 5 när
 * 16 behövs (resten ligger redan hemma) går alla 5 dit.
 */
export function mysteryShare(buyQty: number | null | undefined, needPacks: number): number {
  return Math.min(whole(buyQty), whole(needPacks));
}
