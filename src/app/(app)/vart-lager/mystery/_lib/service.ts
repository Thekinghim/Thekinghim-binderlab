/**
 * Skrivningarna för Mystery packs, bundna till en given användare (testbart utan Next).
 * Indata valideras med zod, rollen kontrolleras mot databasen och allt går genom RPC:erna
 * (security definer, samma kontroller i databasen):
 *
 * - Innehållet: public.save_mystery_recipe (ägare, admin), en ny version från i dag.
 * - Packa: public.pack_mystery (ägare, admin, påfyllare), en transaktion, idempotent på id.
 * - Ångra: public.undo_mystery_packing inom 30 minuter.
 * - Inköpspriset: Inköprisers addPurchasePriceFor (från i dag, ägare och admin).
 * - Kalkylens pris: updateMysteryCostFor räknar kostnaden på servern (innehållet × dagens
 *   inköpspriser) och lägger in den från i dag, eller rättar priset för all försäljning när
 *   ägaren väljer det. Historiken skrivs aldrig om utan det valet.
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { PriceIndex, recipeCost } from "@/domain";
import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { queryMysteryRecipeRefs, queryPrices } from "@/server/data/core/queries";
import { pgErrorOf } from "@/server/errors";

import { addPurchasePriceFor, correctPurchasePriceFor } from "../../../inkopspriser/_lib/data";
import { MAX_UNIT_COST_ORE, PRICE_MESSAGES } from "../../../inkopspriser/_lib/model";
import { PACK_ROLES, RECIPE_ROLES } from "./data";
import { MAX_BATCH_SIZE, MAX_BATCHES, MAX_ITEMS } from "./model";

/** Fel som visas som de är (databasens meddelande eller valideringen). */
export class MysteryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MysteryError";
  }
}

const uuid = z
  .string({ error: "Ogiltigt id." })
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Ogiltigt id.");

const INVALID = "Ogiltiga uppgifter. Ladda om sidan och försök igen.";

export const recipeSchema = z.object(
  {
    titleId: uuid,
    batchSize: z
      .number({ error: "Ange hur många pack en omgång är." })
      .int("Ange ett heltal.")
      .min(1, "En omgång är minst 1 pack.")
      .max(MAX_BATCH_SIZE, `En omgång är högst ${MAX_BATCH_SIZE} pack.`),
    note: z.string().max(500, "Noteringen får vara högst 500 tecken.").optional(),
    items: z
      .array(
        z.object(
          {
            titleId: uuid,
            quantity: z
              .number({ error: "Ange antal." })
              .int("Ange ett heltal.")
              .min(1, "Varje rad behöver minst 1.")
              .max(MAX_BATCH_SIZE, `Högst ${MAX_BATCH_SIZE} per rad.`),
            hit: z.boolean().default(false),
          },
          { error: INVALID },
        ),
        { error: INVALID },
      )
      .min(1, "Lägg till minst en titel.")
      .max(MAX_ITEMS, `Högst ${MAX_ITEMS} titlar.`),
  },
  { error: INVALID },
);

export const packSchema = z.object(
  {
    titleId: uuid,
    placeId: uuid,
    batches: z
      .number({ error: "Välj antal omgångar." })
      .int("Ange ett heltal.")
      .min(1, "Minst 1 omgång.")
      .max(MAX_BATCHES, `Högst ${MAX_BATCHES} omgångar.`),
    /** Innehållets version som visades (nekas om den ändrats). */
    recipeId: uuid,
    /** Inskickets id (samma id två gånger ger samma packning). */
    clientId: uuid,
  },
  { error: INVALID },
);

export const undoPackSchema = z.object({ packingId: uuid }, { error: INVALID });

export const setCostSchema = z.object(
  {
    titleId: uuid,
    unitCostOre: z
      .number({ error: INVALID })
      .int(INVALID)
      .min(0, INVALID)
      .max(MAX_UNIT_COST_ORE, INVALID),
  },
  { error: INVALID },
);

function rethrowKnown(error: unknown): never {
  const pg = pgErrorOf(error);
  if ((pg?.code === "22023" || pg?.code === "42501") && pg.message) {
    throw new MysteryError(pg.message);
  }
  throw error;
}

async function levelsAt(tx: Tx, orgId: string, placeId: string, titleIds: readonly string[]) {
  const rows = await tx
    .select({ titleId: s.stockLevels.titleId, q: s.stockLevels.quantity })
    .from(s.stockLevels)
    .where(and(eq(s.stockLevels.organizationId, orgId), eq(s.stockLevels.locationId, placeId)));
  const set = new Set(titleIds);
  return Object.fromEntries(rows.filter((r) => set.has(r.titleId)).map((r) => [r.titleId, r.q]));
}

/** Spara innehållet (en ny version från i dag). Returnerar versionens id. */
export async function saveRecipeFor(
  viewer: Viewer,
  input: z.infer<typeof recipeSchema>,
): Promise<{ recipeId: string }> {
  await requireRoleFor(viewer.user, viewer.organization.id, RECIPE_ROLES);
  const orgId = viewer.organization.id;
  const items = input.items.map((i) => ({ titleId: i.titleId, quantity: i.quantity, hit: i.hit }));
  return withUserDbFor(viewer.user, async (tx) => {
    try {
      const result = await tx.execute(
        sql`select public.save_mystery_recipe(${orgId}::uuid, ${input.titleId}::uuid,
              ${input.batchSize}::integer, ${JSON.stringify(items)}::jsonb,
              ${input.note?.trim() || null})::text as id`,
      );
      return { recipeId: (Array.from(result)[0] as { id: string }).id };
    } catch (error) {
      rethrowKnown(error);
    }
  });
}

export interface PackResult {
  readonly packingId: string;
  readonly packs: number;
  readonly duplicate: boolean;
  /** Saldot efter packningen i lagret (titelns id → pack), delarna och mystery-packet. */
  readonly levels: Readonly<Record<string, number>>;
}

/** Packa N omgångar i ett eget lager. */
export async function packFor(
  viewer: Viewer,
  input: z.infer<typeof packSchema>,
): Promise<PackResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, PACK_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    let row: { packing_id: string; pack_count: number; duplicate: boolean };
    try {
      const result = await tx.execute(
        sql`select packing_id::text, pack_count, duplicate
            from public.pack_mystery(${orgId}::uuid, ${input.clientId}::uuid,
              ${input.titleId}::uuid, ${input.placeId}::uuid, ${input.batches}::integer,
              ${input.recipeId}::uuid)`,
      );
      row = Array.from(result)[0] as typeof row;
    } catch (error) {
      rethrowKnown(error);
    }
    const parts = await tx
      .select({ titleId: s.mysteryRecipeItems.componentTitleId })
      .from(s.mysteryRecipeItems)
      .where(
        and(
          eq(s.mysteryRecipeItems.organizationId, orgId),
          eq(s.mysteryRecipeItems.recipeId, input.recipeId),
        ),
      );
    return {
      packingId: row.packing_id,
      packs: Number(row.pack_count),
      duplicate: row.duplicate,
      levels: await levelsAt(tx, orgId, input.placeId, [
        input.titleId,
        ...parts.map((p) => p.titleId),
      ]),
    };
  });
}

/** Ångra en packning (inom 30 minuter). */
export async function undoPackFor(
  viewer: Viewer,
  input: z.infer<typeof undoPackSchema>,
): Promise<{ packingId: string }> {
  await requireRoleFor(viewer.user, viewer.organization.id, PACK_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    try {
      await tx.execute(
        sql`select public.undo_mystery_packing(${orgId}::uuid, ${input.packingId}::uuid)`,
      );
    } catch (error) {
      rethrowKnown(error);
    }
    return { packingId: input.packingId };
  });
}

/** "Sätt inköpspris till X kr": ett inköpspris från i dag för mystery-packet. */
export async function setMysteryCostFor(
  viewer: Viewer,
  input: z.infer<typeof setCostSchema>,
  now: Date = new Date(),
): Promise<{ unitCostOre: number; validFrom: string }> {
  await requireRoleFor(viewer.user, viewer.organization.id, RECIPE_ROLES);
  const today = businessToday(now, viewer.organization.timezone);
  const result = await addPurchasePriceFor(viewer.user, {
    organizationId: viewer.organization.id,
    titleId: input.titleId,
    unitCostOre: input.unitCostOre,
    validFrom: today,
    note: "Snittet av innehållet (Mystery packs)",
  });
  if (!result.ok) throw new MysteryError(result.error);
  return { unitCostOre: input.unitCostOre, validFrom: today };
}

/** Felen från updateMysteryCostFor (visas som de är; engelskan finns i @/i18n). */
export const COST_MESSAGES = {
  noRecipe: "Mystery-packet har inget innehåll än.",
  missingPrice: "En del saknar inköpspris. Lägg in det först.",
  changed: "Kalkylen har ändrats. Ladda om sidan och försök igen.",
} as const;

export const updateCostSchema = z.object(
  {
    titleId: uuid,
    /** Kostnaden per pack som sidan visade (öre). Nekas om kalkylen har ändrats sedan dess. */
    expectedOre: z
      .number({ error: INVALID })
      .int(INVALID)
      .min(0, INVALID)
      .max(MAX_UNIT_COST_ORE, INVALID),
    /** "today": nytt pris från i dag. "correct": Rätta priset (all försäljning hittills). */
    mode: z.enum(["today", "correct"], { error: INVALID }),
  },
  { error: INVALID },
);

export interface UpdateCostResult {
  readonly unitCostOre: number;
  readonly mode: "today" | "correct";
  /** Första dagen som har det nya priset. */
  readonly validFrom: string;
  /** Rätta priset: sålda order som fick nytt pris (0 för "från i dag"). */
  readonly affectedOrders: number;
}

/**
 * Sätter mystery-packets inköpspris till kalkylen: innehållet × dagens inköpspriser på
 * delarna, räknat här på servern (aldrig ett belopp från klienten). `expectedOre` är vad
 * sidan visade; stämmer det inte längre nekas ändringen så att ingen sparar ett pris den
 * inte har sett.
 *
 * - "today": ett nytt inköpspris från i dag. Sålda pack behåller sitt pris.
 * - "correct": Rätta priset, samma regler som Inköpspriser (stängda månader rörs inte).
 *
 * Ägare och admin. Allt loggas i audit_log av triggern på purchase_prices.
 */
export async function updateMysteryCostFor(
  viewer: Viewer,
  input: z.infer<typeof updateCostSchema>,
  now: Date = new Date(),
): Promise<UpdateCostResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, RECIPE_ROLES);
  const orgId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  const calc = await withUserDbFor(viewer.user, async (tx) => {
    const [recipes, prices] = await Promise.all([
      queryMysteryRecipeRefs(tx, orgId),
      queryPrices(tx, orgId),
    ]);
    const recipe = recipes.find((r) => r.titleId === input.titleId);
    if (!recipe) throw new MysteryError(COST_MESSAGES.noRecipe);
    const index = new PriceIndex(prices);
    return {
      perPackOre: recipeCost(recipe, (id) => index.priceOn(id, today)?.unitCostOre ?? null)
        .perPackOre,
      own: index.priceOn(input.titleId, today) ?? null,
    };
  });
  const cost = calc.perPackOre;
  if (cost === null) throw new MysteryError(COST_MESSAGES.missingPrice);
  if (cost !== input.expectedOre) throw new MysteryError(COST_MESSAGES.changed);

  // Ett andra tryck (dubbeltryck, två flikar) ska ge samma läge, inte ett fel: priset från
  // i dag är redan kalkylen, så inget skrivs och inget loggas en gång till.
  if (input.mode === "today" && calc.own?.unitCostOre === cost) {
    return { unitCostOre: cost, mode: "today", validFrom: calc.own.validFrom, affectedOrders: 0 };
  }

  if (input.mode === "correct") {
    const result = await correctPurchasePriceFor(viewer.user, {
      organizationId: orgId,
      titleId: input.titleId,
      unitCostOre: cost,
      today,
      note: "Rättat efter kalkylen (Mystery packs)",
    });
    if (result.ok) {
      return {
        unitCostOre: cost,
        mode: "correct",
        validFrom: result.data?.start ?? today,
        affectedOrders: result.data?.affectedOrders ?? 0,
      };
    }
    // Redan rättat (ett andra tryck): all försäljning har priset, så det är inget fel.
    if (result.error === PRICE_MESSAGES.correctionUnchanged) {
      return { unitCostOre: cost, mode: "correct", validFrom: today, affectedOrders: 0 };
    }
    // Inget pris alls och inget går att rätta (allt ligger i stängda månader): priset läggs
    // in från i dag nedan, så att mystery-packet inte står kvar utan pris.
    if (!(calc.own === null && result.error === PRICE_MESSAGES.correctionClosed)) {
      throw new MysteryError(result.error);
    }
  }
  const result = await addPurchasePriceFor(viewer.user, {
    organizationId: orgId,
    titleId: input.titleId,
    unitCostOre: cost,
    validFrom: today,
    note: "Kalkylen (Mystery packs)",
  });
  if (!result.ok) throw new MysteryError(result.error);
  return { unitCostOre: cost, mode: "today", validFrom: today, affectedOrders: 0 };
}
