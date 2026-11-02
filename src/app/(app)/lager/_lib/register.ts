/**
 * Registrering av påfyllning och inventering, bundet till en given användare (testbart
 * utan Next, se test/db/lager-data.test.ts). Server actions i ../actions.ts är tunna
 * omslag kring de här.
 *
 * Rollen kontrolleras mot databasen (ägare, admin, påfyllare) och allt skrivs som
 * användaren med RLS. Påfyllningen går genom public.register_refill, som drar samma antal
 * ur centrallagret i samma transaktion. Inventeringen är en 'count'-händelse.
 * Händelserna loggas i audit_log av triggarna på stock_events.
 */

import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { pgErrorOf } from "@/server/errors";
import type { Viewer } from "@/server/data/core/loaders";

import { REGISTER_ROLES } from "./data";
import type { CountInput, RefillInput } from "./schemas";

/** Fel med ett svenskt meddelande som kan visas för användaren. */
export class LagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LagerError";
  }
}

export interface RegisterResult {
  /** Saldot före registreringen. */
  readonly previous: number;
  /** Nytt saldo på platsen. */
  readonly onHand: number;
  /** Centrallagrets nya saldo för titeln (påfyllning från centrallagret), annars null. */
  readonly warehouseOnHand: number | null;
}

async function locationId(
  tx: Tx,
  orgId: string,
  where: { machineId: string } | { central: true },
): Promise<string | null> {
  const rows = await tx
    .select({ id: s.stockLocations.id })
    .from(s.stockLocations)
    .where(
      and(
        eq(s.stockLocations.organizationId, orgId),
        isNull(s.stockLocations.archivedAt),
        "machineId" in where
          ? eq(s.stockLocations.machineId, where.machineId)
          : eq(s.stockLocations.isCentral, true),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

async function level(tx: Tx, orgId: string, location: string, titleId: string): Promise<number> {
  const rows = await tx
    .select({ quantity: s.stockLevels.quantity })
    .from(s.stockLevels)
    .where(
      and(
        eq(s.stockLevels.organizationId, orgId),
        eq(s.stockLevels.locationId, location),
        eq(s.stockLevels.titleId, titleId),
      ),
    );
  return rows[0]?.quantity ?? 0;
}

async function assertTitle(tx: Tx, orgId: string, titleId: string): Promise<void> {
  const rows = await tx
    .select({ id: s.titles.id })
    .from(s.titles)
    .where(
      and(
        eq(s.titles.organizationId, orgId),
        eq(s.titles.id, titleId),
        isNull(s.titles.mergedIntoId),
        isNull(s.titles.archivedAt),
      ),
    )
    .limit(1);
  if (rows.length === 0) throw new LagerError("Titeln finns inte i organisationen.");
}

/** Felen från register_refill (22023) har svenska meddelanden; övriga blir allmänna. */
function rethrowKnown(error: unknown): never {
  const pg = pgErrorOf(error);
  if (pg?.code === "22023" && pg.message) throw new LagerError(pg.message);
  throw error;
}

/** Påfyllning i en automat, från centrallagret eller inte. */
export async function registerRefillFor(
  viewer: Viewer,
  input: RefillInput,
): Promise<RegisterResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, REGISTER_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    await assertTitle(tx, orgId, input.titleId);
    const machineLocation = await locationId(tx, orgId, { machineId: input.machineId });
    const previous = machineLocation ? await level(tx, orgId, machineLocation, input.titleId) : 0;
    try {
      await tx.execute(
        sql`select public.register_refill(
              ${orgId}::uuid, ${input.machineId}::uuid, ${input.titleId}::uuid,
              ${input.quantity}::integer, ${input.fromWarehouse}::boolean, null,
              ${input.note && input.note !== "" ? input.note : null}::text)`,
      );
    } catch (error) {
      rethrowKnown(error);
    }
    const location =
      machineLocation ?? (await locationId(tx, orgId, { machineId: input.machineId }));
    if (!location) throw new LagerError("Automaten saknar lagerplats.");
    const central = input.fromWarehouse ? await locationId(tx, orgId, { central: true }) : null;
    return {
      previous,
      onHand: await level(tx, orgId, location, input.titleId),
      warehouseOnHand: central ? await level(tx, orgId, central, input.titleId) : null,
    };
  });
}

/** Inventering: räknat antal i en automat eller i centrallagret. */
export async function registerCountFor(viewer: Viewer, input: CountInput): Promise<RegisterResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, REGISTER_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    await assertTitle(tx, orgId, input.titleId);
    const location = await locationId(
      tx,
      orgId,
      input.location === "machine" ? { machineId: input.machineId } : { central: true },
    );
    if (!location) {
      throw new LagerError(
        input.location === "machine"
          ? "Automaten saknar lagerplats."
          : "Organisationen har inget centrallager.",
      );
    }
    const previous = await level(tx, orgId, location, input.titleId);
    await tx.insert(s.stockEvents).values({
      organizationId: orgId,
      locationId: location,
      titleId: input.titleId,
      kind: "count",
      quantity: input.counted,
      performedBy: viewer.user.userId,
      note: input.note && input.note !== "" ? input.note : "Inventering",
    });
    return {
      previous,
      onHand: await level(tx, orgId, location, input.titleId),
      warehouseOnHand: null,
    };
  });
}
