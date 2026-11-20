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
  agreementGaps,
  DomainError,
  monthEnd,
  monthPeriod,
  monthStart,
  type IsoDate,
  type IsoMonth,
} from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { queryAgreements, queryEffectivePlacements } from "@/server/data/core/queries";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";
import { pgErrorOf } from "@/server/errors";
import { krText } from "@/reports";
import { storesPlacedIn } from "@/server/reports/sources";
import { queryOlderMissingSettlements } from "./queries";
import { queryAdvanceParts, settleCoveredTx, unpaidWithAdvancesTx } from "./advances-db";
import { advanceLine, advancesFor, advanceTotal, type AdvancePart } from "./advance";
import { closeMonthIfDoneTx, reopenAfterUndoTx, type UndoOutcome } from "@/server/periods/service";

import {
  computeSettlementsTx,
  liveFor,
  sameComputed,
  type ComputedSettlement,
  type LiveSettlement,
} from "./live";
import {
  correctionsTotal,
  paidDifference,
  paidWhichQuestion,
  parseCorrections,
  parseStatement,
  settlementFileName,
  settlementHtml,
  settlementMonthFor,
  settlementState,
  type SettlementCorrection,
  type SettlementState,
  type SettlementStatement,
} from "./model";

export class SettlementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettlementError";
  }
}

/**
 * Rapporten butiken fick säger ett annat belopp än dagens uträkning: ägaren måste välja
 * vilket som betalades innan avräkningen markeras som betald.
 */
export class PaidAmountQuestion extends SettlementError {
  constructor(
    readonly reportOre: number,
    readonly liveOre: number,
  ) {
    super(paidWhichQuestion(reportOre, liveOre));
    this.name = "PaidAmountQuestion";
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
  const placements = await queryEffectivePlacements(tx, orgId);
  return storesPlacedIn(placements, { start: monthStart(month), end: monthEnd(month) });
}

/** En butik som hade en automat men inget avtal några dagar i månaden. */
export interface SettlementAgreementGap {
  readonly storeId: string;
  readonly storeName: string;
  /** Dagar i månaden med automat utan avtal. */
  readonly days: number;
  /** Alla dagar med automat saknade avtal: avräkningen blir 0 kr. */
  readonly whole: boolean;
}

/**
 * Butikerna (av `storeIds`) som hade en automat men inget avtal någon dag i månaden, med
 * samma placeringar och avtal som avräkningen räknar med (agreementGaps i @/domain). De
 * dagarna räknas som 0 %, så sidan och knappen varnar innan avräkningen skapas.
 */
async function monthAgreementGaps(
  tx: Tx,
  orgId: string,
  month: IsoMonth,
  storeIds: readonly string[],
): Promise<Omit<SettlementAgreementGap, "storeName">[]> {
  if (storeIds.length === 0) return [];
  const [placements, agreements] = await Promise.all([
    queryEffectivePlacements(tx, orgId),
    queryAgreements(tx, orgId),
  ]);
  return agreementGaps({ placements, agreements, period: monthPeriod(month), storeIds }).map(
    (g) => ({ storeId: g.storeId, days: g.days, whole: g.days >= g.placedDays }),
  );
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
  /** Bara de här butikerna (äldre månader: de som sålde). Utelämnad = alla med automat. */
  onlyStores?: readonly string[],
): Promise<SettlementRunResult> {
  const result: SettlementRunResult = {
    organizationId: orgId,
    month,
    created: 0,
    skipped: 0,
    errors: [],
  };
  await run(async (tx) => {
    const [placed, existing] = await Promise.all([
      storesForMonth(tx, orgId, month),
      existingStores(tx, orgId, month),
    ]);
    const wanted = onlyStores ? placed.filter((id) => onlyStores.includes(id)) : placed;
    const missing = wanted.filter((id) => !existing.has(id));
    result.skipped += wanted.length - missing.length;
    const live = await computeSettlementsTx(tx, {
      organizationId: orgId,
      month,
      storeIds: missing,
      now,
    });
    const created: string[] = [];
    for (const storeId of missing) {
      const l = live.get(storeId)!;
      if (!l.ok) {
        result.errors.push({ storeId, message: l.message });
        continue;
      }
      const id = await insertSettlementTx(tx, orgId, storeId, month, l.computed, now);
      if (id) {
        result.created += 1;
        created.push(id);
      } else result.skipped += 1;
    }
    // Betalningar i förskott för månaden dras av; täcker de hela avräkningen är den betald
    // (./advance.ts). Ingen månad stängs här.
    await settleCoveredTx(tx, orgId, created, now);
  });
  return result;
}

/**
 * Skapar saknade avräkningar för äldre avslutade månader där en butik sålde (se
 * queryOlderMissingSettlements): en körning per månad, äldst först, också i stängda
 * månader. Ett fel i en butik (t.ex. saknat inköpspris) står i `errors` och stoppar inget.
 */
async function createOlderMissing(
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  orgId: string,
  beforeMonth: IsoMonth,
  now: Date,
): Promise<SettlementRunResult[]> {
  const older = await run((tx) => queryOlderMissingSettlements(tx, orgId, beforeMonth));
  const out: SettlementRunResult[] = [];
  for (const m of older) {
    out.push(await createMissing(run, orgId, m.month, now, m.storeIds));
  }
  return out;
}

/** Slår ihop körningar (flera månader) till ett svar för månaden `month`. */
function mergeRuns(
  main: SettlementRunResult,
  older: readonly SettlementRunResult[],
): SettlementRunResult & { olderMonths: IsoMonth[] } {
  const out = { ...main, errors: [...main.errors], olderMonths: [] as IsoMonth[] };
  for (const r of older) {
    out.created += r.created;
    out.skipped += r.skipped;
    out.errors.push(...r.errors);
    if (r.created > 0) out.olderMonths.push(r.month);
  }
  return out;
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
  // Förskott som nu täcker hela avräkningen (beloppet kan ha sjunkit): betald med betalningarna.
  await settleCoveredTx(tx, orgId, await unpaidWithAdvancesTx(tx, orgId), now);
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
): Promise<(SettlementRunResult & { refreshed: number; paidDiffering?: number })[]> {
  const orgs = (
    await db
      .select({ id: s.organizations.id, timezone: s.organizations.timezone })
      .from(s.organizations)
      // Demos (Demo för kunder) får inga automatiska avräkningar.
      .where(and(isNull(s.organizations.archivedAt), eq(s.organizations.isDemo, false)))
  ).filter((o) => !options.organizationIds || options.organizationIds.includes(o.id));
  const out: (SettlementRunResult & { refreshed: number; paidDiffering?: number })[] = [];
  for (const org of orgs) {
    const today = businessToday(now, org.timezone);
    const month = settlementMonthFor(today);
    const skipCreate = options.create === "not-first" && today.endsWith("-01");
    try {
      const main = skipCreate
        ? { organizationId: org.id, month, created: 0, skipped: 0, errors: [] }
        : await createMissing((fn) => db.transaction(fn), org.id, month, now);
      // Äldre månader som aldrig fick någon avräkning (kunde inte räknas i tid).
      const run = mergeRuns(
        main,
        await createOlderMissing((fn) => db.transaction(fn), org.id, month, now),
      );
      const refreshed = await db.transaction((tx) => refreshUnpaidTx(tx, org.id, now));
      // Betalda: dagens uträkning sparas bredvid det betalda beloppet (Att göra läser den).
      const paidDiffering = await db.transaction((tx) => refreshPaidLiveTx(tx, org.id, today, now));
      out.push({ ...run, refreshed, paidDiffering });
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
 * "Skapa avräkningar" på Utbetalning: förra månadens saknade avräkningar och saknade för
 * äldre månader där en butik sålde (också stängda), som användaren (ägare och admin).
 * Läsaren skapar inget. Felen (per butik) visas på sidan. Sidan i sig
 * skapar aldrig något när den öppnas; det gör det schemalagda jobbet eller den här knappen.
 *
 * Saknar en butik avtal några dagar i månaden (den räknas då som 0 % de dagarna) skapas
 * inget förrän ägaren bekräftat (`allowNoAgreement`): svaret har då `noAgreement` med
 * butikerna, och sidan frågar "Lägg in avtal först, eller skapa ändå".
 */
export async function ensureSettlementsFor(
  viewer: Viewer,
  now: Date = new Date(),
  options: { readonly allowNoAgreement?: boolean } = {},
): Promise<
  | (SettlementRunResult & { noAgreement?: SettlementAgreementGap[]; olderMonths?: IsoMonth[] })
  | null
> {
  const orgId = viewer.organization.id;
  const role = await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  if (role === "viewer") return null;
  const today = businessToday(now, viewer.organization.timezone);
  const month = settlementMonthFor(today);
  if (!options.allowNoAgreement) {
    const gaps = await withUserDbFor(viewer.user, async (tx) => {
      const [wanted, existing, older] = await Promise.all([
        storesForMonth(tx, orgId, month),
        existingStores(tx, orgId, month),
        queryOlderMissingSettlements(tx, orgId, month),
      ]);
      const found = await monthAgreementGaps(
        tx,
        orgId,
        month,
        wanted.filter((id) => !existing.has(id)),
      );
      // Äldre månader: samma varning (utan avtal räknas butiken som 0 % de dagarna).
      for (const m of older) {
        for (const g of await monthAgreementGaps(tx, orgId, m.month, m.storeIds)) {
          if (!found.some((x) => x.storeId === g.storeId)) found.push(g);
        }
      }
      if (found.length === 0) return [];
      const names = await storeNames(tx, orgId);
      return found.map((g) => ({ ...g, storeName: names.get(g.storeId) ?? "Okänd butik" }));
    });
    if (gaps.length > 0) {
      return {
        organizationId: orgId,
        month,
        created: 0,
        skipped: 0,
        errors: [],
        noAgreement: gaps,
      };
    }
  }
  const run = <T>(fn: (tx: Tx) => Promise<T>) => withUserDbFor(viewer.user, fn);
  const main = await createMissing(run, orgId, month, now);
  return mergeRuns(main, await createOlderMissing(run, orgId, month, now));
}

async function storeNames(tx: Tx, orgId: string): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: s.stores.id, name: s.stores.name })
    .from(s.stores)
    .where(eq(s.stores.organizationId, orgId));
  return new Map(rows.map((r) => [r.id, r.name]));
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
  /** Betald: beloppet som betalades (kan vara rapportens belopp). Obetald: samma som `amountOre`. */
  readonly paidOre: number;
  /**
   * Beloppet i den senast godkända butiksrapporten för samma butik och hela månaden, eller
   * null (ingen godkänd rapport för månaden).
   */
  readonly reportOre: number | null;
  /** Betald: månadens belopp med dagens underlag. null = går inte att räkna, eller obetald. */
  readonly liveOre: number | null;
  /** Betald: skillnad som redan lagts som rättelse på en senare avräkning. */
  readonly correctedOre: number;
  /**
   * Betald: dagens uträkning − betalt − redan rättat. 0 = inget att göra. Plus = butiken
   * ska ha mer.
   */
  readonly differenceOre: number;
  /** Rättelser som ligger på den här avräkningen (egna rader i uträkningen). */
  readonly corrections: readonly SettlementCorrection[];
  /** Betald med skillnad: butikens obetalda avräkning som skillnaden kan läggas på, eller null. */
  readonly carryTarget: { readonly id: string; readonly month: IsoMonth } | null;
  /**
   * Betalningar i förskott för månaden (delar av store_payments, ./advance.ts). På en
   * obetald dras de av (`leftOre`); på en betald ingår de i det som betalades.
   */
  readonly advances: readonly AdvancePart[];
  /** Summan av `advances`. */
  readonly advanceOre: number;
  /** "Redan betalt i förskott 1 701,24 kr (1–14 nov., betalt 16 nov.)", eller null. */
  readonly advanceText: string | null;
  /** Obetald: kvar att betala = beloppet − förskotten (negativt = för mycket). Betald: 0. */
  readonly leftOre: number;
  /** Betald för att betalningarna täcker den (inte "Markera som betald"). */
  readonly paidFromPayments: boolean;
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
  paidAmountOre: number | null;
  correctedOre: number;
  corrections: unknown;
  paidFromPayments?: boolean;
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
    paidOre: r.paidOn ? (r.paidAmountOre ?? r.amountOre) : r.amountOre,
    reportOre: null,
    liveOre: null,
    correctedOre: r.correctedOre,
    differenceOre: 0,
    corrections: parseCorrections(r.corrections),
    carryTarget: null,
    advances: [],
    advanceOre: 0,
    advanceText: null,
    leftOre: r.paidOn ? 0 : r.amountOre,
    paidFromPayments: r.paidFromPayments ?? false,
  };
}

/**
 * Raden med beloppet räknat nu. Obetald: beloppet som gäller nu. Betald: det låsta
 * beloppet står kvar, och dagens uträkning läggs bredvid (`liveOre`, `differenceOre`).
 */
function withLive(row: SettlementRow, live: LiveSettlement | undefined): SettlementRow {
  if (!live) return row;
  if (row.paidOn) {
    if (!live.ok) return row;
    const liveOre = live.computed.amountOre;
    return {
      ...row,
      liveOre,
      differenceOre: paidDifference({
        paidOre: row.paidOre,
        liveOre,
        correctedOre: row.correctedOre,
      }),
    };
  }
  if (!live.ok) return { ...row, blocked: live.message };
  return {
    ...row,
    amountOre: live.computed.amountOre,
    paidOre: live.computed.amountOre,
    leftOre: live.computed.amountOre,
    state: settlementState(live.computed.amountOre, null),
    statement: live.computed.statement,
  };
}

/** Förskotten för avräkningens månad: dras av på en obetald, ingår i det betalda på en betald. */
function withAdvances(row: SettlementRow, parts: readonly AdvancePart[]): SettlementRow {
  const advances = advancesFor(parts, row.storeId, row.month);
  if (advances.length === 0) return row;
  const advanceOre = advanceTotal(advances);
  return {
    ...row,
    advances,
    advanceOre,
    // På en avräkning betald för hand ingår förskottet i det betalda: ingen egen rad.
    advanceText: row.paidOn && !row.paidFromPayments ? null : advanceLine(advances),
    leftOre: row.paidOn ? 0 : row.amountOre - advanceOre,
  };
}

/**
 * Beloppet i den senast godkända butiksrapporten per butik och hel månad, nyckel
 * "butik|ÅÅÅÅ-MM". Rapporter för en annan period än hela månaden räknas inte (de går inte
 * att jämföra med en månadsavräkning).
 */
export async function approvedReportAmounts(tx: Tx, orgId: string): Promise<Map<string, number>> {
  const rows = Array.from(
    await tx.execute(sql`
      select distinct on (r.store_id, r.period_start)
             r.store_id, to_char(r.period_start, 'YYYY-MM') as month,
             r.data_snapshot #>> '{report,compensation,totalOre}' as total_ore
      from public.reports r
      join public.report_approvals a
        on a.organization_id = r.organization_id and a.report_id = r.id
      where r.organization_id = ${orgId}::uuid
        and r.kind = 'store_statement' and r.store_id is not null
        and r.period_start = date_trunc('month', r.period_start)::date
        and r.period_end = (r.period_start + interval '1 month' - interval '1 day')::date
      order by r.store_id, r.period_start, a.approved_at desc, r.generated_at desc`),
  ) as { store_id: string; month: string; total_ore: string | null }[];
  const out = new Map<string, number>();
  for (const r of rows) {
    const ore = Number(r.total_ore);
    if (r.total_ore !== null && Number.isSafeInteger(ore)) out.set(`${r.store_id}|${r.month}`, ore);
  }
  return out;
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
      paidAmountOre: s.storeSettlements.paidAmountOre,
      correctedOre: s.storeSettlements.correctedOre,
      corrections: s.storeSettlements.corrections,
      paidFromPayments: s.storeSettlements.paidFromPayments,
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
  // Obetalda räknas om för beloppet; betalda för jämförelsen "betalt mot dagens uträkning".
  const [live, reports, advances] = await Promise.all([
    liveFor(tx, orgId, out, now),
    approvedReportAmounts(tx, orgId),
    queryAdvanceParts(tx, orgId),
  ]);
  const withAmounts = out.map((r) => ({
    ...withAdvances(withLive(r, live.get(r.id)), advances),
    reportOre: reports.get(`${r.storeId}|${r.month}`) ?? null,
  }));
  // Skillnaden på en betald läggs på butikens närmast följande obetalda avräkning.
  const unpaidByStore = new Map<string, SettlementRow[]>();
  for (const r of withAmounts) {
    if (r.paidOn) continue;
    const list = unpaidByStore.get(r.storeId);
    if (list) list.push(r);
    else unpaidByStore.set(r.storeId, [r]);
  }
  return withAmounts.map((r) => {
    if (!r.paidOn || r.differenceOre === 0) return r;
    const target = carryTargetOf(r.month, unpaidByStore.get(r.storeId) ?? []);
    return target ? { ...r, carryTarget: { id: target.id, month: target.month } } : r;
  });
}

/** Den obetalda avräkning som en skillnad läggs på: närmast efter månaden, annars den äldsta. */
function carryTargetOf<T extends { month: string }>(month: string, unpaid: readonly T[]): T | null {
  const sorted = [...unpaid].sort((a, b) => a.month.localeCompare(b.month));
  return sorted.find((u) => u.month.slice(0, 7) > month) ?? sorted[0] ?? null;
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
  /**
   * Butiker utan avräkning (knappen Skapa): förra månaden (`month`) för dem som hade en
   * automat, och äldre månader för dem som sålde då.
   */
  readonly missing: { storeId: string; storeName: string; month: IsoMonth }[];
  /** Butiker utan avräkning och varför (bara när de inte kunde räknas), per månad. */
  readonly failed: { storeId: string; storeName: string; message: string; month: IsoMonth }[];
  /**
   * Butiker som hade en automat förra månaden men inget avtal några dagar (räknas som 0 %
   * de dagarna), saknad avräkning eller inte. Sidan varnar och länkar till "Lägg in avtal".
   */
  readonly noAgreement: SettlementAgreementGap[];
  /** Butikerna och deras tillgång till portalen (bara för ägare och admin). */
  readonly portal: StorePortalSummary[] | null;
  readonly canEdit: boolean;
  /** Butikerna som inte är arkiverade (valet i "Registrera betalning"). */
  readonly stores: { readonly id: string; readonly name: string }[];
}

/**
 * Sidan Butiker → Utbetalning. Läser bara: obetalda räknas om i minnet, och förra
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
    const wantedIds = await storesForMonth(tx, orgId, month);
    const missingIds = wantedIds.filter((id) => !have.has(id));
    const noAgreement = (await monthAgreementGaps(tx, orgId, month, wantedIds)).map((g) => ({
      ...g,
      storeName: name.get(g.storeId) ?? "Okänd butik",
    }));
    // Varför en saknad inte går att skapa (samma uträkning som knappen skulle göra).
    const live = await computeSettlementsTx(tx, {
      organizationId: orgId,
      month,
      storeIds: missingIds,
      now,
    });
    const missing: SettlementPage["missing"] = [];
    const failed: SettlementPage["failed"] = [];
    // Äldre månader där en butik sålde men saknar avräkning (äldst först), sedan förra månaden.
    for (const m of await queryOlderMissingSettlements(tx, orgId, month)) {
      const olderLive = await computeSettlementsTx(tx, {
        organizationId: orgId,
        month: m.month,
        storeIds: m.storeIds,
        now,
      });
      for (const storeId of m.storeIds) {
        const storeName = name.get(storeId) ?? "Okänd butik";
        const l = olderLive.get(storeId)!;
        if (l.ok) missing.push({ storeId, storeName, month: m.month });
        else failed.push({ storeId, storeName, message: l.message, month: m.month });
      }
    }
    for (const storeId of missingIds) {
      const storeName = name.get(storeId) ?? "Okänd butik";
      const l = live.get(storeId)!;
      if (l.ok) missing.push({ storeId, storeName, month });
      else failed.push({ storeId, storeName, message: l.message, month });
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
    return {
      month,
      rows,
      missing,
      failed,
      noAgreement,
      portal,
      canEdit,
      stores: stores.map((x) => ({ id: x.id, name: x.name })),
    };
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
 *
 * Är det månadens sista avräkning stängs månaden i samma transaktion (`monthClosed`):
 * därefter stoppar databasen ändringar som skulle räkna om den (BL004).
 */
export async function markSettlementPaidFor(
  viewer: Viewer,
  id: string,
  paidOn: string,
  expectedOre: number | null = null,
  now: Date = new Date(),
  /**
   * Vilket belopp som betalades när rapporten butiken fick säger ett annat än dagens
   * uträkning: "live" (dagens uträkning) eller "report" (rapportens). Utan val kastas
   * PaidAmountQuestion, så att ägaren får frågan.
   */
  paidChoice: "live" | "report" | null = null,
): Promise<{
  storeName: string;
  amountOre: number;
  month: IsoMonth;
  monthClosed: boolean;
  /** Beloppet som betalades (rapportens när ägaren valde det). */
  paidOre: number;
  /** Dagens uträkning − betalt: återstår att rätta på nästa avräkning (0 = inget). */
  differenceOre: number;
}> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const settlementId = requireId(id);
  const today = businessToday(now, viewer.organization.timezone);
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
      // Rapporten butiken fick för samma månad: säger den ett annat belopp frågar vi
      // vilket som betalades. Inget betalas på ett belopp som ägaren inte har valt.
      const reportOre =
        (await approvedReportAmounts(tx, orgId)).get(`${row.storeId}|${row.month.slice(0, 7)}`) ??
        null;
      // Rättelser som ligger på avräkningen betalas med, vilket belopp ägaren än väljer.
      const reportPayOre =
        reportOre === null || reportOre === 0 ? null : reportOre + c.correctionsOre;
      const reportDiffers = reportPayOre !== null && reportPayOre !== c.amountOre;
      if (reportDiffers && paidChoice === null) {
        throw new PaidAmountQuestion(reportPayOre!, c.amountOre);
      }
      const paidAmountOre = reportDiffers && paidChoice === "report" ? reportPayOre! : null;
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
      const rows = await tx
        .update(s.storeSettlements)
        .set({ paidOn, paidAmountOre, liveAmountOre: c.amountOre, liveCheckedAt: now })
        .where(where)
        .returning({
          storeId: s.storeSettlements.storeId,
          amountOre: s.storeSettlements.amountOre,
        });
      const paid = rows[0];
      if (!paid) throw new SettlementError("Avräkningen är redan betald eller finns inte.");
      const [store] = await tx
        .select({ name: s.stores.name })
        .from(s.stores)
        .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, paid.storeId)));
      const month = row.month.slice(0, 7) as IsoMonth;
      const monthClosed = await closeMonthIfDoneTx(tx, {
        organizationId: orgId,
        month,
        trigger: "settlement_paid",
        today,
      });
      const paidOre = paidAmountOre ?? paid.amountOre;
      return {
        storeName: store?.name ?? "butiken",
        amountOre: paid.amountOre,
        month,
        monthClosed,
        paidOre,
        differenceOre: paid.amountOre - paidOre,
      };
    });
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    settlementDbError(error);
  }
}

/**
 * Ångrar "betald". Stängdes månaden när den betalades öppnas den igen (bara ägaren kan
 * öppna; för en admin ligger månaden kvar stängd och svaret säger det).
 */
export async function undoSettlementPaidFor(
  viewer: Viewer,
  id: string,
): Promise<{ month: IsoMonth; period: UndoOutcome }> {
  const orgId = viewer.organization.id;
  const role = await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const settlementId = requireId(id);
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const [current] = await tx
        .select({ fromPayments: s.storeSettlements.paidFromPayments })
        .from(s.storeSettlements)
        .where(
          and(
            eq(s.storeSettlements.organizationId, orgId),
            eq(s.storeSettlements.id, settlementId),
          ),
        );
      if (current?.fromPayments) {
        throw new SettlementError(
          "Avräkningen är betald med betalningarna. Ta bort betalningen under Betalningar för att ångra.",
        );
      }
      const rows = await tx
        .update(s.storeSettlements)
        .set({ paidOn: null })
        .where(
          and(
            eq(s.storeSettlements.organizationId, orgId),
            eq(s.storeSettlements.id, settlementId),
          ),
        )
        .returning({ id: s.storeSettlements.id, month: s.storeSettlements.month });
      const row = rows[0];
      if (!row) throw new SettlementError("Avräkningen finns inte.");
      const month = row.month.slice(0, 7) as IsoMonth;
      const period = await reopenAfterUndoTx(tx, {
        organizationId: orgId,
        month,
        role,
        reason: "Ångrade betald avräkning",
      });
      return { month, period };
    });
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    settlementDbError(error);
  }
}

/** Sparar avräkningens belopp och uträkning räknade nu (med rättelserna på den). */
async function storeLiveTx(
  tx: Tx,
  orgId: string,
  row: { id: string; storeId: string; month: string },
  now: Date,
): Promise<number> {
  const live = (await liveFor(tx, orgId, [row], now)).get(row.id)!;
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
        eq(s.storeSettlements.id, row.id),
        isNull(s.storeSettlements.paidOn),
      ),
    );
  return c.amountOre;
}

/**
 * "Lägg på nästa avräkning": skillnaden mellan det som betalades och dagens uträkning för
 * en betald avräkning läggs som en egen rad ("Rättelse för oktober 2026") på butikens
 * närmast följande obetalda avräkning. Aldrig av sig själv: bara när ägaren eller admin
 * trycker. `expectedOre` är skillnaden hen såg; har den ändrats görs inget.
 */
export async function carryDifferenceFor(
  viewer: Viewer,
  id: string,
  expectedOre: number,
  now: Date = new Date(),
): Promise<{ storeName: string; amountOre: number; targetMonth: IsoMonth }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const sourceId = requireId(id);
  if (!Number.isSafeInteger(expectedOre)) throw new SettlementError("Ogiltigt belopp.");
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const settlements = await tx
        .select({
          id: s.storeSettlements.id,
          storeId: s.storeSettlements.storeId,
          month: s.storeSettlements.month,
          amountOre: s.storeSettlements.amountOre,
          paidOn: s.storeSettlements.paidOn,
          paidAmountOre: s.storeSettlements.paidAmountOre,
          correctedOre: s.storeSettlements.correctedOre,
          corrections: s.storeSettlements.corrections,
        })
        .from(s.storeSettlements)
        .where(eq(s.storeSettlements.organizationId, orgId))
        .for("update");
      const source = settlements.find((r) => r.id === sourceId);
      if (!source || !source.paidOn) {
        throw new SettlementError("Avräkningen är inte betald eller finns inte.");
      }
      const live = (await liveFor(tx, orgId, [source], now)).get(sourceId)!;
      if (!live.ok) throw new SettlementError(`Kan inte räknas nu. ${live.message}`);
      const paidOre = source.paidAmountOre ?? source.amountOre;
      const liveOre = live.computed.amountOre;
      const difference = paidDifference({ paidOre, liveOre, correctedOre: source.correctedOre });
      if (difference === 0) throw new SettlementError("Det finns ingen skillnad att lägga till.");
      if (difference !== expectedOre) {
        throw new SettlementError(
          `Skillnaden har ändrats till ${krText(Math.abs(difference))}. Kontrollera och försök igen.`,
        );
      }
      const target = carryTargetOf(
        source.month.slice(0, 7),
        settlements.filter((r) => r.storeId === source.storeId && !r.paidOn),
      );
      if (!target) {
        throw new SettlementError(
          "Butiken har ingen obetald avräkning än. Nästa skapas den 1:a. Lägg till skillnaden då.",
        );
      }
      const correction: SettlementCorrection = {
        sourceId,
        month: source.month.slice(0, 7) as IsoMonth,
        amountOre: difference,
        paidOre: paidOre + source.correctedOre,
        liveOre,
        at: now.toISOString(),
        by: viewer.user.userId,
      };
      const corrections = [...parseCorrections(target.corrections), correction];
      await tx
        .update(s.storeSettlements)
        .set({ corrections })
        .where(
          and(
            eq(s.storeSettlements.organizationId, orgId),
            eq(s.storeSettlements.id, target.id),
            isNull(s.storeSettlements.paidOn),
          ),
        );
      // Målets belopp och uträkning sparas med den nya raden (det butiken ser i portalen).
      await storeLiveTx(tx, orgId, target, now);
      await tx
        .update(s.storeSettlements)
        .set({
          correctedOre: source.correctedOre + difference,
          liveAmountOre: liveOre,
          liveCheckedAt: now,
        })
        .where(
          and(eq(s.storeSettlements.organizationId, orgId), eq(s.storeSettlements.id, sourceId)),
        );
      const [store] = await tx
        .select({ name: s.stores.name })
        .from(s.stores)
        .where(and(eq(s.stores.organizationId, orgId), eq(s.stores.id, source.storeId)));
      return {
        storeName: store?.name ?? "butiken",
        amountOre: difference,
        targetMonth: target.month.slice(0, 7) as IsoMonth,
      };
    });
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    settlementDbError(error);
  }
}

/**
 * "Ta bort rättelsen" på en obetald avräkning: raden försvinner, beloppet räknas om och
 * skillnaden står åter som olöst på den betalda avräkningen. Ägare och admin.
 */
export async function removeCorrectionFor(
  viewer: Viewer,
  targetIdRaw: string,
  sourceIdRaw: string,
  now: Date = new Date(),
): Promise<{ removedOre: number }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const targetId = requireId(targetIdRaw);
  const sourceId = requireId(sourceIdRaw);
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const rows = await tx
        .select({
          id: s.storeSettlements.id,
          storeId: s.storeSettlements.storeId,
          month: s.storeSettlements.month,
          paidOn: s.storeSettlements.paidOn,
          correctedOre: s.storeSettlements.correctedOre,
          corrections: s.storeSettlements.corrections,
        })
        .from(s.storeSettlements)
        .where(
          and(
            eq(s.storeSettlements.organizationId, orgId),
            or(eq(s.storeSettlements.id, targetId), eq(s.storeSettlements.id, sourceId)),
          ),
        )
        .for("update");
      const target = rows.find((r) => r.id === targetId);
      const source = rows.find((r) => r.id === sourceId);
      if (!target || !source) throw new SettlementError("Avräkningen finns inte.");
      if (target.paidOn) throw new SettlementError("Avräkningen är betald och ändras inte.");
      const all = parseCorrections(target.corrections);
      const removed = all.filter((c) => c.sourceId === sourceId);
      if (removed.length === 0) throw new SettlementError("Rättelsen finns inte.");
      const removedOre = correctionsTotal(removed);
      await tx
        .update(s.storeSettlements)
        .set({ corrections: all.filter((c) => c.sourceId !== sourceId) })
        .where(
          and(eq(s.storeSettlements.organizationId, orgId), eq(s.storeSettlements.id, targetId)),
        );
      await storeLiveTx(tx, orgId, target, now);
      await tx
        .update(s.storeSettlements)
        .set({ correctedOre: source.correctedOre - removedOre })
        .where(
          and(eq(s.storeSettlements.organizationId, orgId), eq(s.storeSettlements.id, sourceId)),
        );
      return { removedOre };
    });
  } catch (error) {
    if (error instanceof SettlementError) throw error;
    settlementDbError(error);
  }
}

/** Månader bakåt som betalda avräkningar räknas om för jämförelsen (nattliga jobbet). */
export const PAID_CHECK_MONTHS = 12;

/**
 * Räknar månadens belopp med dagens underlag för organisationens betalda avräkningar (de
 * senaste PAID_CHECK_MONTHS månaderna) och sparar det (live_amount_ore). Att göra läser
 * det sparade: "Betald avräkning skiljer sig från dagens uträkning". Det betalda beloppet
 * rörs aldrig. Ger antalet betalda avräkningar med en olöst skillnad.
 */
export async function refreshPaidLiveTx(
  tx: Tx,
  orgId: string,
  today: IsoDate,
  now: Date,
): Promise<number> {
  const since = `${addMonths(today.slice(0, 7) as IsoMonth, -PAID_CHECK_MONTHS)}-01`;
  const paid = await tx
    .select({
      id: s.storeSettlements.id,
      storeId: s.storeSettlements.storeId,
      month: s.storeSettlements.month,
      amountOre: s.storeSettlements.amountOre,
      paidAmountOre: s.storeSettlements.paidAmountOre,
      correctedOre: s.storeSettlements.correctedOre,
      liveAmountOre: s.storeSettlements.liveAmountOre,
    })
    .from(s.storeSettlements)
    .where(
      and(
        eq(s.storeSettlements.organizationId, orgId),
        gte(s.storeSettlements.month, since),
        sql`${s.storeSettlements.paidOn} is not null`,
      ),
    );
  const live = await liveFor(tx, orgId, paid, now);
  let differing = 0;
  for (const r of paid) {
    const l = live.get(r.id);
    if (!l || !l.ok) continue;
    const liveOre = l.computed.amountOre;
    const paidOre = r.paidAmountOre ?? r.amountOre;
    if (paidDifference({ paidOre, liveOre, correctedOre: r.correctedOre }) !== 0) differing += 1;
    if (r.liveAmountOre === liveOre) continue;
    await tx
      .update(s.storeSettlements)
      .set({ liveAmountOre: liveOre, liveCheckedAt: now })
      .where(and(eq(s.storeSettlements.organizationId, orgId), eq(s.storeSettlements.id, r.id)));
  }
  return differing;
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
