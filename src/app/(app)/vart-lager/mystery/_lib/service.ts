/**
 * Skrivningarna för Mystery packs, bundna till en given användare (testbart utan Next).
 * Indata valideras med zod, rollen kontrolleras mot databasen och allt går genom RPC:erna
 * (security definer, samma kontroller i databasen):
 *
 * - Innehållet: public.save_mystery_recipe (ägare, admin), en ny version från i dag.
 * - Packa: public.pack_mystery (ägare, admin, påfyllare), en transaktion, idempotent på id.
 * - Ångra: public.undo_mystery_packing inom 30 minuter.
 * - Inköpspriset: Inköprisers addPurchasePriceFor (från i dag, ägare och admin).
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { pgErrorOf } from "@/server/errors";

import { addPurchasePriceFor } from "../../../inkopspriser/_lib/data";
import { MAX_UNIT_COST_ORE } from "../../../inkopspriser/_lib/model";
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
