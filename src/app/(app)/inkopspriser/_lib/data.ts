/**
 * Data och ändringar för Inköpspriser, utan beroende på Next (användaren skickas in).
 * Testas mot testdatabasen i test/db/inkopspriser-prices.test.ts; ../actions.ts kopplar
 * ihop dem med sessionen.
 *
 * Allt körs som användaren under RLS (withUserDbFor) efter en rollkontroll mot databasen
 * (requireRoleFor). Påfyllaren släpps aldrig in: purchase_prices, audit_log och
 * period_closes är dessutom stängda för rollen i RLS. Databasen har sista ordet om stängda
 * månader (BL004, purchase_prices_period_guard) och varje ändring loggas i audit_log av
 * triggern private.audit().
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Tx } from "@/db/client";
import type { MemberRole } from "@/db/schema";
import { isIsoDate, type IsoDate } from "@/domain";
import {
  AuthorizationError,
  requireRoleFor,
  withUserDbFor,
  type SessionUser,
} from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

import {
  closedMonthsHit,
  MAX_UNIT_COST_ORE,
  planCorrection,
  PRICE_MESSAGES,
  type PriceAuditEvent,
  type PriceRecord,
} from "./model";

const READ_ROLES = ["owner", "admin", "viewer"] as const satisfies readonly MemberRole[];
const WRITE_ROLES = ["owner", "admin"] as const satisfies readonly MemberRole[];

/** Det sidan behöver utöver beräkningsindata (som kommer från loadDomainInput). */
export interface PricePageData {
  /** Alla inköpspriser (även för arkiverade titlar), äldst först per titel. */
  readonly prices: PriceRecord[];
  /** Stängda månader 'ÅÅÅÅ-MM' (inte återöppnade), sorterade. */
  readonly closedMonths: string[];
  /** Visningsnamn per användar-id (profiler i organisationen). */
  readonly actorNames: Record<string, string>;
  /** Senaste ändringen av något inköpspris (audit_log), ISO, eller null. */
  readonly lastChangeAt: string | null;
}

/** Underlaget för en titel: prisloggen och antal order per affärsdag (all tid). */
export interface TitleDetailData {
  readonly events: PriceAuditEvent[];
  /** Antal order per affärsdag för titeln, äldst först. Inga belopp. */
  readonly orderDays: Array<{ date: IsoDate; orders: number }>;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function isoDay(value: unknown): IsoDate {
  if (value instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${value.getUTCFullYear()}-${p(value.getUTCMonth() + 1)}-${p(value.getUTCDate())}`;
  }
  return String(value).slice(0, 10);
}

async function queryPriceRecords(tx: Tx, orgId: string): Promise<PriceRecord[]> {
  const result = await tx.execute(
    sql`select pp.id, pp.title_id, pp.unit_cost_ore, pp.valid_from::text as valid_from, pp.note,
               pp.created_at, pp.created_by
        from public.purchase_prices pp
        where pp.organization_id = ${orgId}::uuid
        order by pp.title_id, pp.valid_from`,
  );
  return (Array.from(result) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    titleId: String(r.title_id),
    unitCostOre: Number(r.unit_cost_ore),
    validFrom: isoDay(r.valid_from),
    note: typeof r.note === "string" && r.note.trim() !== "" ? r.note : null,
    createdAt: iso(r.created_at),
    createdBy: typeof r.created_by === "string" ? r.created_by : null,
  }));
}

async function queryOrderDays(
  tx: Tx,
  orgId: string,
  titleId: string,
): Promise<Array<{ date: IsoDate; orders: number }>> {
  const result = await tx.execute(
    sql`select o.business_date::text as day, count(*)::int as orders
        from public.orders o
        where o.organization_id = ${orgId}::uuid and o.title_id = ${titleId}::uuid
        group by o.business_date
        order by o.business_date`,
  );
  return (Array.from(result) as Record<string, unknown>[]).map((r) => ({
    date: isoDay(r.day),
    orders: Number(r.orders),
  }));
}

async function queryClosedMonths(tx: Tx, orgId: string): Promise<string[]> {
  const result = await tx.execute(
    sql`select to_char(pc.month, 'YYYY-MM') as month
        from public.period_closes pc
        where pc.organization_id = ${orgId}::uuid and pc.reopened_at is null
        order by pc.month`,
  );
  return (Array.from(result) as Record<string, unknown>[]).map((r) => String(r.month));
}

async function queryActorNames(tx: Tx, orgId: string): Promise<Record<string, string>> {
  const result = await tx.execute(
    sql`select p.user_id, p.display_name
        from public.profiles p
        where p.organization_id = ${orgId}::uuid and p.user_id is not null
          and p.anonymized_at is null`,
  );
  const out: Record<string, string> = {};
  for (const r of Array.from(result) as Record<string, unknown>[]) {
    if (typeof r.user_id === "string" && typeof r.display_name === "string") {
      out[r.user_id] = r.display_name;
    }
  }
  return out;
}

async function queryLastChange(tx: Tx, orgId: string): Promise<string | null> {
  const result = await tx.execute(
    sql`select max(a.occurred_at) as at
        from public.audit_log a
        where a.organization_id = ${orgId}::uuid and a.table_name = 'purchase_prices'`,
  );
  const at = (Array.from(result) as Record<string, unknown>[])[0]?.at;
  return at === null || at === undefined ? null : iso(at);
}

/** Priser, stängda månader, namn och senaste prisändring. Ägare, admin och läsare. */
export async function loadPricePageFor(
  user: SessionUser,
  organizationId: string,
): Promise<PricePageData> {
  await requireRoleFor(user, organizationId, READ_ROLES);
  return withUserDbFor(user, async (tx) => {
    const [prices, closedMonths, actorNames, lastChangeAt] = await Promise.all([
      queryPriceRecords(tx, organizationId),
      queryClosedMonths(tx, organizationId),
      queryActorNames(tx, organizationId),
      queryLastChange(tx, organizationId),
    ]);
    return { prices, closedMonths, actorNames, lastChangeAt };
  });
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return jsonObject(parsed);
    } catch {
      return null;
    }
  }
  return null;
}

function priceState(value: unknown): PriceAuditEvent["before"] {
  const o = jsonObject(value);
  if (!o) return null;
  const cost = Number(o.unit_cost_ore);
  const from = typeof o.valid_from === "string" ? o.valid_from.slice(0, 10) : null;
  if (!Number.isFinite(cost) || !from) return null;
  return {
    unitCostOre: cost,
    validFrom: from,
    note: typeof o.note === "string" && o.note.trim() !== "" ? o.note : null,
  };
}

/** Prisloggen (audit_log) och orderdagarna för en titel. Ägare, admin och läsare. */
export async function loadTitleDetailFor(
  user: SessionUser,
  organizationId: string,
  titleId: string,
): Promise<TitleDetailData> {
  await requireRoleFor(user, organizationId, READ_ROLES);
  if (!z.uuid().safeParse(titleId).success) return { events: [], orderDays: [] };
  return withUserDbFor(user, async (tx) => {
    const [auditResult, orderDays] = await Promise.all([
      tx.execute(
        sql`select a.id, a.row_id, a.action::text as action, a.actor_id, a.occurred_at,
                   a.before, a.after
            from public.audit_log a
            where a.organization_id = ${organizationId}::uuid
              and a.table_name = 'purchase_prices'
              and coalesce(a.after ->> 'title_id', a.before ->> 'title_id') = ${titleId}
            order by a.occurred_at, a.id`,
      ),
      queryOrderDays(tx, organizationId, titleId),
    ]);
    const events = (Array.from(auditResult) as Record<string, unknown>[]).flatMap(
      (r): PriceAuditEvent[] => {
        const action = String(r.action);
        if (action !== "insert" && action !== "update" && action !== "delete") return [];
        return [
          {
            id: String(r.id),
            rowId: String(r.row_id),
            action,
            actorId: typeof r.actor_id === "string" ? r.actor_id : null,
            occurredAt: iso(r.occurred_at),
            before: priceState(r.before),
            after: priceState(r.after),
          },
        ];
      },
    );
    return { events, orderDays };
  });
}

// ---------------------------------------------------------------------------
// Nytt inköpspris
// ---------------------------------------------------------------------------

const addInput = z.object({
  organizationId: z.uuid(),
  titleId: z.uuid(),
  unitCostOre: z.number().int().min(0).max(MAX_UNIT_COST_ORE),
  validFrom: z.string().refine(isIsoDate),
  note: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((v) => (v ? v : null)),
});

export type AddPriceInput = z.input<typeof addInput>;

/** Vad som hände: ett nytt pris eller ett ändrat pris samma dag. */
export interface AddPriceOutcome {
  readonly mode: "inserted" | "replaced";
  readonly priceId: string;
}

async function loadWritableTitle(
  tx: Tx,
  organizationId: string,
  titleId: string,
): Promise<string | null> {
  const title = Array.from(
    await tx.execute(
      sql`select t.id, t.merged_into_id from public.titles t
          where t.organization_id = ${organizationId}::uuid and t.id = ${titleId}::uuid`,
    ),
  )[0] as Record<string, unknown> | undefined;
  if (!title) return PRICE_MESSAGES.titleMissing;
  if (title.merged_into_id) return PRICE_MESSAGES.titleMerged;
  return null;
}

function writeError(error: unknown): { ok: false; error: string } {
  const pg = pgErrorOf(error);
  if (pg?.code === "BL004") return { ok: false, error: PRICE_MESSAGES.closedMonthGeneric };
  if (pg?.code === "42501") return { ok: false, error: PRICE_MESSAGES.forbidden };
  return { ok: false, error: dbErrorMessage(error) };
}

async function authorizeWrite(
  user: SessionUser | null,
  organizationId: string,
): Promise<ActionResult | null> {
  if (!user) return { ok: false, error: "Du är inte inloggad." };
  try {
    await requireRoleFor(user, organizationId, WRITE_ROLES);
    return null;
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: PRICE_MESSAGES.forbidden };
    throw error;
  }
}

/**
 * Lägger till ett inköpspris som gäller från `validFrom`. Finns redan ett pris för titeln
 * samma dag ändras det i stället (loggas som ändring). Blockeras om priset skulle gälla
 * någon dag i en stängd månad, med ett begripligt fel. Bara ägare och admin.
 */
export async function addPurchasePriceFor(
  user: SessionUser | null,
  raw: AddPriceInput,
): Promise<ActionResult<AddPriceOutcome>> {
  const parsed = addInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: PRICE_MESSAGES.invalid };
  const input = parsed.data;
  const denied = await authorizeWrite(user, input.organizationId);
  if (denied) return denied;

  try {
    return await withUserDbFor(user as SessionUser, async (tx) => {
      const titleError = await loadWritableTitle(tx, input.organizationId, input.titleId);
      if (titleError) return { ok: false, error: titleError };

      // Samma kontroll som databasen gör, för ett fel som säger vilken månad det gäller.
      const [prices, closed] = await Promise.all([
        queryPriceRecords(tx, input.organizationId),
        queryClosedMonths(tx, input.organizationId),
      ]);
      const own = prices.filter((p) => p.titleId === input.titleId);
      const existing = own.find((p) => p.validFrom === input.validFrom);
      // En ren ändring av anteckningen påverkar inga siffror och släpps igenom (som i
      // databasvakten, som bara bevakar belopp och datum).
      const noteOnly = existing !== undefined && existing.unitCostOre === input.unitCostOre;
      const hit = noteOnly ? [] : closedMonthsHit(own, input.validFrom, closed);
      if (hit.length > 0) {
        return { ok: false, error: PRICE_MESSAGES.closedMonth(hit) };
      }

      if (existing) {
        if (existing.unitCostOre === input.unitCostOre && existing.note === input.note) {
          return { ok: false, error: PRICE_MESSAGES.unchanged };
        }
        await tx.execute(
          sql`update public.purchase_prices
              set unit_cost_ore = ${input.unitCostOre}, note = ${input.note}
              where organization_id = ${input.organizationId}::uuid and id = ${existing.id}::uuid`,
        );
        return { ok: true, data: { mode: "replaced", priceId: existing.id } };
      }
      const inserted = Array.from(
        await tx.execute(
          sql`insert into public.purchase_prices
                (organization_id, title_id, unit_cost_ore, valid_from, note)
              values (${input.organizationId}::uuid, ${input.titleId}::uuid,
                      ${input.unitCostOre}, ${input.validFrom}::date, ${input.note})
              returning id`,
        ),
      )[0] as { id: string };
      return { ok: true, data: { mode: "inserted", priceId: String(inserted.id) } };
    });
  } catch (error) {
    return writeError(error);
  }
}

// ---------------------------------------------------------------------------
// Rätta priset (all försäljning hittills)
// ---------------------------------------------------------------------------

const correctInput = addInput.omit({ validFrom: true }).extend({
  today: z.string().refine(isIsoDate),
});

export type CorrectPriceInput = z.input<typeof correctInput>;

/** Vad rättelsen gjorde med titelns sålda order. */
export interface CorrectPriceOutcome {
  /** Första dagen som fick det nya priset. */
  readonly start: IsoDate;
  readonly affectedOrders: number;
  readonly ordersGainingPrice: number;
  /** Vinstens förändring för order som redan hade pris. */
  readonly profitDeltaOre: number;
}

/**
 * "Rätta priset": det nya priset gäller titelns nuvarande prisperiod och alla äldre, så att
 * all försäljning hittills får det (planCorrection i model.ts). Allt i en transaktion; inga
 * rader tas bort, perioderna får nytt belopp (och den första flyttas vid behov bakåt till
 * titelns första order). Stängda månader rörs inte: rättelsen börjar efter den senaste
 * stängda månaden (databasvakten BL004 har sista ordet). Varje ändrad rad loggas av
 * triggern. Bara ägare och admin.
 */
export async function correctPurchasePriceFor(
  user: SessionUser | null,
  raw: CorrectPriceInput,
): Promise<ActionResult<CorrectPriceOutcome>> {
  const parsed = correctInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: PRICE_MESSAGES.invalid };
  const input = parsed.data;
  const denied = await authorizeWrite(user, input.organizationId);
  if (denied) return denied;
  const org = input.organizationId;

  try {
    return await withUserDbFor(user as SessionUser, async (tx) => {
      const titleError = await loadWritableTitle(tx, org, input.titleId);
      if (titleError) return { ok: false, error: titleError };

      const [prices, closedMonths, orderDays] = await Promise.all([
        queryPriceRecords(tx, org),
        queryClosedMonths(tx, org),
        queryOrderDays(tx, org, input.titleId),
      ]);
      const own = prices.filter((p) => p.titleId === input.titleId);
      const plan = planCorrection({
        prices: own,
        orderDays,
        unitCostOre: input.unitCostOre,
        closedMonths,
        today: input.today,
      });
      if (plan.start === null) return { ok: false, error: PRICE_MESSAGES.correctionClosed };
      if (plan.steps.length === 0) {
        return { ok: false, error: PRICE_MESSAGES.correctionUnchanged };
      }

      // Anteckningen hamnar på perioden som gäller i dag (den senaste som rättas).
      const last = plan.steps.at(-1)!;
      for (const step of plan.steps) {
        const note = step === last ? input.note : undefined;
        if (step.kind === "insert") {
          await tx.execute(
            sql`insert into public.purchase_prices
                  (organization_id, title_id, unit_cost_ore, valid_from, note)
                values (${org}::uuid, ${input.titleId}::uuid, ${input.unitCostOre},
                        ${step.validFrom}::date, ${note ?? null})`,
          );
          continue;
        }
        const row = own.find((p) => p.validFrom === step.validFrom)!;
        await tx.execute(
          sql`update public.purchase_prices
              set unit_cost_ore = ${input.unitCostOre},
                  valid_from = ${step.newValidFrom ?? step.validFrom}::date,
                  note = ${note ?? row.note}
              where organization_id = ${org}::uuid and id = ${row.id}::uuid`,
        );
      }
      return {
        ok: true,
        data: {
          start: plan.start,
          affectedOrders: plan.affectedOrders,
          ordersGainingPrice: plan.ordersGainingPrice,
          profitDeltaOre: plan.profitDeltaOre,
        },
      };
    });
  } catch (error) {
    return writeError(error);
  }
}
