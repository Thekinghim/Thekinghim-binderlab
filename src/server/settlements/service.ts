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
import { krText } from "@/reports";
import { storesPlacedIn } from "@/server/reports/sources";

import {
  computeSettlementsTx,
  liveFor,
  sameComputed,
  type ComputedSettlement,
  type LiveSettlement,
} from "./live";
import {
  parseStatement,
  settlementFileName,
  settlementHtml,
  settlementMonthFor,
  settlementState,
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

/** Räknar butikens avräkning för månaden (samma underlag som månadsrapporten). */
export async function computeSettlementTx(
  tx: Tx,
  input: { organizationId: string; storeId: string; month: IsoMonth; now: Date },
): Promise<ComputedSettlement> {
  const live = (await computeSettlementsTx(tx, { ...input, storeIds: [input.storeId] })).get(
    input.storeId,
  )!;
  if (!live.ok) throw new DomainError("invalid_input", live.message);
  return live.computed;
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
  c: ComputedSettlement,
  now: Date,
): Promise<string | null> {
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

/** Skapar månadens saknade avräkningar i transaktionen `run` (en laddning av underlaget). */
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
  await run(async (tx) => {
    const [wanted, existing] = await Promise.all([
      storesForMonth(tx, orgId, month),
      existingStores(tx, orgId, month),
    ]);
    const missing = wanted.filter((id) => !existing.has(id));
    result.skipped += wanted.length - missing.length;
    const live = await computeSettlementsTx(tx, {
      organizationId: orgId,
      month,
      storeIds: missing,
      now,
    });
    for (const storeId of missing) {
      const l = live.get(storeId)!;
      if (!l.ok) {
        result.errors.push({ storeId, message: l.message });
        continue;
      }
      const id = await insertSettlementTx(tx, orgId, storeId, month, l.computed, now);
      if (id) result.created += 1;
      else result.skipped += 1;
    }
  });
  return result;
}

/**
 * Räknar om organisationens obetalda avräkningar och sparar de som har ändrats (belopp
 * eller uträkning). En avräkning som inte går att räkna (t.ex. saknat inköpspris) lämnas
 * som den är; den syns som spärrad på sidan. Betalda rörs aldrig (databasen låser dem).
 * Ger antalet uppdaterade.
 */
async function refreshUnpaidTx(tx: Tx, orgId: string, now: Date): Promise<number> {
  const unpaid = await tx
    .select({
      id: s.storeSettlements.id,
      storeId: s.storeSettlements.storeId,
      month: s.storeSettlements.month,
      amountOre: s.storeSettlements.amountOre,
      statement: s.storeSettlements.statement,
    })
    .from(s.storeSettlements)
    .where(and(eq(s.storeSettlements.organizationId, orgId), isNull(s.storeSettlements.paidOn)))
    .for("update");
  const live = await liveFor(tx, orgId, unpaid, now);
  let updated = 0;
  for (const r of unpaid) {
    const l = live.get(r.id);
    if (!l || !l.ok || sameComputed(r, l.computed)) continue;
    await tx
      .update(s.storeSettlements)
      .set({
        amountOre: l.computed.amountOre,
        statement: l.computed.statement as unknown as Record<string, unknown>,
        calcVersion: l.computed.calcVersion,
        computedAt: now,
      })
      .where(
        and(
          eq(s.storeSettlements.organizationId, orgId),
          eq(s.storeSettlements.id, r.id),
          isNull(s.storeSettlements.paidOn),
        ),
      );
    updated += 1;
  }
  return updated;
}

/**
 * Det schemalagda jobbet: förra månadens saknade avräkningar i alla aktiva organisationer,
 * som systemet, och omräkning av alla obetalda (så att butiken i portalen ser samma belopp
 * som ägaren). Körs den 1:a (rapportjobbet) och varje dag (larmjobbet). Kan köras om
 * (befintliga avräkningar lämnas, oförändrade belopp skrivs inte). Ett fel i en
 * organisation stoppar inte de andra. Den 1:a skapar bara rapportjobbet nya (månadens
 * sista order kan vara på väg); `create: "not-first"` hoppar då över skapandet.
 */
export async function createMonthlySettlements(
  db: Db,
  now: Date = new Date(),
  options: {
    readonly organizationIds?: readonly string[];
    readonly create?: "always" | "not-first";
  } = {},
): Promise<(SettlementRunResult & { refreshed: number })[]> {
  const orgs = (
    await db
      .select({ id: s.organizations.id, timezone: s.organizations.timezone })
      .from(s.organizations)
      .where(isNull(s.organizations.archivedAt))
  ).filter((o) => !options.organizationIds || options.organizationIds.includes(o.id));
  const out: (SettlementRunResult & { refreshed: number })[] = [];
  for (const org of orgs) {
    const today = businessToday(now, org.timezone);
    const month = settlementMonthFor(today);
    const skipCreate = options.create === "not-first" && today.endsWith("-01");
    try {
      const run = skipCreate
        ? { organizationId: org.id, month, created: 0, skipped: 0, errors: [] }
        : await createMissing((fn) => db.transaction(fn), org.id, month, now);
      const refreshed = await db.transaction((tx) => refreshUnpaidTx(tx, org.id, now));
      out.push({ ...run, refreshed });
    } catch (error) {
      out.push({
        organizationId: org.id,
        month,
        created: 0,
        skipped: 0,
        refreshed: 0,
        errors: [{ storeId: "", message: messageOf(error) }],
      });
    }
  }
  return out;
}

/**
 * "Skapa avräkningar" på Butiksportal: förra månadens saknade avräkningar, som användaren
 * (ägare och admin). Läsaren skapar inget. Felen (per butik) visas på sidan. Sidan i sig
 * skapar aldrig något när den öppnas; det gör det schemalagda jobbet eller den här knappen.
 */
export async function ensureSettlementsFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<SettlementRunResult | null> {
  const role = await requireRoleFor(viewer.user, viewer.organization.id, ECONOMY_ROLES);
  if (role === "viewer") return null;
  const today = businessToday(now, viewer.organization.timezone);
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
  /**
   * Beloppet: för en obetald det som gäller NU (räknat om med dagens underlag), för en
   * betald det som låstes när den betalades.
   */
  readonly amountOre: number;
  readonly state: SettlementState;
  readonly paidOn: IsoDate | null;
  readonly computedAt: string;
  readonly statement: SettlementStatement | null;
  /** Det sparade beloppet (skiljer sig från `amountOre` när underlaget ändrats sedan). */
  readonly storedAmountOre: number;
  /**
   * Varför en obetald inte kan räknas nu (t.ex. saknat inköpspris), annars null. Då kan
   * den inte markeras som betald.
   */
  readonly blocked: string | null;
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
    storedAmountOre: r.amountOre,
    blocked: null,
  };
}

/** En obetald rad med beloppet räknat nu (betalda lämnas som de är). */
function withLive(row: SettlementRow, live: LiveSettlement | undefined): SettlementRow {
  if (row.paidOn || !live) return row;
  if (!live.ok) return { ...row, blocked: live.message };
  return {
    ...row,
    amountOre: live.computed.amountOre,
    state: settlementState(live.computed.amountOre, null),
    statement: live.computed.statement,
  };
}

/**
 * Avräkningarna sedan `since` och alla obetalda, senaste först. Obetalda räknas om med
 * dagens underlag (inköpspriser, testköp, avtal, sena order), så att beloppet alltid är
 * detsamma som i rapporten och bokföringen. Inget sparas här.
 */
export async function querySettlements(
  tx: Tx,
  orgId: string,
  since: IsoDate,
  now: Date = new Date(),
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
  const out = rows.map(rowOf);
  const live = await liveFor(
    tx,
    orgId,
    out.filter((r) => !r.paidOn),
    now,
  );
  return out.map((r) => withLive(r, live.get(r.id)));
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
  /** Butiker som hade en automat förra månaden men saknar avräkning (knappen Skapa). */
  readonly missing: { storeId: string; storeName: string }[];
  /** Butiker utan avräkning för månaden och varför (bara när de inte kunde räknas). */
  readonly failed: { storeId: string; storeName: string; message: string }[];
  /** Butikerna och deras tillgång till portalen (bara för ägare och admin). */
  readonly portal: StorePortalSummary[] | null;
  readonly canEdit: boolean;
}

/**
 * Sidan Butiker → Butiksportal. Läser bara: obetalda räknas om i minnet, och förra
 * månadens saknade avräkningar visas som "saknas" (skapas av jobbet eller knappen).
 */
export async function loadSettlementPageFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<SettlementPage> {
  const orgId = viewer.organization.id;
  const role = await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const canEdit = role !== "viewer";
  const today = businessToday(now, viewer.organization.timezone);
  const month = settlementMonthFor(today);
  const since: IsoDate = `${addMonths(month, -11)}-01`;
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = await querySettlements(tx, orgId, since, now);
    const stores = await tx
      .select({ id: s.stores.id, name: s.stores.name, email: s.stores.email })
      .from(s.stores)
      .where(and(eq(s.stores.organizationId, orgId), isNull(s.stores.archivedAt)))
      .orderBy(s.stores.name);
    const name = new Map(stores.map((x) => [x.id, x.name]));
    const have = new Set(rows.filter((r) => r.month === month).map((r) => r.storeId));
    const missingIds = (await storesForMonth(tx, orgId, month)).filter((id) => !have.has(id));
    // Varför en saknad inte går att skapa (samma uträkning som knappen skulle göra).
    const live = await computeSettlementsTx(tx, {
      organizationId: orgId,
      month,
      storeIds: missingIds,
      now,
    });
    const missing: SettlementPage["missing"] = [];
    const failed: SettlementPage["failed"] = [];
    for (const storeId of missingIds) {
      const storeName = name.get(storeId) ?? "Okänd butik";
      const l = live.get(storeId)!;
      if (l.ok) missing.push({ storeId, storeName });
      else failed.push({ storeId, storeName, message: l.message });
    }
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
    return { month, rows, missing, failed, portal, canEdit };
  });
}

// ---------------------------------------------------------------------------
// Ändra (ägare och admin)
// ---------------------------------------------------------------------------

function requireId(id: string): string {
  if (!UUID.test(id)) throw new SettlementError("Avräkningen finns inte.");
  return id.toLowerCase();
}

/**
 * Markerar som betald med datum (ÅÅÅÅ-MM-DD). Beloppet räknas om i samma transaktion och
 * låses som det är NU: går avräkningen inte att räkna (t.ex. saknat inköpspris) kan den
 * inte betalas, och har beloppet ändrats sedan ägaren såg det (`expectedOre`) får hen
 * se det nya först. Så betalas aldrig ett gammalt belopp.
 */
export async function markSettlementPaidFor(
  viewer: Viewer,
  id: string,
  paidOn: string,
  expectedOre: number | null = null,
  now: Date = new Date(),
): Promise<{ storeName: string; amountOre: number }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const settlementId = requireId(id);
  if (!ISO_DATE.test(paidOn) || Number.isNaN(Date.parse(`${paidOn}T00:00:00Z`))) {
    throw new SettlementError("Välj ett datum.");
  }
  if (expectedOre !== null && !Number.isSafeInteger(expectedOre)) {
    throw new SettlementError("Ogiltigt belopp.");
  }
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const [row] = await tx
        .select({
          storeId: s.storeSettlements.storeId,
          month: s.storeSettlements.month,
          amountOre: s.storeSettlements.amountOre,
          statement: s.storeSettlements.statement,
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
      if (!row || row.paidOn) {
        throw new SettlementError("Avräkningen är redan betald eller finns inte.");
      }
      const live = (await liveFor(tx, orgId, [{ id: settlementId, ...row }], now)).get(
        settlementId,
      )!;
      if (!live.ok) throw new SettlementError(`Kan inte betalas än. ${live.message}`);
      const c = live.computed;
      if (expectedOre !== null && c.amountOre !== expectedOre) {
        throw new SettlementError(
          `Beloppet har ändrats till ${krText(c.amountOre)}. Kontrollera och försök igen.`,
        );
      }
      if (c.amountOre === 0) throw new SettlementError("Inget att betala för månaden.");
      const where = and(
        eq(s.storeSettlements.organizationId, orgId),
        eq(s.storeSettlements.id, settlementId),
        isNull(s.storeSettlements.paidOn),
      );
      if (!sameComputed(row, c)) {
        await tx
          .update(s.storeSettlements)
          .set({
            amountOre: c.amountOre,
            statement: c.statement as unknown as Record<string, unknown>,
            calcVersion: c.calcVersion,
            computedAt: now,
          })
          .where(where);
      }
      const rows = await tx.update(s.storeSettlements).set({ paidOn }).where(where).returning({
        storeId: s.storeSettlements.storeId,
        amountOre: s.storeSettlements.amountOre,
      });
      const paid = rows[0];
      if (!paid) throw new SettlementError("Avräkningen är redan betald eller finns inte.");
      const [store] = await tx
        .select({ name: s.stores.name })
        .from(s.stores)
        .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, paid.storeId)));
      return { storeName: store?.name ?? "butiken", amountOre: paid.amountOre };
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
      const live = (await liveFor(tx, orgId, [{ id: settlementId, ...row }], now)).get(
        settlementId,
      )!;
      if (!live.ok) throw new SettlementError(live.message);
      const c = live.computed;
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

/**
 * Avräkningens dokument (HTML att skriva ut) för ägare, admin och läsare. En obetald visas
 * med beloppet som gäller nu (samma som på sidan); går den inte att räkna visas det sparade
 * med en rad om varför.
 */
export async function settlementDocumentFor(
  viewer: Viewer,
  id: string,
  now: Date = new Date(),
): Promise<{ html: string; fileName: string }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const settlementId = requireId(id);
  const found = await withUserDbFor(viewer.user, async (tx) => {
    const [row] = await tx
      .select({
        storeId: s.storeSettlements.storeId,
        amountOre: s.storeSettlements.amountOre,
        paidOn: s.storeSettlements.paidOn,
        statement: s.storeSettlements.statement,
        month: s.storeSettlements.month,
      })
      .from(s.storeSettlements)
      .where(
        and(eq(s.storeSettlements.organizationId, orgId), eq(s.storeSettlements.id, settlementId)),
      );
    if (!row) return null;
    const live = row.paidOn
      ? undefined
      : (await liveFor(tx, orgId, [{ id: settlementId, ...row }], now)).get(settlementId);
    return { row, live };
  });
  const statement = found ? parseStatement(found.row.statement) : null;
  if (!found || !statement) throw new SettlementError("Avräkningen finns inte.");
  const live = found.live;
  return {
    html: settlementHtml({
      organizationName: viewer.organization.name,
      statement: live?.ok ? live.computed.statement : statement,
      amountOre: live?.ok ? live.computed.amountOre : found.row.amountOre,
      paidOn: found.row.paidOn as IsoDate | null,
      reference: settlementId.slice(0, 8),
      blocked: live && !live.ok ? live.message : null,
    }),
    fileName: settlementFileName(statement.storeName, statement.month),
  };
}

export { computeSettlementsTx, type ComputedSettlement, type LiveSettlement } from "./live";
