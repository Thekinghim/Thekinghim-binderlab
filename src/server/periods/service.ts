/**
 * Stängda månader (period_closes): appen stänger månaden när den är klar och ägaren kan
 * öppna den igen.
 *
 * - closeMonthIfDoneTx: anropas i samma transaktion som "markera som betald" (avräkning)
 *   och "markera som skickad" (bokföring). Stänger månaden med databasens close_period.
 * - reopenAfterUndoTx: anropas från "ångra betald" och "ångra skickad". Öppnar månaden
 *   om inget längre håller den stängd. Bara ägaren kan öppna (databasen); för en admin
 *   ligger månaden kvar stängd och svaret säger det.
 * - reopenMonthFor / closeMonthFor: ägarens "Öppna månaden igen" (med anledning) och
 *   "Stäng månaden" (ägare och admin).
 *
 * Allt körs som användaren under RLS; close_period och reopen_period kontrollerar rollen
 * i databasen och loggar i audit_log.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import { monthEnd, monthStart, type IsoDate, type IsoMonth } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { queryEffectivePlacements } from "@/server/data/core/queries";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";
import { pgErrorOf } from "@/server/errors";
import { storesPlacedIn } from "@/server/reports/sources";

import { monthLong, type ClosedMonth, type CloseTrigger } from "./model";

export class PeriodError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeriodError";
  }
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function assertMonth(month: string): asserts month is IsoMonth {
  if (!MONTH.test(month)) throw new PeriodError("Ogiltig månad.");
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function triggerOf(snapshot: unknown): CloseTrigger {
  const app = (snapshot as { app?: { trigger?: unknown } } | null)?.app;
  const t = app?.trigger;
  return t === "settlement_paid" || t === "bookkeeping_sent" ? t : "manual";
}

/** Stängda månader (inte öppnade igen), äldst först. */
export async function queryClosedMonths(tx: Tx, orgId: string): Promise<ClosedMonth[]> {
  const rows = Array.from(
    await tx.execute(sql`
      select to_char(pc.month, 'YYYY-MM') as month, pc.closed_at, pc.snapshot
      from public.period_closes pc
      where pc.organization_id = ${orgId}::uuid and pc.reopened_at is null
      order by pc.month`),
  ) as { month: string; closed_at: string | Date; snapshot: unknown }[];
  return rows.map((r) => ({
    month: r.month as IsoMonth,
    closedAt: new Date(r.closed_at).toISOString(),
    trigger: triggerOf(r.snapshot),
  }));
}

/** Bara månaderna ('ÅÅÅÅ-MM'), äldst först. */
export async function queryClosedMonthKeys(tx: Tx, orgId: string): Promise<IsoMonth[]> {
  return (await queryClosedMonths(tx, orgId)).map((c) => c.month);
}

async function isClosed(tx: Tx, orgId: string, month: IsoMonth): Promise<boolean> {
  const rows = Array.from(
    await tx.execute(sql`
      select 1 from public.period_closes pc
      where pc.organization_id = ${orgId}::uuid and pc.month = ${`${month}-01`}::date
        and pc.reopened_at is null`),
  );
  return rows.length > 0;
}

/**
 * Är månadens avräkningar klara? Alla butiker som hade en automat har en avräkning, minst
 * en är betald och ingen med ett belopp är obetald (0 kr behöver inte betalas).
 */
export async function settlementsDoneTx(tx: Tx, orgId: string, month: IsoMonth): Promise<boolean> {
  const rows = Array.from(
    await tx.execute(sql`
      select store_id, amount_ore, paid_on
      from public.store_settlements
      where organization_id = ${orgId}::uuid and month = ${`${month}-01`}::date`),
  ) as { store_id: string; amount_ore: number | string; paid_on: string | null }[];
  if (!rows.some((r) => r.paid_on !== null)) return false;
  if (rows.some((r) => r.paid_on === null && Number(r.amount_ore) !== 0)) return false;
  const have = new Set(rows.map((r) => String(r.store_id)));
  const wanted = storesPlacedIn(await queryEffectivePlacements(tx, orgId), {
    start: monthStart(month),
    end: monthEnd(month),
  });
  return wanted.every((id) => have.has(id));
}

async function bookkeepingSentTx(tx: Tx, orgId: string, month: IsoMonth): Promise<boolean> {
  const rows = Array.from(
    await tx.execute(sql`
      select 1 from public.bookkeeping_months
      where organization_id = ${orgId}::uuid and month = ${`${month}-01`}::date
        and sent_at is not null`),
  );
  return rows.length > 0;
}

/**
 * Stänger månaden om den är klar och inte redan stängd. `trigger` säger vad som just
 * hände: "bookkeeping_sent" stänger alltid, "settlement_paid" bara när alla månadens
 * avräkningar är klara (settlementsDoneTx). Den innevarande månaden stängs aldrig.
 * Ger true när månaden stängdes nu.
 */
export async function closeMonthIfDoneTx(
  tx: Tx,
  input: { organizationId: string; month: IsoMonth; trigger: CloseTrigger; today: IsoDate },
): Promise<boolean> {
  const { organizationId: orgId, month, trigger } = input;
  if (month >= input.today.slice(0, 7)) return false;
  if (await isClosed(tx, orgId, month)) return false;
  if (trigger === "settlement_paid" && !(await settlementsDoneTx(tx, orgId, month))) return false;
  const snapshot = JSON.stringify({ trigger });
  await tx.execute(
    sql`select public.close_period(${orgId}::uuid, ${`${month}-01`}::date, ${snapshot}::jsonb)`,
  );
  return true;
}

export type UndoOutcome =
  /** Månaden var inte stängd. */
  | "open"
  /** Månaden öppnades. */
  | "reopened"
  /** Något annat håller månaden stängd (betalda avräkningar eller skickad bokföring). */
  | "kept"
  /** Skulle öppnas, men bara ägaren får: månaden är kvar stängd. */
  | "owner-needed";

/**
 * Efter "ångra betald" eller "ångra skickad": öppnar månaden om den stängdes av appen och
 * inget längre håller den stängd. En månad som ägaren eller admin stängt för hand ligger
 * kvar. Bara ägaren öppnar (databasen); för admin blir svaret "owner-needed".
 */
export async function reopenAfterUndoTx(
  tx: Tx,
  input: { organizationId: string; month: IsoMonth; role: string; reason: string },
): Promise<UndoOutcome> {
  const { organizationId: orgId, month } = input;
  const closed = (await queryClosedMonths(tx, orgId)).find((c) => c.month === month);
  if (!closed) return "open";
  if (closed.trigger === "manual") return "kept";
  if (await bookkeepingSentTx(tx, orgId, month)) return "kept";
  if (await settlementsDoneTx(tx, orgId, month)) return "kept";
  if (input.role !== "owner") return "owner-needed";
  await tx.execute(
    sql`select public.reopen_period_with_reason(${orgId}::uuid, ${`${month}-01`}::date, ${input.reason})`,
  );
  return "reopened";
}

/** Texten efter ett "ångra" när månaden ligger kvar stängd (annars null). */
export function undoOutcomeText(outcome: UndoOutcome, month: string): string | null {
  if (outcome === "reopened") return `${cap(monthLong(month))} är öppen igen.`;
  if (outcome === "owner-needed") {
    return `${cap(monthLong(month))} är fortfarande stängd. Bara ägaren kan öppna den.`;
  }
  if (outcome === "kept") return `${cap(monthLong(month))} är fortfarande stängd.`;
  return null;
}

function periodDbError(error: unknown): never {
  const pg = pgErrorOf(error);
  if (pg && ["42501", "22023", "BL015", "BL016"].includes(pg.code) && pg.message) {
    throw new PeriodError(pg.message);
  }
  throw error;
}

/** "Öppna månaden igen": bara ägaren, med en anledning (minst 3 tecken). Loggas. */
export async function reopenMonthFor(viewer: Viewer, month: string, reason: string): Promise<void> {
  assertMonth(month);
  const text = reason.trim();
  if (text.length < 3) throw new PeriodError("Skriv varför månaden öppnas.");
  if (text.length > 500) throw new PeriodError("Skriv kortare (högst 500 tecken).");
  const orgId = viewer.organization.id;
  try {
    await requireRoleFor(viewer.user, orgId, ["owner"]);
  } catch {
    throw new PeriodError("Bara ägaren kan öppna en stängd månad.");
  }
  try {
    await withUserDbFor(viewer.user, (tx) =>
      tx.execute(
        sql`select public.reopen_period_with_reason(${orgId}::uuid, ${`${month}-01`}::date, ${text})`,
      ),
    );
  } catch (error) {
    periodDbError(error);
  }
}

/** "Stäng månaden": ägare och admin, bara en månad som är slut. */
export async function closeMonthFor(
  viewer: Viewer,
  month: string,
  now: Date = new Date(),
): Promise<void> {
  assertMonth(month);
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  if (month >= businessToday(now, viewer.organization.timezone).slice(0, 7)) {
    throw new PeriodError(`${cap(monthLong(month))} är inte slut.`);
  }
  const snapshot = JSON.stringify({ trigger: "manual" satisfies CloseTrigger });
  try {
    await withUserDbFor(viewer.user, (tx) =>
      tx.execute(
        sql`select public.close_period(${orgId}::uuid, ${`${month}-01`}::date, ${snapshot}::jsonb)`,
      ),
    );
  } catch (error) {
    periodDbError(error);
  }
}

export interface PeriodOverview {
  readonly closed: readonly ClosedMonth[];
  /** Månader som öppnats igen och inte stängts sedan dess, med anledningen. Nyast först. */
  readonly reopened: readonly { month: IsoMonth; reopenedAt: string; reason: string | null }[];
  /** Bara ägaren öppnar. */
  readonly canReopen: boolean;
  /** Ägare och admin stänger. */
  readonly canClose: boolean;
}

/** Stängda månader och de som öppnats igen. Ägare, admin och läsare. */
export async function loadPeriodOverviewFor(viewer: Viewer): Promise<PeriodOverview> {
  const orgId = viewer.organization.id;
  const role = await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const closed = await queryClosedMonths(tx, orgId);
    const closedKeys = new Set<string>(closed.map((c) => c.month));
    const rows = Array.from(
      await tx.execute(sql`
        select distinct on (pc.month)
               to_char(pc.month, 'YYYY-MM') as month, pc.reopened_at, pc.reopened_reason
        from public.period_closes pc
        where pc.organization_id = ${orgId}::uuid and pc.reopened_at is not null
        order by pc.month, pc.reopened_at desc`),
    ) as { month: string; reopened_at: string | Date; reopened_reason: string | null }[];
    const reopened = rows
      .filter((r) => !closedKeys.has(r.month))
      .map((r) => ({
        month: r.month as IsoMonth,
        reopenedAt: new Date(r.reopened_at).toISOString(),
        reason: r.reopened_reason,
      }))
      .sort((a, b) => b.month.localeCompare(a.month));
    return { closed, reopened, canReopen: role === "owner", canClose: role !== "viewer" };
  });
}

/**
 * Stängda månader för sidor där något ändras (priser, avtal, testköp, återbetalningar).
 * Alla inloggade roller som kan läsa organisationen; tom lista om rollen inte får läsa.
 */
export async function loadClosedMonthKeysFor(viewer: Viewer): Promise<IsoMonth[]> {
  try {
    return await withUserDbFor(viewer.user, (tx) =>
      queryClosedMonthKeys(tx, viewer.organization.id),
    );
  } catch {
    return [];
  }
}

/**
 * Första dagen som inte är låst av något: dagen efter den senaste månaden som är stängd,
 * har en betald avräkning eller har skickad bokföring. null = ingen sådan månad finns
 * (allt är öppet). Förvalt startdatum när kortavgiften ändras.
 */
export async function firstOpenDayTx(tx: Tx, orgId: string): Promise<IsoDate | null> {
  const rows = Array.from(
    await tx.execute(sql`
      select to_char((max(x.m) + interval '1 month')::date, 'YYYY-MM-DD') as day
      from (
        select pc.month as m from public.period_closes pc
         where pc.organization_id = ${orgId}::uuid and pc.reopened_at is null
        union all
        select ss.month from public.store_settlements ss
         where ss.organization_id = ${orgId}::uuid and ss.paid_on is not null
        union all
        select bm.month from public.bookkeeping_months bm
         where bm.organization_id = ${orgId}::uuid and bm.sent_at is not null
      ) x`),
  ) as { day: string | null }[];
  return (rows[0]?.day as IsoDate | null | undefined) ?? null;
}

/** Som firstOpenDayTx, för ägare, admin och läsare. */
export async function loadFirstOpenDayFor(viewer: Viewer): Promise<IsoDate | null> {
  await requireRoleFor(viewer.user, viewer.organization.id, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, (tx) => firstOpenDayTx(tx, viewer.organization.id));
}
