/**
 * Inköp till vårt lager: en 'receipt'-händelse (positivt antal) i centrallagret. Bundet
 * till en given användare (testbart utan Next). Rollen kontrolleras mot databasen (ägare,
 * admin; RLS släpper bara igenom dem för 'receipt') och allt skrivs som användaren.
 * Händelsen loggas i audit_log av triggarna på stock_events.
 *
 * Antal hemma (inventering) går genom Lagers registerCountFor, samma som Prognos.
 */

import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

import * as s from "@/db/schema";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";

import { LagerError, registerCountFor, type RegisterResult } from "../../lager/_lib/register";
import { MAX_PACKS } from "../../lager/_lib/schemas";
import { EDIT_ROLES } from "./data";

const uuid = z
  .string({ error: "Ogiltigt id." })
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Ogiltigt id.");

const INVALID = "Ogiltig registrering. Ladda om sidan och försök igen.";

export const homeCountSchema = z.object(
  {
    titleId: uuid,
    counted: z
      .number({ error: "Ange antal, 0 eller mer." })
      .int("Ange ett heltal.")
      .min(0, "Ange antal, 0 eller mer.")
      .max(MAX_PACKS, `Högst ${MAX_PACKS} pack.`),
  },
  { error: INVALID },
);

export const receiptSchema = z.object(
  {
    titleId: uuid,
    quantity: z
      .number({ error: "Ange antal pack, minst 1." })
      .int("Ange ett heltal.")
      .min(1, "Ange antal pack, minst 1.")
      .max(MAX_PACKS, `Högst ${MAX_PACKS} pack.`),
  },
  { error: INVALID },
);

export type HomeCountInput = z.infer<typeof homeCountSchema>;
export type ReceiptInput = z.infer<typeof receiptSchema>;

/** Antal hemma: en inventering i centrallagret (ägare, admin). */
export async function setHomeCountFor(
  viewer: Viewer,
  input: HomeCountInput,
): Promise<RegisterResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  return registerCountFor(viewer, {
    location: "warehouse",
    titleId: input.titleId,
    counted: input.counted,
    note: "Inventering, Vårt lager",
  });
}

/** Inköp: packen kom hem (ägare, admin). */
export async function registerReceiptFor(
  viewer: Viewer,
  input: ReceiptInput,
): Promise<RegisterResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    const [title] = await tx
      .select({ id: s.titles.id })
      .from(s.titles)
      .where(
        and(
          eq(s.titles.organizationId, orgId),
          eq(s.titles.id, input.titleId),
          isNull(s.titles.mergedIntoId),
          isNull(s.titles.archivedAt),
        ),
      )
      .limit(1);
    if (!title) throw new LagerError("Titeln finns inte i organisationen.");
    const [central] = await tx
      .select({ id: s.stockLocations.id })
      .from(s.stockLocations)
      .where(
        and(
          eq(s.stockLocations.organizationId, orgId),
          eq(s.stockLocations.isCentral, true),
          isNull(s.stockLocations.archivedAt),
        ),
      )
      .limit(1);
    if (!central) throw new LagerError("Organisationen har inget eget lager.");
    const level = async () =>
      (
        await tx
          .select({ q: s.stockLevels.quantity })
          .from(s.stockLevels)
          .where(
            and(
              eq(s.stockLevels.organizationId, orgId),
              eq(s.stockLevels.locationId, central.id),
              eq(s.stockLevels.titleId, input.titleId),
            ),
          )
      )[0]?.q ?? 0;
    const previous = await level();
    await tx.insert(s.stockEvents).values({
      organizationId: orgId,
      locationId: central.id,
      titleId: input.titleId,
      kind: "receipt",
      quantity: input.quantity,
      performedBy: viewer.user.userId,
      note: "Inköp, Vårt lager",
    });
    return { previous, onHand: await level(), warehouseOnHand: null };
  });
}
