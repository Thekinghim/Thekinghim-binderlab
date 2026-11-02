/**
 * Butiker på servern: frågor och ändringar bundna till en verifierad användare och
 * organisation (Viewer). Sidorna och server actions anropar dem med sessionens
 * användare; testerna (test/db/butiker-service.test.ts) direkt.
 *
 * Varje funktion kontrollerar rollen mot databasen först (requireRoleFor) och läser
 * och skriver sedan som användaren med RLS (withUserDbFor). Läsning: ägare, admin och
 * läsare (avtal och mottagare är ekonomi, påfyllaren får dem aldrig). Ändring: ägare och
 * admin. Ändringarna loggas i audit_log av triggarna på stores, store_agreements och
 * report_recipients.
 */

import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { isIsoDate, type IsoDate } from "@/domain";
import type { ActionResult } from "@/server/auth/flows";
import { AuthorizationError, isUuid, requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

import { dayText, type AgreementRecord } from "./model";
import type { RecipientView, StoreDetail } from "./types";
import {
  archiveStoreSchema,
  checkAgreementEnd,
  firstIssue,
  newAgreementSchema,
  planNewAgreement,
  recipientIdSchema,
  recipientSchema,
  storeSchema,
  updateAgreementSchema,
  updateRecipientSchema,
  updateStoreSchema,
  type AgreementSpan,
} from "./validation";

export type { Viewer };

type Row = Record<string, unknown>;

async function query<T extends Row>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

function isoDateOrNull(value: unknown): IsoDate | null {
  const v = value === null || value === undefined ? null : String(value);
  return v !== null && isIsoDate(v) ? v : null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

// ---------------------------------------------------------------------------
// Läsning (ägare, admin, läsare)
// ---------------------------------------------------------------------------

/** Alla butiker i organisationen med kontaktuppgifter, även arkiverade. */
export async function loadStoresFor(viewer: Viewer): Promise<StoreDetail[]> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = await tx
      .select({
        id: s.stores.id,
        name: s.stores.name,
        address: s.stores.address,
        city: s.stores.city,
        contactName: s.stores.contactName,
        email: s.stores.email,
        phone: s.stores.phone,
        isExample: s.stores.isExample,
        archivedAt: s.stores.archivedAt,
      })
      .from(s.stores)
      .where(eq(s.stores.organizationId, orgId))
      .orderBy(asc(s.stores.name));
    return rows.map(({ archivedAt, ...r }) => ({ ...r, archived: archivedAt !== null }));
  });
}

/** Alla avtal (store_agreements), äldst först. */
export async function loadAgreementsFor(viewer: Viewer): Promise<AgreementRecord[]> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = await tx
      .select({
        id: s.storeAgreements.id,
        storeId: s.storeAgreements.storeId,
        contractId: s.storeAgreements.contractId,
        validFrom: s.storeAgreements.validFrom,
        validTo: s.storeAgreements.validTo,
        commissionBp: s.storeAgreements.commissionBp,
        monthlyRentOre: s.storeAgreements.monthlyRentOre,
        note: s.storeAgreements.note,
      })
      .from(s.storeAgreements)
      .where(eq(s.storeAgreements.organizationId, orgId))
      .orderBy(asc(s.storeAgreements.storeId), asc(s.storeAgreements.validFrom));
    return rows.map((r) => ({
      ...r,
      commissionBp: r.commissionBp ?? null,
      monthlyRentOre: r.monthlyRentOre === null ? null : Number(r.monthlyRentOre),
    }));
  });
}

/** Butikens rapportmottagare (kind = store) med senaste lyckade utskick. */
export async function loadRecipientsFor(
  viewer: Viewer,
  storeId: string,
): Promise<RecipientView[]> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  if (!isUuid(storeId)) return [];
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = await query<{
      id: string;
      name: string;
      email: string;
      active: boolean;
      last_sent: unknown;
    }>(
      tx,
      sql`select r.id, r.name, r.email::text as email, r.active,
                 (select max(coalesce(d.sent_at, d.created_at))
                    from public.report_deliveries d
                   where d.organization_id = r.organization_id and d.recipient_id = r.id
                     and d.status in ('sent', 'delivered')) as last_sent
          from public.report_recipients r
          where r.organization_id = ${orgId}::uuid and r.store_id = ${storeId}::uuid
            and r.kind = 'store'
          order by r.active desc, r.name`,
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      active: Boolean(r.active),
      lastSentAt: iso(r.last_sent),
    }));
  });
}

// ---------------------------------------------------------------------------
// Ändringar (ägare och admin)
// ---------------------------------------------------------------------------

async function guard(viewer: Viewer): Promise<ActionResult<never> | null> {
  try {
    await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
    return null;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { ok: false, error: "Bara ägare och admin kan ändra butiker." };
    }
    throw error;
  }
}

function fail(error: unknown, context: string): { ok: false; error: string } {
  const pg = pgErrorOf(error);
  if (pg?.code === "23P01") {
    return { ok: false, error: "Avtalet skulle överlappa ett annat avtal för butiken." };
  }
  if (pg?.code === "23514" && /terms_check/.test(pg.message)) {
    return { ok: false, error: "Ange provision, hyra eller båda." };
  }
  if (!pg || !/^BL0\d\d$/.test(pg.code)) console.error(`[butiker] ${context}`, error);
  return { ok: false, error: dbErrorMessage(error) };
}

async function storeExists(tx: Tx, orgId: string, storeId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: s.stores.id })
    .from(s.stores)
    .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, storeId)));
  return rows.length > 0;
}

/** Lägger till en butik. */
export async function createStoreFor(
  viewer: Viewer,
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = storeSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const v = parsed.data;
  try {
    const id = await withUserDbFor(viewer.user, async (tx) => {
      const [row] = await tx
        .insert(s.stores)
        .values({
          organizationId: viewer.organization.id,
          name: v.name,
          address: v.address,
          city: v.city,
          contactName: v.contactName,
          email: v.email,
          phone: v.phone,
          isExample: v.isExample,
        })
        .returning({ id: s.stores.id });
      return row!.id;
    });
    return { ok: true, data: { id } };
  } catch (error) {
    return fail(error, "createStore");
  }
}

/** Ändrar namn, adress, kontaktuppgifter och exempelmarkering. */
export async function updateStoreFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = updateStoreSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const v = parsed.data;
  try {
    const n = await withUserDbFor(viewer.user, async (tx) => {
      const rows = await tx
        .update(s.stores)
        .set({
          name: v.name,
          address: v.address,
          city: v.city,
          contactName: v.contactName,
          email: v.email,
          phone: v.phone,
          isExample: v.isExample,
        })
        .where(and(eq(s.stores.organizationId, viewer.organization.id), eq(s.stores.id, v.storeId)))
        .returning({ id: s.stores.id });
      return rows.length;
    });
    if (n === 0) return { ok: false, error: "Butiken finns inte." };
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error, "updateStore");
  }
}

/**
 * Arkiverar eller återställer en butik. En butik med en automat som står där i dag
 * eller senare kan inte arkiveras: flytta automaten först.
 */
export async function setStoreArchivedFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = archiveStoreSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const { storeId, archived } = parsed.data;
  const orgId = viewer.organization.id;
  try {
    return await withUserDbFor(viewer.user, async (tx): Promise<ActionResult> => {
      if (!(await storeExists(tx, orgId, storeId))) {
        return { ok: false, error: "Butiken finns inte." };
      }
      if (archived) {
        const today = businessToday(new Date(), viewer.organization.timezone);
        const placed = await query<{ code: string }>(
          tx,
          sql`select m.code from public.machine_placements p
              join public.machines m on m.organization_id = p.organization_id and m.id = p.machine_id
              where p.organization_id = ${orgId}::uuid and p.store_id = ${storeId}::uuid
                and (p.valid_to is null or p.valid_to >= ${today}::date)
              order by m.code`,
        );
        if (placed.length > 0) {
          const codes = placed.map((p) => p.code).join(", ");
          return {
            ok: false,
            error: `${codes} står i butiken. Flytta ${placed.length === 1 ? "automaten" : "automaterna"} innan butiken arkiveras.`,
          };
        }
      }
      await tx
        .update(s.stores)
        .set({ archivedAt: archived ? sql`now()` : null })
        .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, storeId)));
      return { ok: true, data: undefined };
    });
  } catch (error) {
    return fail(error, "setStoreArchived");
  }
}

async function lockStoreAgreements(
  tx: Tx,
  orgId: string,
  storeId: string,
): Promise<AgreementSpan[]> {
  // Låser butiksraden så att två samtidiga avtalsändringar för samma butik köas.
  await tx.execute(
    sql`select 1 from public.stores where organization_id = ${orgId}::uuid and id = ${storeId}::uuid for update`,
  );
  const rows = await query<{ id: string; valid_from: unknown; valid_to: unknown }>(
    tx,
    sql`select id, valid_from::text as valid_from, valid_to::text as valid_to
        from public.store_agreements
        where organization_id = ${orgId}::uuid and store_id = ${storeId}::uuid
        order by valid_from`,
  );
  return rows.map((r) => ({
    id: r.id,
    validFrom: isoDateOrNull(r.valid_from) ?? "0001-01-01",
    validTo: isoDateOrNull(r.valid_to),
  }));
}

/**
 * Nytt avtal från och med ett datum. Ett avtal som gäller dagen före avslutas dagen före
 * i samma transaktion, så att historiken behålls och inga perioder överlappar.
 */
export async function createAgreementFor(
  viewer: Viewer,
  raw: unknown,
  today?: IsoDate,
): Promise<ActionResult<{ id: string; closedId: string | null }>> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = newAgreementSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const v = parsed.data;
  const orgId = viewer.organization.id;
  try {
    return await withUserDbFor(
      viewer.user,
      async (tx): Promise<ActionResult<{ id: string; closedId: string | null }>> => {
        if (!(await storeExists(tx, orgId, v.storeId))) {
          return { ok: false, error: "Butiken finns inte." };
        }
        const ref = today ?? businessToday(new Date(), viewer.organization.timezone);
        const existing = await lockStoreAgreements(tx, orgId, v.storeId);
        const plan = planNewAgreement(existing, v.validFrom, v.validTo, (d) => dayText(d, ref));
        if (!plan.ok) return { ok: false, error: plan.message };
        if (plan.close) {
          await tx
            .update(s.storeAgreements)
            .set({ validTo: plan.close.validTo })
            .where(
              and(
                eq(s.storeAgreements.organizationId, orgId),
                eq(s.storeAgreements.id, plan.close.id),
              ),
            );
        }
        const [row] = await tx
          .insert(s.storeAgreements)
          .values({
            organizationId: orgId,
            storeId: v.storeId,
            validFrom: v.validFrom,
            validTo: v.validTo,
            commissionBp: v.commissionBp,
            monthlyRentOre: v.monthlyRentOre,
            note: v.note,
          })
          .returning({ id: s.storeAgreements.id });
        return { ok: true, data: { id: row!.id, closedId: plan.close?.id ?? null } };
      },
    );
  } catch (error) {
    return fail(error, "createAgreement");
  }
}

/**
 * Rättar ett avtal: provision, hyra, anteckning och sista dag. Startdagen ändras inte
 * (ett nytt villkor från ett datum är ett nytt avtal). Stängda månader skyddas av databasen.
 */
export async function updateAgreementFor(
  viewer: Viewer,
  raw: unknown,
  today?: IsoDate,
): Promise<ActionResult<{ storeId: string }>> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = updateAgreementSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const v = parsed.data;
  const orgId = viewer.organization.id;
  try {
    return await withUserDbFor(
      viewer.user,
      async (tx): Promise<ActionResult<{ storeId: string }>> => {
        const [a] = await tx
          .select({ storeId: s.storeAgreements.storeId })
          .from(s.storeAgreements)
          .where(
            and(
              eq(s.storeAgreements.organizationId, orgId),
              eq(s.storeAgreements.id, v.agreementId),
            ),
          );
        if (!a) return { ok: false, error: "Avtalet finns inte." };
        const ref = today ?? businessToday(new Date(), viewer.organization.timezone);
        const existing = await lockStoreAgreements(tx, orgId, a.storeId);
        const problem = checkAgreementEnd(existing, v.agreementId, v.validTo, (d) =>
          dayText(d, ref),
        );
        if (problem) return { ok: false, error: problem };
        await tx
          .update(s.storeAgreements)
          .set({
            validTo: v.validTo,
            commissionBp: v.commissionBp,
            monthlyRentOre: v.monthlyRentOre,
            note: v.note,
          })
          .where(
            and(
              eq(s.storeAgreements.organizationId, orgId),
              eq(s.storeAgreements.id, v.agreementId),
            ),
          );
        return { ok: true, data: { storeId: a.storeId } };
      },
    );
  } catch (error) {
    return fail(error, "updateAgreement");
  }
}

/** Lägger till en rapportmottagare för butiken (kind = store). */
export async function createStoreRecipientFor(
  viewer: Viewer,
  raw: unknown,
): Promise<ActionResult<{ id: string }>> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = recipientSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const v = parsed.data;
  const orgId = viewer.organization.id;
  try {
    return await withUserDbFor(viewer.user, async (tx): Promise<ActionResult<{ id: string }>> => {
      if (!(await storeExists(tx, orgId, v.storeId))) {
        return { ok: false, error: "Butiken finns inte." };
      }
      const dup = await query<{ id: string }>(
        tx,
        sql`select id from public.report_recipients
            where organization_id = ${orgId}::uuid and store_id = ${v.storeId}::uuid
              and kind = 'store' and email = ${v.email}::citext`,
      );
      if (dup.length > 0) {
        return { ok: false, error: `${v.email} tar redan emot butikens rapport.` };
      }
      const [row] = await tx
        .insert(s.reportRecipients)
        .values({
          organizationId: orgId,
          name: v.name,
          email: v.email,
          kind: "store",
          storeId: v.storeId,
          active: true,
        })
        .returning({ id: s.reportRecipients.id });
      return { ok: true, data: { id: row!.id } };
    });
  } catch (error) {
    return fail(error, "createRecipient");
  }
}

/** Ändrar namn och adress, eller pausar och återaktiverar en butiksmottagare. */
export async function updateStoreRecipientFor(
  viewer: Viewer,
  raw: unknown,
): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = updateRecipientSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const v = parsed.data;
  const orgId = viewer.organization.id;
  try {
    const n = await withUserDbFor(viewer.user, async (tx) => {
      const rows = await tx
        .update(s.reportRecipients)
        .set({ name: v.name, email: v.email, active: v.active })
        .where(
          and(
            eq(s.reportRecipients.organizationId, orgId),
            eq(s.reportRecipients.id, v.recipientId),
            eq(s.reportRecipients.kind, "store"),
          ),
        )
        .returning({ id: s.reportRecipients.id });
      return rows.length;
    });
    if (n === 0) return { ok: false, error: "Mottagaren finns inte." };
    return { ok: true, data: undefined };
  } catch (error) {
    return fail(error, "updateRecipient");
  }
}

/**
 * Tar bort en butiksmottagare. En mottagare som redan fått rapporter finns kvar i
 * utskickshistoriken och kan bara pausas.
 */
export async function deleteStoreRecipientFor(
  viewer: Viewer,
  raw: unknown,
): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = recipientIdSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const orgId = viewer.organization.id;
  const id = parsed.data.recipientId;
  try {
    return await withUserDbFor(viewer.user, async (tx): Promise<ActionResult> => {
      const sent = await query<{ n: unknown }>(
        tx,
        sql`select count(*) as n from public.report_deliveries
            where organization_id = ${orgId}::uuid and recipient_id = ${id}::uuid`,
      );
      if (Number(sent[0]?.n ?? 0) > 0) {
        return {
          ok: false,
          error: "Mottagaren har fått rapporter och finns kvar i historiken. Pausa den i stället.",
        };
      }
      const rows = await tx
        .delete(s.reportRecipients)
        .where(
          and(
            eq(s.reportRecipients.organizationId, orgId),
            eq(s.reportRecipients.id, id),
            eq(s.reportRecipients.kind, "store"),
          ),
        )
        .returning({ id: s.reportRecipients.id });
      if (rows.length === 0) return { ok: false, error: "Mottagaren finns inte." };
      return { ok: true, data: undefined };
    });
  } catch (error) {
    return fail(error, "deleteRecipient");
  }
}
