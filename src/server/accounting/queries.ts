/**
 * Frågorna bakom ekonomiområdet. Varje funktion tar en transaktion som redan kör som
 * användaren (withUserDbFor, alltså med RLS) och organisationens id. Ingen kontrollerar
 * roller; det gör ./service.ts innan den anropar dem. Ingen ekonomilogik: frågorna hämtar
 * och formar rader, beräkningarna görs i @/domain, @/analytics och @/reports.
 */

import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import type { DeviationResolution, Payout } from "@/analytics/reconciliation";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { FixedCostCategory, FixedCostIntervalDb } from "@/db/schema";
import type { IsoDate, Period } from "@/domain";
import type { LedgerAccount } from "@/reports";

/** En utbetalning som den står i databasen. */
export interface PayoutRecord {
  readonly id: string;
  readonly reference: string;
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  readonly paidOn: IsoDate | null;
  readonly amountOre: number;
  readonly feesOre: number;
  readonly refundsOre: number | null;
  readonly lineCount: number;
  readonly importId: string | null;
  readonly dataSourceId: string | null;
  readonly createdAt: string;
}

/** Utbetalningar (ej arkiverade) vars period överlappar `range`, äldst först. */
export async function queryPayouts(
  tx: Tx,
  orgId: string,
  range: Period | null,
): Promise<PayoutRecord[]> {
  const conditions = [eq(s.payouts.organizationId, orgId), isNull(s.payouts.archivedAt)];
  if (range) {
    conditions.push(lte(s.payouts.periodStart, range.end), gte(s.payouts.periodEnd, range.start));
  }
  const rows = await tx
    .select({
      id: s.payouts.id,
      reference: s.payouts.reference,
      periodStart: s.payouts.periodStart,
      periodEnd: s.payouts.periodEnd,
      paidOn: s.payouts.paidOn,
      amountOre: s.payouts.amountOre,
      feesOre: s.payouts.feesOre,
      refundsOre: s.payouts.refundsOre,
      importId: s.payouts.importId,
      dataSourceId: s.payouts.dataSourceId,
      createdAt: s.payouts.createdAt,
      lineCount: sql<number>`(select count(*)::int from public.payout_lines pl
        where pl.organization_id = "payouts"."organization_id" and pl.payout_id = "payouts"."id")`,
    })
    .from(s.payouts)
    .where(and(...conditions))
    .orderBy(asc(s.payouts.periodStart), asc(s.payouts.createdAt), asc(s.payouts.id));
  return rows.map((r) => ({
    ...r,
    lineCount: Number(r.lineCount),
    createdAt: r.createdAt.toISOString(),
  }));
}

/** Specifikationsraderna för utbetalningarna, per utbetalnings-id. */
export async function queryPayoutLines(
  tx: Tx,
  orgId: string,
  payoutIds: readonly string[],
): Promise<Map<string, { externalId: string; amountOre: number }[]>> {
  const out = new Map<string, { externalId: string; amountOre: number }[]>();
  if (payoutIds.length === 0) return out;
  const rows = await tx
    .select({
      payoutId: s.payoutLines.payoutId,
      externalId: s.payoutLines.externalId,
      amountOre: s.payoutLines.amountOre,
    })
    .from(s.payoutLines)
    .where(
      and(eq(s.payoutLines.organizationId, orgId), inArray(s.payoutLines.payoutId, [...payoutIds])),
    )
    .orderBy(asc(s.payoutLines.payoutId), asc(s.payoutLines.externalId));
  for (const r of rows) {
    const list = out.get(r.payoutId) ?? [];
    list.push({ externalId: r.externalId, amountOre: r.amountOre });
    out.set(r.payoutId, list);
  }
  return out;
}

/** Utbetalningarna i den form avstämningen vill ha. */
export function toAnalyticsPayouts(
  records: readonly PayoutRecord[],
  lines: Map<string, { externalId: string; amountOre: number }[]>,
): Payout[] {
  return records.map((r) => ({
    reference: r.reference,
    period: { start: r.periodStart, end: r.periodEnd },
    amountOre: r.amountOre,
    feesOre: r.feesOre,
    ...(r.refundsOre === null ? {} : { refundsOre: r.refundsOre }),
    paidOn: r.paidOn,
    ...(lines.has(r.id) ? { lines: lines.get(r.id)! } : {}),
  }));
}

/** En rad i loggen över utredda avvikelser. */
export interface ReviewRecord {
  readonly id: string;
  readonly deviationKey: string;
  readonly fingerprint: string | null;
  readonly action: "investigated" | "reopened";
  readonly note: string | null;
  readonly createdAt: string;
  readonly actor: string | null;
}

export async function queryReviews(tx: Tx, orgId: string): Promise<ReviewRecord[]> {
  const rows = await tx
    .select({
      id: s.deviationReviews.id,
      deviationKey: s.deviationReviews.deviationKey,
      fingerprint: s.deviationReviews.fingerprint,
      action: s.deviationReviews.action,
      note: s.deviationReviews.note,
      createdAt: s.deviationReviews.createdAt,
      createdBy: s.deviationReviews.createdBy,
    })
    .from(s.deviationReviews)
    .where(eq(s.deviationReviews.organizationId, orgId))
    .orderBy(desc(s.deviationReviews.createdAt), desc(s.deviationReviews.id))
    .limit(500);
  const names = await queryActorNames(
    tx,
    orgId,
    rows.flatMap((r) => (r.createdBy ? [r.createdBy] : [])),
  );
  return rows.map((r) => ({
    id: r.id,
    deviationKey: r.deviationKey,
    fingerprint: r.fingerprint,
    action: r.action,
    note: r.note,
    createdAt: r.createdAt.toISOString(),
    actor: r.createdBy ? (names.get(r.createdBy) ?? "Borttagen användare") : null,
  }));
}

/** Gällande utredningar: senaste raden per nyckel, om den är "utredd". */
export function activeResolutions(reviews: readonly ReviewRecord[]): DeviationResolution[] {
  const seen = new Set<string>();
  const out: DeviationResolution[] = [];
  for (const r of reviews) {
    if (seen.has(r.deviationKey)) continue;
    seen.add(r.deviationKey);
    if (r.action !== "investigated" || !r.note) continue;
    out.push({
      key: r.deviationKey,
      ...(r.fingerprint ? { fingerprint: r.fingerprint } : {}),
      note: r.note,
      resolvedBy: r.actor,
      resolvedAt: r.createdAt,
    });
  }
  return out;
}

/** Visningsnamn (profil, annars e-post) för användare i organisationen. */
export async function queryActorNames(
  tx: Tx,
  orgId: string,
  userIds: readonly string[],
): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)];
  const out = new Map<string, string>();
  if (ids.length === 0) return out;
  const rows = await tx
    .select({ userId: s.profiles.userId, displayName: s.profiles.displayName })
    .from(s.profiles)
    .where(
      and(
        eq(s.profiles.organizationId, orgId),
        inArray(s.profiles.userId, ids),
        isNull(s.profiles.anonymizedAt),
      ),
    );
  for (const r of rows) {
    const name = r.displayName?.trim();
    if (r.userId && name) out.set(r.userId, name);
  }
  return out;
}

export interface PayoutImportRecord {
  readonly id: string;
  readonly fileName: string;
  readonly format: "payouts" | "lines";
  readonly rowsTotal: number;
  readonly rowsNew: number;
  readonly rowsDuplicate: number;
  readonly rowsConflict: number;
  readonly rowsError: number;
  readonly messages: string[];
  readonly createdAt: string;
  readonly actor: string | null;
}

export async function queryPayoutImports(tx: Tx, orgId: string): Promise<PayoutImportRecord[]> {
  const rows = await tx
    .select()
    .from(s.payoutImports)
    .where(eq(s.payoutImports.organizationId, orgId))
    .orderBy(desc(s.payoutImports.createdAt))
    .limit(20);
  const names = await queryActorNames(
    tx,
    orgId,
    rows.flatMap((r) => (r.createdBy ? [r.createdBy] : [])),
  );
  return rows.map((r) => ({
    id: r.id,
    fileName: r.fileName,
    format: r.format,
    rowsTotal: r.rowsTotal,
    rowsNew: r.rowsNew,
    rowsDuplicate: r.rowsDuplicate,
    rowsConflict: r.rowsConflict,
    rowsError: r.rowsError,
    messages: r.messages,
    createdAt: r.createdAt.toISOString(),
    actor: r.createdBy ? (names.get(r.createdBy) ?? "Borttagen användare") : null,
  }));
}

/** Leverantörens tidszon: den första aktiva datakällan (Awish). */
export async function queryProviderSource(
  tx: Tx,
  orgId: string,
): Promise<{ id: string; timeZone: string } | null> {
  const rows = await tx
    .select({ id: s.dataSources.id, timeZone: s.dataSources.sourceTimezone })
    .from(s.dataSources)
    .where(and(eq(s.dataSources.organizationId, orgId), isNull(s.dataSources.archivedAt)))
    .orderBy(asc(s.dataSources.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function queryLedgerAccounts(tx: Tx, orgId: string): Promise<LedgerAccount[]> {
  const rows = await tx
    .select({
      key: s.ledgerAccounts.key,
      account: s.ledgerAccounts.basAccount,
      name: s.ledgerAccounts.name,
    })
    .from(s.ledgerAccounts)
    .where(eq(s.ledgerAccounts.organizationId, orgId))
    .orderBy(asc(s.ledgerAccounts.basAccount));
  return rows;
}

/** En fast kostnad som den står i databasen. */
export interface FixedCostRecord {
  readonly id: string;
  readonly name: string;
  readonly category: FixedCostCategory;
  readonly amountOre: number;
  readonly interval: FixedCostIntervalDb;
  readonly startsOn: IsoDate;
  readonly endsOn: IsoDate | null;
  readonly machineId: string | null;
  readonly note: string | null;
  readonly archived: boolean;
  readonly updatedAt: string;
}

export async function queryFixedCosts(tx: Tx, orgId: string): Promise<FixedCostRecord[]> {
  const rows = await tx
    .select()
    .from(s.fixedCosts)
    .where(eq(s.fixedCosts.organizationId, orgId))
    .orderBy(asc(s.fixedCosts.name), asc(s.fixedCosts.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    category: r.category,
    amountOre: r.amountOre,
    interval: r.interval,
    startsOn: r.startsOn,
    endsOn: r.endsOn,
    machineId: r.machineId,
    note: r.note,
    archived: r.archivedAt !== null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Ett inköp för kassaflödet: inköpsorder med summan av raderna. */
export interface PurchaseRecord {
  readonly id: string;
  readonly supplier: string | null;
  readonly status: string;
  readonly date: IsoDate | null;
  readonly amountOre: number;
}

/**
 * Inköpsorder som inte är makulerade eller utkast, med radernas summa (antal × pris). Datum:
 * mottagen, annars förväntad, annars beställd. Summan räknas av databasen (Σ antal × pris).
 */
export async function queryPurchases(tx: Tx, orgId: string): Promise<PurchaseRecord[]> {
  const result = await tx.execute(sql`
    select po.id, sp.name as supplier, po.status::text as status,
           coalesce(po.received_on, po.expected_on, po.ordered_on)::text as date,
           coalesce(sum(l.quantity::bigint * l.unit_cost_ore), 0)::bigint as amount_ore
    from public.purchase_orders po
    left join public.suppliers sp on sp.organization_id = po.organization_id and sp.id = po.supplier_id
    left join public.purchase_order_lines l on l.organization_id = po.organization_id and l.purchase_order_id = po.id
    where po.organization_id = ${orgId}::uuid and po.status::text not in ('draft', 'cancelled')
    group by po.id, sp.name
    order by 4 nulls last, po.id`);
  return Array.from(result).map((row) => {
    const r = row as Record<string, unknown>;
    return {
      id: String(r.id),
      supplier: r.supplier === null ? null : String(r.supplier),
      status: String(r.status),
      date: r.date === null ? null : (String(r.date) as IsoDate),
      amountOre: Number(r.amount_ore),
    };
  });
}

/** Ett avtal med butikens namn och kopplade villkor. */
export interface ContractRecord {
  readonly id: string;
  readonly storeId: string;
  readonly title: string | null;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly noticePeriodMonths: number | null;
  readonly noticePeriodDays: number | null;
  readonly renewalMonths: number | null;
  readonly terminatedOn: IsoDate | null;
  readonly terms: string | null;
  readonly note: string | null;
  readonly fileName: string | null;
  readonly fileContentType: string | null;
  readonly fileSizeBytes: number | null;
  readonly hasFile: boolean;
  readonly archived: boolean;
  readonly updatedAt: string;
}

export async function queryContracts(tx: Tx, orgId: string): Promise<ContractRecord[]> {
  const rows = await tx
    .select()
    .from(s.contracts)
    .where(eq(s.contracts.organizationId, orgId))
    .orderBy(asc(s.contracts.validTo), asc(s.contracts.validFrom), asc(s.contracts.id));
  return rows.map((r) => ({
    id: r.id,
    storeId: r.storeId,
    title: r.title,
    validFrom: r.validFrom,
    validTo: r.validTo,
    noticePeriodMonths: r.noticePeriodMonths,
    noticePeriodDays: r.noticePeriodDays,
    renewalMonths: r.renewalMonths,
    terminatedOn: r.terminatedOn,
    terms: r.terms,
    note: r.note,
    fileName: r.fileName,
    fileContentType: r.fileContentType,
    fileSizeBytes: r.fileSizeBytes,
    hasFile: r.storagePath !== null,
    archived: r.archivedAt !== null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Butiksavtalens villkor (store_agreements) med id och koppling till avtal. */
export interface AgreementRecord {
  readonly id: string;
  readonly storeId: string;
  readonly contractId: string | null;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly commissionBp: number | null;
  readonly monthlyRentOre: number | null;
  readonly note: string | null;
}

export async function queryAgreementRecords(tx: Tx, orgId: string): Promise<AgreementRecord[]> {
  return tx
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
}
