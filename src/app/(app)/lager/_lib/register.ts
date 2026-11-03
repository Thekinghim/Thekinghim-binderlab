/**
 * Registrering av påfyllning och inventering, bundet till en given användare (testbart
 * utan Next, se test/db/lager-data.test.ts). Server actions i ../actions.ts är tunna
 * omslag kring de här.
 *
 * Rollen kontrolleras mot databasen (ägare, admin, påfyllare) och allt skrivs som
 * användaren med RLS. Påfyllningen går genom public.register_refill, som drar samma antal
 * ur valt eget lager (annars automatens "Fylls på från", annars standardlagret) i samma
 * transaktion. Inventeringen är en 'count'-händelse.
 * Händelserna loggas i audit_log av triggarna på stock_events.
 */

import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { pgErrorOf } from "@/server/errors";
import type { Viewer } from "@/server/data/core/loaders";

import { REGISTER_ROLES } from "./data";
import type { CountInput, RefillInput, WasteInput } from "./schemas";

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
  /** Lagrets nya saldo för titeln (påfyllning från vårt lager, inköp), annars null. */
  readonly warehouseOnHand: number | null;
  /** Lagret som ändrades (påfyllning från vårt lager, inköp, inventering i ett lager). */
  readonly placeName?: string | null;
}

/**
 * Lagerplatsen: automatens, ett givet eget lager eller standardlagret (central). Ett
 * arkiverat lager räknas inte.
 */
export async function locationId(
  tx: Tx,
  orgId: string,
  where: { machineId: string } | { central: true } | { warehouseId: string },
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
          : "warehouseId" in where
            ? and(
                eq(s.stockLocations.id, where.warehouseId),
                eq(s.stockLocations.kind, "warehouse"),
              )
            : eq(s.stockLocations.isCentral, true),
      ),
    )
    .limit(1);
  return rows[0]?.id ?? null;
}

/** Lagrets namn (för bekräftelsen "12 pack kvar i Kontoret"). */
export async function locationName(tx: Tx, orgId: string, id: string): Promise<string | null> {
  const rows = await tx
    .select({ name: s.stockLocations.name })
    .from(s.stockLocations)
    .where(and(eq(s.stockLocations.organizationId, orgId), eq(s.stockLocations.id, id)))
    .limit(1);
  return rows[0]?.name ?? null;
}

/**
 * Lagret som en påfyllning i automaten dras ur när inget är valt: automatens "Fylls på
 * från" om det är ett aktivt eget lager, annars standardlagret (samma regel som
 * private.refill_source_for i databasen).
 */
export async function refillSourceFor(
  tx: Tx,
  orgId: string,
  machineId: string,
): Promise<string | null> {
  const result = await tx.execute(sql`
    select coalesce(
      (select w.id from public.stock_locations m
       join public.stock_locations w
         on w.organization_id = m.organization_id and w.id = m.refill_source_id
       where m.organization_id = ${orgId}::uuid and m.machine_id = ${machineId}::uuid
         and w.kind = 'warehouse' and w.archived_at is null
       limit 1),
      (select c.id from public.stock_locations c
       where c.organization_id = ${orgId}::uuid and c.is_central and c.archived_at is null
       limit 1)
    )::text as id`);
  const row = Array.from(result)[0] as { id: string | null } | undefined;
  return row?.id ?? null;
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
              ${input.note && input.note !== "" ? input.note : null}::text,
              ${input.fromLocationId ?? null}::uuid)`,
      );
    } catch (error) {
      rethrowKnown(error);
    }
    const location =
      machineLocation ?? (await locationId(tx, orgId, { machineId: input.machineId }));
    if (!location) throw new LagerError("Automaten saknar lagerplats.");
    const source = !input.fromWarehouse
      ? null
      : input.fromLocationId
        ? input.fromLocationId
        : await refillSourceFor(tx, orgId, input.machineId);
    return {
      previous,
      onHand: await level(tx, orgId, location, input.titleId),
      warehouseOnHand: source ? await level(tx, orgId, source, input.titleId) : null,
      placeName: source ? await locationName(tx, orgId, source) : null,
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
      input.location === "machine"
        ? { machineId: input.machineId }
        : input.warehouseId
          ? { warehouseId: input.warehouseId }
          : { central: true },
    );
    if (!location) {
      throw new LagerError(
        input.location === "machine"
          ? "Automaten saknar lagerplats."
          : input.warehouseId
            ? "Lagret finns inte."
            : "Organisationen har inget eget lager.",
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
      placeName: input.location === "warehouse" ? await locationName(tx, orgId, location) : null,
    };
  });
}

/**
 * Svinn i en automat: en 'waste'-händelse med negativt antal och orsaken som anteckning.
 * Kräver ett räknat saldo (en påfyllning eller inventering av titeln i automaten) och
 * får inte ta saldot under 0.
 */
export async function registerWasteFor(viewer: Viewer, input: WasteInput): Promise<RegisterResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, REGISTER_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    await assertTitle(tx, orgId, input.titleId);
    const location = await locationId(tx, orgId, { machineId: input.machineId });
    if (!location) throw new LagerError("Automaten saknar lagerplats.");
    const counted = await tx
      .select({ id: s.stockEvents.id })
      .from(s.stockEvents)
      .where(
        and(
          eq(s.stockEvents.organizationId, orgId),
          eq(s.stockEvents.locationId, location),
          eq(s.stockEvents.titleId, input.titleId),
          inArray(s.stockEvents.kind, ["refill", "count"]),
        ),
      )
      .limit(1);
    if (counted.length === 0) throw new LagerError(WASTE_NEEDS_COUNT);
    const previous = await level(tx, orgId, location, input.titleId);
    if (input.quantity > previous) {
      throw new LagerError(`Saldot är ${previous} pack. Inventera om det stämmer.`);
    }
    await tx.insert(s.stockEvents).values({
      organizationId: orgId,
      locationId: location,
      titleId: input.titleId,
      kind: "waste",
      quantity: -input.quantity,
      performedBy: viewer.user.userId,
      note: input.note,
    });
    return {
      previous,
      onHand: await level(tx, orgId, location, input.titleId),
      warehouseOnHand: null,
    };
  });
}

/** Felet när svinn registreras utan räknat saldo. */
export const WASTE_NEEDS_COUNT = "Inventera först. Svinn kräver ett räknat saldo.";
