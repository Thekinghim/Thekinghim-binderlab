/**
 * Butiksägare på servern: bolagen som äger butikerna. Samma mönster som ./service:
 * rollen kontrolleras mot databasen först (requireRoleFor), sedan läses och skrivs allt
 * som användaren med RLS (withUserDbFor). Läsning: ägare, admin och läsare. Ändring:
 * ägare och admin. Triggarna loggar ändringarna i audit_log; ägare raderas aldrig, de
 * arkiveras. Testas i test/db/butiksagare.test.ts.
 */

import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { ActionResult } from "@/server/auth/flows";
import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

import {
  OWNER_MESSAGES,
  archiveOwnerSchema,
  newOwnerSchema,
  storeOwnerSchema,
  updateOwnerSchema,
  type OwnerInput,
} from "./owner-validation";
import { firstIssue } from "./validation";

/** En butiksägare med butikerna den äger. */
export interface OwnerView {
  readonly id: string;
  readonly legalName: string;
  readonly orgNumber: string;
  readonly vatNumber: string | null;
  readonly fTax: boolean;
  readonly streetAddress: string | null;
  readonly postalCode: string | null;
  readonly city: string | null;
  readonly contactName: string | null;
  readonly email: string | null;
  readonly phone: string | null;
  readonly invoiceEmail: string | null;
  readonly bankgiro: string | null;
  readonly note: string | null;
  readonly archived: boolean;
  /** Butikerna med den här ägaren, aktiva först, sedan namn. */
  readonly stores: ReadonlyArray<{ id: string; name: string; archived: boolean }>;
}

// ---------------------------------------------------------------------------
// Läsning (ägare, admin, läsare)
// ---------------------------------------------------------------------------

/** Alla butiksägare, även arkiverade, med sina butiker. Namnordning. */
export async function loadOwnersFor(viewer: Viewer): Promise<OwnerView[]> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const [owners, stores] = await Promise.all([
      tx
        .select()
        .from(s.storeOwners)
        .where(eq(s.storeOwners.organizationId, orgId))
        .orderBy(asc(s.storeOwners.legalName), asc(s.storeOwners.id)),
      tx
        .select({
          id: s.stores.id,
          name: s.stores.name,
          ownerId: s.stores.ownerId,
          archivedAt: s.stores.archivedAt,
        })
        .from(s.stores)
        .where(eq(s.stores.organizationId, orgId))
        .orderBy(asc(s.stores.name), asc(s.stores.id)),
    ]);
    return owners.map((o) => ({
      id: o.id,
      legalName: o.legalName,
      orgNumber: o.orgNumber,
      vatNumber: o.vatNumber,
      fTax: o.fTax,
      streetAddress: o.streetAddress,
      postalCode: o.postalCode,
      city: o.city,
      contactName: o.contactName,
      email: o.email,
      phone: o.phone,
      invoiceEmail: o.invoiceEmail,
      bankgiro: o.bankgiro,
      note: o.note,
      archived: o.archivedAt !== null,
      stores: stores
        .filter((st) => st.ownerId === o.id)
        .map((st) => ({ id: st.id, name: st.name, archived: st.archivedAt !== null }))
        .sort((a, b) => Number(a.archived) - Number(b.archived)),
    }));
  });
}

// ---------------------------------------------------------------------------
// Ändringar (ägare och admin)
// ---------------------------------------------------------------------------

async function guard(viewer: Viewer): Promise<{ ok: false; error: string } | null> {
  try {
    await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
    return null;
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: OWNER_MESSAGES.forbidden };
    throw error;
  }
}

function fail(error: unknown, context: string): { ok: false; error: string } {
  const pg = pgErrorOf(error);
  if (pg?.code === "23505" && /store_owners_org_number_key/.test(pg.message)) {
    return { ok: false, error: OWNER_MESSAGES.duplicate };
  }
  if (!pg || !/^BL0\d\d$/.test(pg.code)) console.error(`[butiksägare] ${context}`, error);
  return { ok: false, error: dbErrorMessage(error) };
}

function columns(v: OwnerInput) {
  return {
    legalName: v.legalName,
    orgNumber: v.orgNumber,
    vatNumber: v.vatNumber,
    fTax: v.fTax,
    streetAddress: v.streetAddress,
    postalCode: v.postalCode,
    city: v.city,
    contactName: v.contactName,
    email: v.email,
    phone: v.phone,
    invoiceEmail: v.invoiceEmail,
    bankgiro: v.bankgiro,
    note: v.note,
  };
}

async function ownerState(
  tx: Tx,
  orgId: string,
  ownerId: string,
): Promise<{ archived: boolean } | null> {
  const [row] = await tx
    .select({ archivedAt: s.storeOwners.archivedAt })
    .from(s.storeOwners)
    .where(and(eq(s.storeOwners.organizationId, orgId), eq(s.storeOwners.id, ownerId)));
  return row ? { archived: row.archivedAt !== null } : null;
}

/** Sätter butikens ägare; felet om butiken inte finns eller är arkiverad, annars null. */
async function linkStore(
  tx: Tx,
  orgId: string,
  storeId: string,
  ownerId: string | null,
): Promise<string | null> {
  const [store] = await tx
    .select({ archivedAt: s.stores.archivedAt })
    .from(s.stores)
    .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, storeId)));
  if (!store) return OWNER_MESSAGES.storeNotFound;
  if (store.archivedAt !== null) return "Butiken är arkiverad. Återställ den först.";
  await tx
    .update(s.stores)
    .set({ ownerId })
    .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, storeId)));
  return null;
}

/**
 * Ny butiksägare. Med `storeId` blir den också butikens ägare i samma transaktion
 * ("Ny ägare" på butikens sida).
 */
export async function createOwnerFor(
  viewer: Viewer,
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = newOwnerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { storeId, ...fields } = parsed.data;
  const orgId = viewer.organization.id;
  try {
    return await withUserDbFor(viewer.user, async (tx): Promise<ActionResult<{ id: string }>> => {
      const [row] = await tx
        .insert(s.storeOwners)
        .values({ organizationId: orgId, ...columns(fields) })
        .returning({ id: s.storeOwners.id });
      const id = row!.id;
      if (storeId) {
        const problem = await linkStore(tx, orgId, storeId, id);
        // Butiken gick inte att koppla: ingen ny ägare heller (transaktionen rullas tillbaka).
        if (problem) throw new LinkError(problem);
      }
      return { ok: true, data: { id } };
    });
  } catch (error) {
    if (error instanceof LinkError) return { ok: false, error: error.message };
    return fail(error, "createOwner");
  }
}

class LinkError extends Error {}

/** Ändrar en butiksägares uppgifter. Arkiverade ägare ändras inte. */
export async function updateOwnerFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = updateOwnerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { ownerId, ...v } = parsed.data;
  const orgId = viewer.organization.id;
  try {
    return await withUserDbFor(viewer.user, async (tx): Promise<ActionResult> => {
      const state = await ownerState(tx, orgId, ownerId);
      if (!state) return { ok: false, error: OWNER_MESSAGES.notFound };
      if (state.archived) return { ok: false, error: OWNER_MESSAGES.archived };
      await tx
        .update(s.storeOwners)
        .set(columns(v))
        .where(and(eq(s.storeOwners.organizationId, orgId), eq(s.storeOwners.id, ownerId)));
      return { ok: true, data: undefined };
    });
  } catch (error) {
    return fail(error, "updateOwner");
  }
}

/**
 * Arkiverar eller återställer en butiksägare. En ägare med aktiva butiker arkiveras
 * inte: ta bort butikerna från ägaren först. Arkiverade butiker behåller sin ägare.
 */
export async function setOwnerArchivedFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = archiveOwnerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { ownerId, archived } = parsed.data;
  const orgId = viewer.organization.id;
  try {
    return await withUserDbFor(viewer.user, async (tx): Promise<ActionResult> => {
      if (!(await ownerState(tx, orgId, ownerId))) {
        return { ok: false, error: OWNER_MESSAGES.notFound };
      }
      if (archived) {
        const active = await tx
          .select({ name: s.stores.name })
          .from(s.stores)
          .where(
            and(
              eq(s.stores.organizationId, orgId),
              eq(s.stores.ownerId, ownerId),
              isNull(s.stores.archivedAt),
            ),
          )
          .orderBy(asc(s.stores.name));
        if (active.length > 0) {
          const names = active.map((r) => r.name).join(", ");
          return {
            ok: false,
            error: `${names} har den här ägaren. Välj en annan ägare för ${active.length === 1 ? "butiken" : "butikerna"} först.`,
          };
        }
      }
      await tx
        .update(s.storeOwners)
        .set({ archivedAt: archived ? sql`now()` : null })
        .where(and(eq(s.storeOwners.organizationId, orgId), eq(s.storeOwners.id, ownerId)));
      return { ok: true, data: undefined };
    });
  } catch (error) {
    return fail(error, "setOwnerArchived");
  }
}

/** Väljer butikens ägare (null = ingen). Ägaren måste finnas och vara aktiv. */
export async function setStoreOwnerFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = storeOwnerSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { storeId, ownerId } = parsed.data;
  const orgId = viewer.organization.id;
  try {
    return await withUserDbFor(viewer.user, async (tx): Promise<ActionResult> => {
      if (ownerId) {
        const state = await ownerState(tx, orgId, ownerId);
        if (!state) return { ok: false, error: OWNER_MESSAGES.notFound };
        if (state.archived) return { ok: false, error: OWNER_MESSAGES.archived };
      }
      const problem = await linkStore(tx, orgId, storeId, ownerId);
      return problem ? { ok: false, error: problem } : { ok: true, data: undefined };
    });
  } catch (error) {
    return fail(error, "setStoreOwner");
  }
}
