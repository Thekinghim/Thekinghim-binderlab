/**
 * Mystery-kalkylen: vad ett mystery pack kostar med innehållet (receptet) och dagens
 * inköpspriser på delarna, och om titelns eget inköpspris har halkat efter.
 *
 *   omgångens kostnad = Σ (antal × delens inköpspris)
 *   per pack          = omgångens kostnad / omgångens storlek, avrundat till hela öre
 *
 * Saknar någon del inköpspris är kostnaden okänd (vi gissar aldrig).
 *
 * Sålda mystery packs räknas med titelns EGET inköpspris (purchase_prices), inte med
 * kalkylen. När en del byter pris eller innehållet ändras stämmer de två inte längre:
 * `mysteryCostDrifts` säger då "kostar nu 213 kr, inte 174 kr". Inget skrivs om av sig
 * självt; ägaren väljer "Uppdatera priset från i dag" eller "Rätta priset". Rena funktioner.
 */

/** En rad i innehållet: en del och antal per omgång. */
export interface RecipeCostItem {
  readonly titleId: string;
  readonly quantity: number;
}

/** Innehållet för en egen produkt (gällande version). */
export interface MysteryRecipeRef {
  /** Mystery-packets titel. */
  readonly titleId: string;
  readonly batchSize: number;
  readonly items: readonly RecipeCostItem[];
}

export interface RecipeCostLine extends RecipeCostItem {
  /** Delens inköpspris (öre), null när det saknas. */
  readonly unitCostOre: number | null;
  /** antal × pris (öre), null när priset saknas. */
  readonly totalOre: number | null;
}

export interface RecipeCost {
  readonly lines: readonly RecipeCostLine[];
  /** Summan av antalen (ska vara omgångens storlek). */
  readonly quantity: number;
  /** Kostnaden för en hel omgång (öre), null när någon del saknar pris. */
  readonly perBatchOre: number | null;
  /** Kostnaden per mystery pack (öre), null när någon del saknar pris. */
  readonly perPackOre: number | null;
  /** Delarna som saknar inköpspris, i innehållets ordning. */
  readonly missingTitleIds: readonly string[];
}

/** Kostnaden per omgång och per pack med de givna priserna (titelns id → öre). */
export function recipeCost(
  recipe: Pick<MysteryRecipeRef, "batchSize" | "items">,
  priceOf: (titleId: string) => number | null | undefined,
): RecipeCost {
  let total = 0;
  let quantity = 0;
  const missing: string[] = [];
  const lines = recipe.items.map((i): RecipeCostLine => {
    const p = priceOf(i.titleId);
    quantity += i.quantity;
    if (p === null || p === undefined) {
      missing.push(i.titleId);
      return { ...i, unitCostOre: null, totalOre: null };
    }
    total += p * i.quantity;
    return { ...i, unitCostOre: p, totalOre: p * i.quantity };
  });
  const known = missing.length === 0 && recipe.batchSize > 0 && recipe.items.length > 0;
  return {
    lines,
    quantity,
    perBatchOre: known ? total : null,
    perPackOre: known ? Math.round(total / recipe.batchSize) : null,
    missingTitleIds: missing,
  };
}

/** Ett mystery pack vars inköpspris inte stämmer med kalkylen. */
export interface MysteryCostDrift {
  readonly titleId: string;
  /** Titelns inköpspris i dag (öre), null när det saknas. */
  readonly currentOre: number | null;
  /** Kalkylens kostnad per pack i dag (öre). */
  readonly calculatedOre: number;
}

/**
 * Mystery packs där kalkylen (innehållet × dagens priser) inte är titelns inköpspris i dag.
 * Okänd kalkyl (en del saknar pris) ger ingen rad: då är det delens pris som ska in först.
 */
export function mysteryCostDrifts(
  recipes: readonly MysteryRecipeRef[],
  priceOf: (titleId: string) => number | null | undefined,
): MysteryCostDrift[] {
  const out: MysteryCostDrift[] = [];
  for (const r of recipes) {
    const calculated = recipeCost(r, priceOf).perPackOre;
    if (calculated === null) continue;
    const current = priceOf(r.titleId) ?? null;
    if (current !== calculated) {
      out.push({ titleId: r.titleId, currentOre: current, calculatedOre: calculated });
    }
  }
  return out;
}
