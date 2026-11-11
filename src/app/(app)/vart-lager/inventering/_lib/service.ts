/**
 * Spara en inventering av ett eget lager, bundet till en given användare (testbart utan
 * Next, se test/db/inventering.test.ts).
 *
 * Samma regler som "Rätta antalet" på Vårt lager (setHomeCountFor): ägare och admin, ett
 * aktivt eget lager, aktiva titlar och 0–10 000 pack. Skillnaden är att alla räknade
 * titlar sparas i EN transaktion (public.save_stock_count): en 'count'-händelse per titel
 * med noteringen "Inventering, Hemma" och en rad i stock_counts. Rollen kontrolleras här
 * och i databasen, och allt skrivs som användaren. Idempotent på clientId.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { requireRoleFor, withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { pgErrorOf } from "@/server/errors";

import { LagerError } from "../../../lager/_lib/register";
import { MAX_PACKS } from "../../../lager/_lib/schemas";
import { EDIT_ROLES } from "../../_lib/data";
import { MAX_COUNT_LINES, type CountLine } from "./model";

const uuid = z
  .string({ error: "Ogiltigt id." })
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Ogiltigt id.");

const INVALID = "Ogiltig registrering. Ladda om sidan och försök igen.";

export const stockCountSchema = z.object(
  {
    /** Inskickets id (från utkastet): samma id sparas bara en gång. */
    clientId: uuid,
    /** Lagret som räknades. */
    placeId: uuid,
    lines: z
      .array(
        z.object(
          {
            titleId: uuid,
            counted: z
              .number({ error: "Ange antal, 0 eller mer." })
              .int("Ange ett heltal.")
              .min(0, "Ange antal, 0 eller mer.")
              .max(MAX_PACKS, `Högst ${MAX_PACKS} pack.`),
          },
          { error: INVALID },
        ),
        { error: INVALID },
      )
      .min(1, "Räkna minst en produkt.")
      .max(MAX_COUNT_LINES, `Högst ${MAX_COUNT_LINES} produkter per inventering.`)
      .refine((lines) => new Set(lines.map((l) => l.titleId)).size === lines.length, {
        message: "Samma produkt står två gånger.",
      }),
  },
  { error: INVALID },
);

export type StockCountInput = z.infer<typeof stockCountSchema>;

export interface StockCountResult {
  readonly countId: string;
  /** Inskicket var redan sparat (dubbeltryck eller nytt försök): inget sparades igen. */
  readonly duplicate: boolean;
  readonly countedAt: string;
  /** Det som sparades: vad appen trodde och vad som räknades, per titel. */
  readonly lines: readonly CountLine[];
}

/** Spara inventeringen (ägare, admin). Titlar som inte är med ändras inte. */
export async function saveStockCountFor(
  viewer: Viewer,
  input: StockCountInput,
): Promise<StockCountResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  const orgId = viewer.organization.id;
  const lines = input.lines.map((l) => ({ titleId: l.titleId, counted: l.counted }));
  return withUserDbFor(viewer.user, async (tx) => {
    try {
      const result = await tx.execute(
        sql`select count_id::text, duplicate, counted_at, lines
            from public.save_stock_count(${orgId}::uuid, ${input.clientId}::uuid,
              ${input.placeId}::uuid, ${JSON.stringify(lines)}::jsonb)`,
      );
      const row = Array.from(result)[0] as {
        count_id: string;
        duplicate: boolean;
        counted_at: Date | string;
        lines: { titleId: string; name: string; previous: number; counted: number }[] | string;
      };
      const saved = typeof row.lines === "string" ? JSON.parse(row.lines) : row.lines;
      return {
        countId: row.count_id,
        duplicate: row.duplicate,
        countedAt: new Date(row.counted_at).toISOString(),
        lines: (
          saved as { titleId: string; name: string; previous: number; counted: number }[]
        ).map((l) => ({
          titleId: l.titleId,
          name: l.name,
          previous: Number(l.previous),
          counted: Number(l.counted),
        })),
      };
    } catch (error) {
      // Felen från save_stock_count (22023) har svenska meddelanden; övriga blir allmänna.
      const pg = pgErrorOf(error);
      if (pg?.code === "22023" && pg.message) throw new LagerError(pg.message);
      throw error;
    }
  });
}
