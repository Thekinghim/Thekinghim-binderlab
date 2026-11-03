/**
 * Månadsavräkning per butik (Butiker → Butiksportal, Att göra och butiksportalen).
 *
 * - Den 1:a varje månad skapar det schemalagda jobbet (/api/cron/rapporter, efter
 *   rapportutkasten) förra månadens avräkningar som systemet (createMonthlySettlements).
 *   Ägare och admin skapar saknade avräkningar som sig själva när de öppnar sidan
 *   (ensureSettlementsFor), så inget hänger på att jobbet har körts.
 * - Beloppet räknas med samma laddare och rapportberäkning som månadsrapporten
 *   (loadSnapshotInput + buildSnapshot, typ butik): butikens ersättning enligt avtalet.
 * - Ägare och admin markerar som betald med ett datum, ångrar, och räknar om en obetald.
 *   Databasen låser beloppet på en betald avräkning och sätter vem och när.
 *
 * Allt som en användare gör körs som användaren under RLS (withUserDbFor) efter en
 * rollkontroll mot databasen (requireRoleFor). Bara jobbet kör som systemet.
 */

import "server-only";

import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";
import * as s from "@/db/schema";
import {
  addMonths,
  DomainError,
  monthEnd,
  monthStart,
  type IsoDate,
  type IsoMonth,
} from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { queryPlacements } from "@/server/data/core/queries";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";
import { pgErrorOf } from "@/server/errors";
import { buildSnapshot } from "@/server/reports/snapshot";
import { loadSnapshotInput, storesPlacedIn } from "@/server/reports/sources";

import {
  parseStatement,
  settlementFileName,
  settlementHtml,
  settlementMonthFor,
  settlementState,
  statementFromReport,
  type SettlementState,
  type SettlementStatement,
} from "./model";

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function messageOf(error: unknown): string {
  if (error instanceof DomainError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

/** Databasens fel som svenska meddelanden; annat kastas vidare. */
function settlementDbError(error: unknown): never {
  const pg = pgErrorOf(error);
  if (pg && (pg.code === "BL080" || pg.code === "BL081" || pg.code === "22023") && pg.message) {
    throw new SettlementError(pg.message);
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Uträkningen
// ---------------------------------------------------------------------------

export interface ComputedSettlement {
  readonly amountOre: number;
  readonly statement: SettlementStatement;
  readonly calcVersion: string;
}

/** Räknar butikens avräkning för månaden (samma underlag som månadsrapporten). */
export async function computeSettlementTx(
  tx: Tx,
  input: { organizationId: string; storeId: string; month: IsoMonth; now: Date },
): Promise<ComputedSettlement> {
  const snapshotInput = await loadSnapshotInput(tx, {
    organizationId: input.organizationId,
    type: "butik",
    month: input.month,
    storeId: input.storeId,
    now: input.now.toISOString(),
  });
  const snapshot = buildSnapshot(snapshotInput);
  if (snapshot.type !== "butik") throw new Error("Fel rapporttyp för avräkningen.");
  const statement = statementFromReport(snapshot.report);
  return { amountOre: statement.totalOre, statement, calcVersion: snapshot.calcVersion };
}

/** Butikerna som ska ha en avräkning för månaden: de som hade en automat någon dag. */
async function storesForMonth(tx: Tx, orgId: string, month: IsoMonth): Promise<string[]> {
  const placements = await queryPlacements(tx, orgId);
  return storesPlacedIn(placements, { start: monthStart(month), end: monthEnd(month) });
}

async function existingStores(tx: Tx, orgId: string, month: IsoMonth): Promise<Set<string>> {
  const rows = await tx
    .select({ storeId: s.storeSettlements.storeId })
    .from(s.storeSettlements)
    .where(
      and(
        eq(s.storeSettlements.organizationId, orgId),
        eq(s.storeSettlements.month, `${month}-01`),
      ),
    );
  return new Set(rows.map((r) => r.storeId));
}

async function insertSettlementTx(
  tx: Tx,
  orgId: string,
  storeId: string,
  month: IsoMonth,
  now: Date,
): Promise<string | null> {
  const c = await computeSettlementTx(tx, { organizationId: orgId, storeId, month, now });
  const rows = await tx
    .insert(s.storeSettlements)
    .values({
      organizationId: orgId,
      storeId,
      month: `${month}-01`,
      amountOre: c.amountOre,
      statement: c.statement as unknown as Record<string, unknown>,
      calcVersion: c.calcVersion,
      computedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: s.storeSettlements.id });
  return rows[0]?.id ?? null;
}

export interface SettlementRunResult {
  readonly organizationId: string;
  readonly month: IsoMonth;
  created: number;
  skipped: number;
  /** Butik och felmeddelande (t.ex. saknade inköpspriser under vinstdelning). */
  readonly errors: { storeId: string; message: string }[];
}

/** Skapar månadens saknade avräkningar i transaktionen `run` (en transaktion per butik). */
async function createMissing(
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  orgId: string,
  month: IsoMonth,
  now: Date,
): Promise<SettlementRunResult> {
  const result: SettlementRunResult = {
    organizationId: orgId,
    month,
    created: 0,
    skipped: 0,
    errors: [],
  };
  const [wanted, existing] = await run(async (tx) => [
    await storesForMonth(tx, orgId, month),
    await existingStores(tx, orgId, month),
  ]);
  for (const storeId of wanted) {
    if (existing.has(storeId)) {
      result.skipped += 1;
      continue;
    }
    try {
      const id = await run((tx) => insertSettlementTx(tx, orgId, storeId, month, now));
      if (id) result.created += 1;
      else result.skipped += 1;
    } catch (error) {
      result.errors.push({ storeId, message: messageOf(error) });
    }
  }
  return result;
}

/**
 * Det schemalagda jobbet: förra månadens avräkningar i alla aktiva organisationer, som
 * systemet. Kan köras om (befintliga avräkningar lämnas orörda). Ett fel i en
 * organisation stoppar inte de andra.
 */
export async function createMonthlySettlements(
  db: Db,
  now: Date = new Date(),
  options: { readonly organizationIds?: readonly string[] } = {},
): Promise<SettlementRunResult[]> {
  const orgs = (
    await db
      .select({ id: s.organizations.id, timezone: s.organizations.timezone })
      .from(s.organizations)
      .where(isNull(s.organizations.archivedAt))
  ).filter((o) => !options.organizationIds || options.organizationIds.includes(o.id));
  const out: SettlementRunResult[] = [];
  for (const org of orgs) {
    const month = settlementMonthFor(businessToday(now, org.timezone));
    try {
      out.push(await createMissing((fn) => db.transaction(fn), org.id, month, now));
    } catch (error) {
      out.push({
        organizationId: org.id,
        month,
        created: 0,
        skipped: 0,
        errors: [{ storeId: "", message: messageOf(error) }],
      });
    }
  }
  return out;
}

/**
 * Skapar förra månadens saknade avräkningar som användaren (ägare och admin). Läsaren
 * skapar inget. Felen (per butik) visas på sidan.
 */
export async function ensureSettlementsFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<SettlementRunResult | null> {
  const role = await requireRoleFor(viewer.user, viewer.organization.id, ECONOMY_ROLES);
  if (role === "viewer") return null;
  const today = businessToday(now, viewer.organization.timezone);
  // Den 1:a kan månadens sista order ännu vara på väg från Awish: jobbet (efter synken på
  // morgonen) skapar avräkningarna. Från den 2:a skapas saknade här.
  if (today.endsWith("-01")) return null;
  const month = settlementMonthFor(today);
  return createMissing((fn) => withUserDbFor(viewer.user, fn), viewer.organization.id, month, now);
}

// ---------------------------------------------------------------------------
// Läsa
// ---------------------------------------------------------------------------

export interface SettlementRow {
  readonly id: string;
  readonly storeId: string;
  readonly storeName: string;
  readonly month: IsoMonth;
  readonly amountOre: number;
  readonly state: SettlementState;
  readonly paidOn: IsoDate | null;
  readonly computedAt: string;
  readonly statement: SettlementStatement | null;
}

function rowOf(r: {
  id: string;
  storeId: string;
  storeName: string | null;
  month: string;
  amountOre: number;
  paidOn: string | null;
  computedAt: Date;
  statement: unknown;
}): SettlementRow {
  return {
    id: r.id,
    storeId: r.storeId,
    storeName: r.storeName ?? "Okänd butik",
    month: r.month.slice(0, 7) as IsoMonth,
    amountOre: r.amountOre,
    state: settlementState(r.amountOre, r.paidOn),
    paidOn: r.paidOn as IsoDate | null,
    computedAt: r.computedAt.toISOString(),
    statement: parseStatement(r.statement),
  };
}

/** Avräkningarna de senaste `months` månaderna och alla obetalda, senaste först. */
export async function querySettlements(
  tx: Tx,
  orgId: string,
  since: IsoDate,
): Promise<SettlementRow[]> {
  const rows = await tx
    .select({
      id: s.storeSettlements.id,
      storeId: s.storeSettlements.storeId,
      storeName: s.stores.name,
      month: s.storeSettlements.month,
      amountOre: s.storeSettlements.amountOre,
      paidOn: s.storeSettlements.paidOn,
      computedAt: s.storeSettlements.computedAt,
      statement: s.storeSettlements.statement,
    })
    .from(s.storeSettlements)
    .leftJoin(
      s.stores,
      and(
        eq(s.stores.organizationId, s.storeSettlements.organizationId),
        eq(s.stores.id, s.storeSettlements.storeId),
      ),
    )
    .where(
      and(
        eq(s.storeSettlements.organizationId, orgId),
        or(gte(s.storeSettlements.month, since), isNull(s.storeSettlements.paidOn)),
      ),
    )
    .orderBy(desc(s.storeSettlements.month), s.stores.name);
  return rows.map(rowOf);
}

export interface StorePortalSummary {
  readonly storeId: string;
  readonly storeName: string;
  readonly email: string | null;
  readonly users: number;
  readonly pending: number;
}

export interface SettlementPage {
  readonly month: IsoMonth;
  readonly rows: SettlementRow[];
  /** Butiker utan avräkning för månaden och varför (bara när de inte kunde räknas). */
  readonly failed: { storeId: string; storeName: string; message: string }[];
  /** Butikerna och deras tillgång till portalen (bara för ägare och admin). */
  readonly portal: StorePortalSummary[] | null;
  readonly canEdit: boolean;
}

/** Sidan Butiker → Butiksportal. Skapar förra månadens saknade avräkningar först. */
export async function loadSettlementPageFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<SettlementPage> {
  const orgId = viewer.organization.id;
  const role = await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const canEdit = role !== "viewer";
  const run = canEdit ? await ensureSettlementsFor(viewer, now) : null;
  const today = businessToday(now, viewer.organization.timezone);
  const month = settlementMonthFor(today);
  const since: IsoDate = `${addMonths(month, -11)}-01`;
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = await querySettlements(tx, orgId, since);
    const stores = await tx
      .select({ id: s.stores.id, name: s.stores.name, email: s.stores.email })
      .from(s.stores)
      .where(and(eq(s.stores.organizationId, orgId), isNull(s.stores.archivedAt)))
      .orderBy(s.stores.name);
    const name = new Map(stores.map((x) => [x.id, x.name]));
    const failed = (run?.errors ?? []).map((e) => ({
      storeId: e.storeId,
      storeName: name.get(e.storeId) ?? "Okänd butik",
      message: e.message,
    }));
    let portal: StorePortalSummary[] | null = null;
    if (canEdit) {
      const counts = Array.from(
        await tx.execute(sql`
          select st.id as store_id,
                 (select count(*)::int from public.memberships m
                   where m.organization_id = st.organization_id and m.role = 'store'
                     and m.store_id = st.id) as users,
                 (select count(*)::int from public.invitations i
                   where i.organization_id = st.organization_id and i.role = 'store'
                     and i.store_id = st.id and i.accepted_at is null
                     and i.expires_at > now()) as pending
          from public.stores st
          where st.organization_id = ${orgId}::uuid and st.archived_at is null`),
      ) as { store_id: string; users: number; pending: number }[];
      const byStore = new Map(counts.map((c) => [String(c.store_id), c]));
      portal = stores.map((x) => ({
        storeId: x.id,
        storeName: x.name,
        email: x.email ?? null,
        users: Number(byStore.get(x.id)?.users ?? 0),
        pending: Number(byStore.get(x.id)?.pending ?? 0),
      }));
    }
    return { month, rows, failed, portal, canEdit };
  });
}

// ---------------------------------------------------------------------------
// Ändra (ägare och admin)
// ---------------------------------------------------------------------------

function requireId(id: string): string {
  if (!UUID.test(id)) throw new SettlementError("Avräkningen finns inte.");
  return id.toLowerCase();
}

/** Markerar som betald med datum (ÅÅÅÅ-MM-DD). */
export async function markSettlementPaidFor(
  viewer: Viewer,
  id: string,
  paidOn: string,
): Promise<{ storeName: string; amountOre: number }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const settlementId = requireId(id);
  if (!ISO_DATE.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`))) {
    throw new SettlementError("Välj ett datum.");
  }
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const rows = await tx
        .update(s.storeSettlements)
        .set({ paidOn })
        .where(
          and(
            eq(s.storeSettlements.organizationId, orgId),
            eq(s.storeSettlements.id, settlementId),
            isNull(s.storeSettlements.paidOn),
            sql`${s.storeSettlements.amountOre} <> 0`,
          ),
        )
        .returning({
          storeId: s.storeSettlements.storeId,
          amountOre: s.storeSettlements.amountOre,
        });
      const row = rows[0];
      if (!row) throw new SettlementError("Avräkningen är redan betald eller finns inte.");
      const [store] = await tx
        .select({ name: s.stores.name })
        .from(s.stores)
        .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, row.storeId)));
      return { storeName: store?.name ?? "butiken", amountOre: row.amountOre };
    });
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    settlementDbError(error);
  }
}

/** Ångrar "betald". */
export async function undoSettlementPaidFor(viewer: Viewer, id: string): Promise<void> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const settlementId = requireId(id);
  try {
    const rows = await withUserDbFor(viewer.user, (tx) =>
      tx
        .update(s.storeSettlements)
        .set({ paidOn: null })
        .where(
          and(
            eq(s.storeSettlements.organizationId, orgId),
            eq(s.storeSettlements.id, settlementId),
          ),
        )
        .returning({ id: s.storeSettlements.id }),
    );
    if (rows.length === 0) throw new SettlementError("Avräkningen finns inte.");
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    settlementDbError(error);
  }
}

/** Räknar om en obetald avräkning med dagens underlag. Ger det nya beloppet. */
export async function recomputeSettlementFor(
  viewer: Viewer,
  id: string,
  now: Date = new Date(),
): Promise<{ amountOre: number; previousOre: number }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const settlementId = requireId(id);
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const [row] = await tx
        .select({
          storeId: s.storeSettlements.storeId,
          month: s.storeSettlements.month,
          amountOre: s.storeSettlements.amountOre,
          paidOn: s.storeSettlements.paidOn,
        })
        .from(s.storeSettlements)
        .where(
          and(
            eq(s.storeSettlements.organizationId, orgId),
            eq(s.storeSettlements.id, settlementId),
          ),
        )
        .for("update");
      if (!row) throw new SettlementError("Avräkningen finns inte.");
      if (row.paidOn) throw new SettlementError("Avräkningen är betald och räknas inte om.");
      let c: ComputedSettlement;
      try {
        c = await computeSettlementTx(tx, {
          organizationId: orgId,
          storeId: row.storeId,
          month: row.month.slice(0, 7) as IsoMonth,
          now,
        });
      } catch (error) {
        if (error instanceof DomainError) throw new SettlementError(error.message);
        throw error;
      }
      await tx
        .update(s.storeSettlements)
        .set({
          amountOre: c.amountOre,
          statement: c.statement as unknown as Record<string, unknown>,
          calcVersion: c.calcVersion,
          computedAt: now,
        })
        .where(
          and(
            eq(s.storeSettlements.organizationId, orgId),
            eq(s.storeSettlements.id, settlementId),
          ),
        );
      return { amountOre: c.amountOre, previousOre: row.amountOre };
    });
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    settlementDbError(error);
  }
}

/** Avräkningens dokument (HTML att skriva ut) för ägare, admin och läsare. */
export async function settlementDocumentFor(
  viewer: Viewer,
  id: string,
): Promise<{ html: string; fileName: string }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const settlementId = requireId(id);
  const [row] = await withUserDbFor(viewer.user, (tx) =>
    tx
      .select({
        amountOre: s.storeSettlements.amountOre,
        paidOn: s.storeSettlements.paidOn,
        statement: s.storeSettlements.statement,
        month: s.storeSettlements.month,
      })
      .from(s.storeSettlements)
      .where(
        and(eq(s.storeSettlements.organizationId, orgId), eq(s.storeSettlements.id, settlementId)),
      ),
  );
  const statement = row ? parseStatement(row.statement) : null;
  if (!row || !statement) throw new SettlementError("Avräkningen finns inte.");
  return {
    html: settlementHtml({
      organizationName: viewer.organization.name,
      statement,
      amountOre: row.amountOre,
      paidOn: row.paidOn as IsoDate | null,
      reference: settlementId.slice(0, 8),
    }),
    fileName: settlementFileName(statement.storeName, statement.month),
  };
}
