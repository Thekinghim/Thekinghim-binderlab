/**
 * Automater på servern: frågor och ändringar bundna till en verifierad användare och
 * organisation (Viewer). Sidorna och server actions anropar dem med sessionens
 * användare; testerna (test/db/automater-service.test.ts) direkt.
 *
 * Varje funktion kontrollerar rollen mot databasen först (requireRoleFor) och läser
 * och skriver sedan som användaren med RLS (withUserDbFor). Läsning: ägare, admin och
 * läsare (order är ekonomi, påfyllaren får dem aldrig). Ändring: ägare och admin.
 * Ändringarna loggas i audit_log av triggarna på machines och machine_placements.
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

import { dayText } from "./model";
import type { RecentOrder } from "./types";
import {
  createMachineSchema,
  decommissionSchema,
  firstIssue,
  moveMachineSchema,
  placementBeforeStart,
  placementToReopen,
  planDecommission,
  planMove,
  reactivateSchema,
  sentences,
  updateMachineSchema,
  type PlacementSpan,
} from "./validation";

export type { Viewer };

/** Så många order visas under "Senaste order". */
export const RECENT_ORDERS_LIMIT = 12;

type Row = Record<string, unknown>;

async function query<T extends Row>(tx: Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function isoDateOrNull(value: unknown): IsoDate | null {
  const v = value === null || value === undefined ? null : String(value);
  return v !== null && isIsoDate(v) ? v : null;
}

// ---------------------------------------------------------------------------
// Läsning (ägare, admin, läsare)
// ---------------------------------------------------------------------------

/** Senaste ordern per automat (ISO 8601), oavsett period. */
export async function loadLastOrderAtFor(viewer: Viewer): Promise<Map<string, string>> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = await query<{ machine_id: string; last: unknown }>(
      tx,
      sql`select o.machine_id, max(o.ordered_at) as last
          from public.orders o
          where o.organization_id = ${orgId}::uuid and o.machine_id is not null
          group by o.machine_id`,
    );
    const out = new Map<string, string>();
    for (const r of rows) {
      const at = iso(r.last);
      if (at) out.set(r.machine_id, at);
    }
    return out;
  });
}

export interface MachineOrderSummary {
  readonly firstOrderDate: IsoDate | null;
  readonly lastOrderDate: IsoDate | null;
  readonly recent: RecentOrder[];
}

/** Första och sista orderdag samt de senaste orderna för en automat. */
export async function loadMachineOrdersFor(
  viewer: Viewer,
  machineId: string,
  limit = RECENT_ORDERS_LIMIT,
): Promise<MachineOrderSummary> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  if (!isUuid(machineId)) return { firstOrderDate: null, lastOrderDate: null, recent: [] };
  return withUserDbFor(viewer.user, async (tx) => {
    const [span] = await query<{ first: unknown; last: unknown }>(
      tx,
      sql`select min(o.business_date)::text as first, max(o.business_date)::text as last
          from public.orders o
          where o.organization_id = ${orgId}::uuid and o.machine_id = ${machineId}::uuid`,
    );
    const recent = await query<{
      id: string;
      external_id: string;
      ordered_at: unknown;
      title_name: string | null;
      raw_title: string;
      amount_ore: unknown;
      payment_method: string | null;
    }>(
      tx,
      sql`select o.id, o.external_id, o.ordered_at, t.name as title_name, o.raw_title,
                 o.amount_ore, o.payment_method
          from public.orders o
          left join public.titles t on t.organization_id = o.organization_id and t.id = o.title_id
          where o.organization_id = ${orgId}::uuid and o.machine_id = ${machineId}::uuid
          order by o.ordered_at desc, o.id desc
          limit ${Math.max(1, Math.min(100, limit))}`,
    );
    return {
      firstOrderDate: isoDateOrNull(span?.first),
      lastOrderDate: isoDateOrNull(span?.last),
      recent: recent.map((r) => ({
        id: r.id,
        externalId: r.external_id,
        orderedAt: iso(r.ordered_at) ?? "",
        titleName: r.title_name ?? r.raw_title,
        amountOre: Number(r.amount_ore),
        paymentMethod: r.payment_method,
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// Ändringar (ägare och admin)
// ---------------------------------------------------------------------------

interface MachineRow {
  id: string;
  code: string;
  name: string;
  activeFrom: IsoDate | null;
  activeTo: IsoDate | null;
  archived: boolean;
}

async function guard(viewer: Viewer): Promise<ActionResult | null> {
  try {
    await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
    return null;
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return { ok: false, error: "Bara ägare och admin kan ändra automater." };
    }
    throw error;
  }
}

async function lockMachine(tx: Tx, orgId: string, machineId: string): Promise<MachineRow | null> {
  const rows = await query<{
    id: string;
    code: string;
    name: string;
    active_from: unknown;
    active_to: unknown;
    archived_at: unknown;
  }>(
    tx,
    sql`select id, code, name, active_from::text as active_from, active_to::text as active_to,
               archived_at
        from public.machines
        where organization_id = ${orgId}::uuid and id = ${machineId}::uuid
        for update`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    activeFrom: isoDateOrNull(r.active_from),
    activeTo: isoDateOrNull(r.active_to),
    archived: r.archived_at !== null && r.archived_at !== undefined,
  };
}

async function placementsOf(tx: Tx, orgId: string, machineId: string): Promise<PlacementSpan[]> {
  const rows = await tx
    .select({
      id: s.machinePlacements.id,
      storeId: s.machinePlacements.storeId,
      from: s.machinePlacements.validFrom,
      to: s.machinePlacements.validTo,
    })
    .from(s.machinePlacements)
    .where(
      and(
        eq(s.machinePlacements.organizationId, orgId),
        eq(s.machinePlacements.machineId, machineId),
      ),
    )
    .orderBy(asc(s.machinePlacements.validFrom));
  return rows;
}

async function orderSpan(
  tx: Tx,
  orgId: string,
  machineId: string,
): Promise<{ first: IsoDate | null; last: IsoDate | null }> {
  const [r] = await query<{ first: unknown; last: unknown }>(
    tx,
    sql`select min(business_date)::text as first, max(business_date)::text as last
        from public.orders
        where organization_id = ${orgId}::uuid and machine_id = ${machineId}::uuid`,
  );
  return { first: isoDateOrNull(r?.first), last: isoDateOrNull(r?.last) };
}

async function activeStoreName(tx: Tx, orgId: string, storeId: string): Promise<string | null> {
  const [r] = await query<{ name: string; archived_at: unknown }>(
    tx,
    sql`select name, archived_at from public.stores
        where organization_id = ${orgId}::uuid and id = ${storeId}::uuid`,
  );
  if (!r || (r.archived_at !== null && r.archived_at !== undefined)) return null;
  return r.name;
}

/** Fel som ska visas för användaren: våra egna meddelanden och databasens BL-koder. */
class UserError extends Error {}

async function run<T>(fn: () => Promise<ActionResult<T>>): Promise<ActionResult<T>> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof UserError) return { ok: false, error: error.message };
    if (error instanceof AuthorizationError) return { ok: false, error: error.message };
    const pg = pgErrorOf(error);
    if (pg?.code === "23505")
      return { ok: false, error: "Det finns redan en automat med den koden." };
    if (pg?.code === "23P01") {
      return { ok: false, error: "Placeringen krockar med en annan placering för automaten." };
    }
    if (!pg) console.error("[automater] Ändringen misslyckades:", error);
    return { ok: false, error: dbErrorMessage(error, "Ändringen kunde inte sparas. Försök igen.") };
  }
}

function dayOf(viewer: Viewer) {
  const today = businessToday(new Date(), viewer.organization.timezone);
  return (d: IsoDate) => dayText(d, today);
}

/** Lägger till en automat (och placeringen i butiken, om en butik valts). */
export async function createMachineFor(
  viewer: Viewer,
  raw: unknown,
): Promise<ActionResult<{ id: string; code: string }>> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = createMachineSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;
  const orgId = viewer.organization.id;
  return run(() =>
    withUserDbFor(viewer.user, async (tx) => {
      const [taken] = await query<{ id: string }>(
        tx,
        sql`select id from public.machines
            where organization_id = ${orgId}::uuid and code = ${input.code}`,
      );
      if (taken) throw new UserError(`Det finns redan en automat med koden ${input.code}.`);
      if (input.storeId && !(await activeStoreName(tx, orgId, input.storeId))) {
        throw new UserError("Butiken finns inte eller är arkiverad.");
      }
      const [created] = await tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: input.code,
          name: input.name,
          serial: input.serial,
          activeFrom: input.activeFrom,
        })
        .returning({ id: s.machines.id, code: s.machines.code });
      if (!created) throw new UserError("Automaten kunde inte sparas.");
      if (input.storeId) {
        await tx.insert(s.machinePlacements).values({
          organizationId: orgId,
          machineId: created.id,
          storeId: input.storeId,
          validFrom: input.activeFrom,
        });
      }
      return { ok: true as const, data: created };
    }),
  );
}

/** Ändrar namn, serienummer och driftstart. */
export async function updateMachineFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = updateMachineSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;
  const orgId = viewer.organization.id;
  const day = dayOf(viewer);
  return run(() =>
    withUserDbFor(viewer.user, async (tx) => {
      const m = await lockMachine(tx, orgId, input.machineId);
      if (!m) throw new UserError("Automaten finns inte.");
      if (m.activeTo !== null && input.activeFrom > m.activeTo) {
        throw new UserError(
          sentences(
            `${m.code} avvecklades ${day(m.activeTo)}`,
            "Driftstarten kan inte ligga efter.",
          ),
        );
      }
      const span = await orderSpan(tx, orgId, m.id);
      if (span.first !== null && input.activeFrom > span.first) {
        throw new UserError(
          sentences(
            `${m.code} har order från ${day(span.first)}`,
            "Driftstarten kan inte ligga senare.",
          ),
        );
      }
      const placedFrom = placementBeforeStart(
        await placementsOf(tx, orgId, m.id),
        input.activeFrom,
      );
      if (placedFrom !== null) {
        throw new UserError(
          sentences(
            `${m.code} står i en butik från ${day(placedFrom)}`,
            "Driftstarten kan inte ligga senare.",
          ),
        );
      }
      await tx
        .update(s.machines)
        .set({ name: input.name, serial: input.serial, activeFrom: input.activeFrom })
        .where(and(eq(s.machines.organizationId, orgId), eq(s.machines.id, m.id)));
      return { ok: true as const };
    }),
  );
}

/** Flyttar automaten till en annan butik från och med ett datum (machine_placements). */
export async function moveMachineFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = moveMachineSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;
  const orgId = viewer.organization.id;
  const day = dayOf(viewer);
  return run(() =>
    withUserDbFor(viewer.user, async (tx) => {
      const m = await lockMachine(tx, orgId, input.machineId);
      if (!m) throw new UserError("Automaten finns inte.");
      const target = await activeStoreName(tx, orgId, input.storeId);
      if (!target) throw new UserError("Butiken finns inte eller är arkiverad.");
      const placements = await placementsOf(tx, orgId, m.id);
      const names = new Map<string, string>();
      for (const p of placements) {
        if (!names.has(p.storeId)) {
          names.set(p.storeId, (await activeStoreName(tx, orgId, p.storeId)) ?? "en annan butik");
        }
      }
      names.set(input.storeId, target);
      const plan = planMove({
        placements,
        storeId: input.storeId,
        from: input.from,
        activeFrom: m.activeFrom,
        activeTo: m.activeTo,
        code: m.code,
        day,
        storeName: (id) => names.get(id) ?? "butiken",
      });
      if (!plan.ok) throw new UserError(plan.error);
      if (plan.close) {
        await tx
          .update(s.machinePlacements)
          .set({ validTo: plan.close.to })
          .where(
            and(
              eq(s.machinePlacements.organizationId, orgId),
              eq(s.machinePlacements.id, plan.close.id),
            ),
          );
      }
      await tx.insert(s.machinePlacements).values({
        organizationId: orgId,
        machineId: m.id,
        storeId: plan.insert.storeId,
        validFrom: plan.insert.from,
        validTo: plan.insert.to,
        note: input.note,
      });
      return { ok: true as const };
    }),
  );
}

/** Avvecklar automaten: active_to sätts och pågående placering avslutas. Historiken behålls. */
export async function decommissionMachineFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = decommissionSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const input = parsed.data;
  const orgId = viewer.organization.id;
  const day = dayOf(viewer);
  return run(() =>
    withUserDbFor(viewer.user, async (tx) => {
      const m = await lockMachine(tx, orgId, input.machineId);
      if (!m) throw new UserError("Automaten finns inte.");
      const span = await orderSpan(tx, orgId, m.id);
      const plan = planDecommission({
        placements: await placementsOf(tx, orgId, m.id),
        activeTo: input.activeTo,
        activeFrom: m.activeFrom,
        lastOrderDate: span.last,
        code: m.code,
        day,
      });
      if (!plan.ok) throw new UserError(plan.error);
      for (const c of plan.close) {
        await tx
          .update(s.machinePlacements)
          .set({ validTo: c.to })
          .where(
            and(eq(s.machinePlacements.organizationId, orgId), eq(s.machinePlacements.id, c.id)),
          );
      }
      await tx
        .update(s.machines)
        .set({ activeTo: input.activeTo })
        .where(and(eq(s.machines.organizationId, orgId), eq(s.machines.id, m.id)));
      return { ok: true as const };
    }),
  );
}

/**
 * Ångrar en avveckling: active_to tas bort, och placeringen som avvecklingen avslutade
 * öppnas igen (om butiken inte är arkiverad), så att hyra och provision räknas som förut.
 * Annars väljs butiken med "Placera i butik".
 */
export async function reactivateMachineFor(viewer: Viewer, raw: unknown): Promise<ActionResult> {
  const denied = await guard(viewer);
  if (denied) return denied;
  const parsed = reactivateSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, error: firstIssue(parsed.error) };
  const orgId = viewer.organization.id;
  return run(() =>
    withUserDbFor(viewer.user, async (tx) => {
      const m = await lockMachine(tx, orgId, parsed.data.machineId);
      if (!m) throw new UserError("Automaten finns inte.");
      if (m.archived) throw new UserError(`${m.code} är arkiverad och kan inte återaktiveras här.`);
      if (m.activeTo === null) throw new UserError(`${m.code} är redan i drift.`);
      const reopen = placementToReopen(await placementsOf(tx, orgId, m.id), m.activeTo);
      await tx
        .update(s.machines)
        .set({ activeTo: null })
        .where(and(eq(s.machines.organizationId, orgId), eq(s.machines.id, m.id)));
      if (reopen && (await activeStoreName(tx, orgId, reopen.storeId))) {
        await tx
          .update(s.machinePlacements)
          .set({ validTo: null })
          .where(
            and(
              eq(s.machinePlacements.organizationId, orgId),
              eq(s.machinePlacements.id, reopen.id),
            ),
          );
      }
      return { ok: true as const };
    }),
  );
}
