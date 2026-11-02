/**
 * Ekonomiområdets laddare och ändringar, bundna till en given användare och organisation
 * (Viewer). Testbara utan Next (test/db/ekonomi-*.test.ts); sidorna och server actions
 * använder dem via ./session.ts.
 *
 * Varje funktion kontrollerar rollen mot databasen (requireRoleFor, läst under RLS) och
 * läser och skriver sedan som användaren (withUserDbFor, RLS). Läsning: ägare, admin och
 * läsare. Ändringar: ägare och admin. Påfyllaren får aldrig något (AuthorizationError, och
 * RLS ger tomma resultat).
 *
 * Alla belopp kommer från @/domain, @/analytics och @/reports; här hämtas och formas bara
 * rader.
 */

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import {
  cashflow,
  profitabilityWithFixedCosts,
  type CashflowResult,
  type FixedCost,
  type FixedCostAllocation,
  type Purchase,
} from "@/analytics/cashflow";
import {
  contractReminders,
  expiringRevenueOverview,
  type Contract,
  type ContractReminderResult,
  type ExpiringRevenueOverview,
} from "@/analytics/contracts";
import {
  reconcilePayouts,
  type Deviation,
  type ReconciliationResult,
} from "@/analytics/reconciliation";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { MemberRole } from "@/db/schema";
import {
  addDays,
  addMonths,
  DomainError,
  maxDate,
  minDate,
  monthEnd,
  monthPeriod,
  type EconomicsSources,
  type IsoDate,
  type Period,
} from "@/domain";
import { ImportError } from "@/import/errors";
import { LocalFileStore, type FileStore } from "@/import/file-store";
import { sha256Hex } from "@/import/hash";
import {
  buildAccountantReport,
  exportSie4,
  sie4Verifications,
  type AccountantTotals,
  type LedgerAccount,
  type Sie4Verification,
} from "@/reports";
import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import {
  queryAgreements,
  queryMachines,
  queryOrders,
  queryPlacements,
  queryPrices,
  querySettings,
  queryStores,
  queryTitles,
} from "@/server/data/core/queries";
import {
  ECONOMY_ROLES,
  OPERATOR_ROLES,
  type MachineRecord,
  type OrgSettings,
  type StoreRecord,
} from "@/server/data/core/types";

import { bookkeepingAdapter, type BookkeepingStatus, type VoucherDelivery } from "./bookkeeping";
import {
  CONTRACT_FILE_TYPES,
  MAX_CONTRACT_FILE_BYTES,
  contractFileStoreStatus,
  contractStoragePath,
  sniffContractFile,
} from "./contract-files";
import { CsvPayoutSource, payoutSourceStatus } from "./payout-source";
import {
  activeResolutions,
  queryAgreementRecords,
  queryContracts,
  queryFixedCosts,
  queryLedgerAccounts,
  queryPayoutImports,
  queryPayoutLines,
  queryPayouts,
  queryProviderSource,
  queryPurchases,
  queryReviews,
  toAnalyticsPayouts,
  type AgreementRecord,
  type ContractRecord,
  type FixedCostRecord,
  type PayoutImportRecord,
  type PayoutRecord,
  type PurchaseRecord,
  type ReviewRecord,
} from "./queries";

export type { Viewer };

/** Fel som visas för användaren som de är (svensk text). */
export class AccountingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountingError";
  }
}

async function asRole<T>(
  viewer: Viewer,
  roles: readonly MemberRole[],
  fn: (tx: Tx, role: MemberRole) => Promise<T>,
): Promise<T> {
  const role = await requireRoleFor(viewer.user, viewer.organization.id, roles);
  return withUserDbFor(viewer.user, (tx) => fn(tx, role));
}

/** Priser, avtal, placeringar och inställningar (allt beräkningarna behöver utom order). */
async function economicsSources(
  tx: Tx,
  orgId: string,
): Promise<EconomicsSources & { settings: OrgSettings }> {
  const [prices, agreements, placements, settings] = await Promise.all([
    queryPrices(tx, orgId),
    queryAgreements(tx, orgId),
    queryPlacements(tx, orgId),
    querySettings(tx, orgId),
  ]);
  return {
    prices,
    agreements,
    placements: placements.map((p) => ({
      machineId: p.machineId,
      storeId: p.storeId,
      from: p.from,
      to: p.to,
    })),
    settings,
  };
}

const NO_SCOPE = { storeId: null, machineId: null } as const;

// ---------------------------------------------------------------------------
// Avstämning
// ---------------------------------------------------------------------------

export interface ReconciliationView {
  readonly period: Period;
  /** null när det inte finns någon utbetalning i perioden. */
  readonly result: ReconciliationResult | null;
  readonly payouts: PayoutRecord[];
  readonly imports: PayoutImportRecord[];
  readonly reviews: ReviewRecord[];
  readonly providerTimeZone: string | null;
  readonly cardFeeBp: number;
  readonly source: ReturnType<typeof payoutSourceStatus>;
  /** Order utan titel i perioden: de saknas i avstämningen (ska inte förekomma). */
  readonly ordersWithoutTitle: number;
}

/** Dagar runt utbetalningarnas perioder som orderna läses för (tidszon och förskjutning). */
const ORDER_MARGIN_DAYS = 3;

async function reconcileIn(
  tx: Tx,
  orgId: string,
  period: Period,
  timeZone: string,
): Promise<{
  result: ReconciliationResult | null;
  payouts: PayoutRecord[];
  reviews: ReviewRecord[];
  providerTimeZone: string | null;
  settings: OrgSettings;
  withoutTitle: number;
}> {
  const [payouts, reviews, provider, settings] = await Promise.all([
    queryPayouts(tx, orgId, period),
    queryReviews(tx, orgId),
    queryProviderSource(tx, orgId),
    querySettings(tx, orgId),
  ]);
  const providerTimeZone = provider?.timeZone ?? null;
  if (payouts.length === 0) {
    return { result: null, payouts, reviews, providerTimeZone, settings, withoutTitle: 0 };
  }
  const start = payouts.reduce((d, p) => minDate(d, p.periodStart), payouts[0]!.periodStart);
  const end = payouts.reduce((d, p) => maxDate(d, p.periodEnd), payouts[0]!.periodEnd);
  const [lines, orders] = await Promise.all([
    queryPayoutLines(
      tx,
      orgId,
      payouts.map((p) => p.id),
    ),
    queryOrders(
      tx,
      orgId,
      { start: addDays(start, -ORDER_MARGIN_DAYS), end: addDays(end, ORDER_MARGIN_DAYS) },
      NO_SCOPE,
    ),
  ]);
  const result = reconcilePayouts({
    orders: orders.orders,
    payouts: toAnalyticsPayouts(payouts, lines),
    refunds: [],
    settings,
    resolutions: activeResolutions(reviews),
    options: { providerTimeZone, timeZone },
  });
  return {
    result,
    payouts,
    reviews,
    providerTimeZone,
    settings,
    withoutTitle: orders.withoutTitle,
  };
}

/** Avstämningen av utbetalningarna vars period överlappar `period`. */
export async function loadReconciliationFor(
  viewer: Viewer,
  period: Period,
): Promise<ReconciliationView> {
  const orgId = viewer.organization.id;
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const [rec, imports] = await Promise.all([
      reconcileIn(tx, orgId, period, viewer.organization.timezone),
      queryPayoutImports(tx, orgId),
    ]);
    return {
      period,
      result: rec.result,
      payouts: rec.payouts,
      imports,
      reviews: rec.reviews,
      providerTimeZone: rec.providerTimeZone,
      cardFeeBp: rec.settings.cardFeeBp,
      source: payoutSourceStatus(),
      ordersWithoutTitle: rec.withoutTitle,
    };
  });
}

export interface PayoutImportResult {
  readonly importId: string;
  readonly format: "payouts" | "lines";
  readonly rowsTotal: number;
  readonly rowsNew: number;
  readonly rowsDuplicate: number;
  readonly rowsConflict: number;
  readonly rowsError: number;
  readonly messages: string[];
  /** Perioden som de nya utbetalningarna täcker (för länken till avstämningen). */
  readonly period: Period | null;
}

const MAX_MESSAGES = 50;

/**
 * Importerar en utbetalningsfil (CSV). Utbetalningar: ny referens sparas, samma referens med
 * samma innehåll är dubblett, samma referens med annat innehåll är konflikt (utbetalningen
 * ändras aldrig). Specifikation: raderna kopplas till utbetalningen med samma referens; en
 * referens som inte finns blir felrad. Filen sparas som underlag (bucket imports).
 */
export async function importPayoutFileFor(
  viewer: Viewer,
  file: { readonly name: string; readonly bytes: Uint8Array },
  deps: { readonly fileStore?: FileStore } = {},
): Promise<PayoutImportResult> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const fileName = file.name.trim().slice(0, 255) || "utbetalningar.csv";
  const batch = await new CsvPayoutSource(file.bytes).fetch();
  const sha = sha256Hex(file.bytes);
  const storagePath = `${orgId}/payouts/${sha}.csv`;
  const store = deps.fileStore ?? new LocalFileStore();
  await store.put(storagePath, file.bytes, "text/csv");

  return asRole(viewer, OPERATOR_ROLES, async (tx) => {
    const messages: string[] = batch.errors.map((e) => `Rad ${e.lineNumber}: ${e.message}`);
    let rowsNew = 0;
    let rowsDuplicate = 0;
    let rowsConflict = 0;
    let rowsError = batch.errors.length;
    const provider = await queryProviderSource(tx, orgId);

    // Låser organisationens utbetalningar för importen, så att två samtidiga uppladdningar
    // av samma fil inte krockar (den andra ser den första som dubbletter).
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payouts:${orgId}`}))`);

    const references = [
      ...new Set([
        ...batch.payouts.map((p) => p.reference),
        ...batch.lines.map((l) => l.reference),
      ]),
    ];
    const existing =
      references.length === 0
        ? []
        : await tx
            .select({
              id: s.payouts.id,
              reference: s.payouts.reference,
              sourceHash: s.payouts.sourceHash,
              periodStart: s.payouts.periodStart,
              periodEnd: s.payouts.periodEnd,
            })
            .from(s.payouts)
            .where(
              and(eq(s.payouts.organizationId, orgId), inArray(s.payouts.reference, references)),
            );
    const byReference = new Map(existing.map((p) => [p.reference, p]));

    const toInsert: (typeof batch.payouts)[number][] = [];
    const lineInserts: { payoutId: string; externalId: string; amountOre: number }[] = [];
    if (batch.format === "payouts") {
      const seen = new Map<string, string>();
      for (const p of batch.payouts) {
        const prior = byReference.get(p.reference)?.sourceHash ?? seen.get(p.reference);
        if (prior === undefined) {
          seen.set(p.reference, p.sourceHash);
          toInsert.push(p);
          rowsNew += 1;
        } else if (prior === p.sourceHash) {
          rowsDuplicate += 1;
        } else {
          rowsConflict += 1;
          messages.push(
            `Rad ${p.lineNumber}: utbetalning ${p.reference} finns redan med andra belopp eller datum. Den sparade ändras inte.`,
          );
        }
      }
    } else {
      const payoutIds = [...new Set(existing.map((p) => p.id))];
      const known =
        payoutIds.length === 0
          ? []
          : await tx
              .select({
                payoutId: s.payoutLines.payoutId,
                externalId: s.payoutLines.externalId,
                amountOre: s.payoutLines.amountOre,
              })
              .from(s.payoutLines)
              .where(
                and(
                  eq(s.payoutLines.organizationId, orgId),
                  inArray(s.payoutLines.payoutId, payoutIds),
                ),
              );
      const knownKey = new Map(
        known.map((l) => [`${l.payoutId}\u001f${l.externalId}`, l.amountOre]),
      );
      for (const l of batch.lines) {
        const payout = byReference.get(l.reference);
        if (!payout) {
          rowsError += 1;
          messages.push(
            `Rad ${l.lineNumber}: utbetalning ${l.reference} finns inte. Importera utbetalningarna före specifikationen.`,
          );
          continue;
        }
        const key = `${payout.id}\u001f${l.externalId}`;
        const prior = knownKey.get(key);
        if (prior === undefined) {
          knownKey.set(key, l.amountOre);
          lineInserts.push({
            payoutId: payout.id,
            externalId: l.externalId,
            amountOre: l.amountOre,
          });
          rowsNew += 1;
        } else if (prior === l.amountOre) {
          rowsDuplicate += 1;
        } else {
          rowsConflict += 1;
          messages.push(
            `Rad ${l.lineNumber}: order ${l.externalId} i ${l.reference} finns redan med ett annat belopp.`,
          );
        }
      }
    }

    const [imp] = await tx
      .insert(s.payoutImports)
      .values({
        organizationId: orgId,
        dataSourceId: provider?.id ?? null,
        fileName,
        fileSha256: sha,
        storagePath,
        format: batch.format,
        rowsTotal: batch.rows,
        rowsNew,
        rowsDuplicate,
        rowsConflict,
        rowsError,
        messages: messages.slice(0, MAX_MESSAGES),
      })
      .returning({ id: s.payoutImports.id });
    const importId = imp!.id;

    if (toInsert.length > 0) {
      await tx.insert(s.payouts).values(
        toInsert.map((p) => ({
          organizationId: orgId,
          dataSourceId: provider?.id ?? null,
          importId,
          reference: p.reference,
          periodStart: p.periodStart,
          periodEnd: p.periodEnd,
          paidOn: p.paidOn,
          amountOre: p.amountOre,
          feesOre: p.feesOre,
          refundsOre: p.refundsOre,
          sourceHash: p.sourceHash,
        })),
      );
    }
    for (let i = 0; i < lineInserts.length; i += 1000) {
      await tx
        .insert(s.payoutLines)
        .values(
          lineInserts.slice(i, i + 1000).map((l) => ({ organizationId: orgId, importId, ...l })),
        );
    }

    const linked = new Set(lineInserts.map((l) => l.payoutId));
    const touched: Period[] =
      batch.format === "payouts"
        ? toInsert.map((p) => ({ start: p.periodStart, end: p.periodEnd }))
        : existing
            .filter((p) => linked.has(p.id))
            .map((p) => ({ start: p.periodStart, end: p.periodEnd }));
    const period =
      touched.length > 0
        ? touched.reduce((a, b) => ({
            start: minDate(a.start, b.start),
            end: maxDate(a.end, b.end),
          }))
        : null;

    return {
      importId,
      format: batch.format,
      rowsTotal: batch.rows,
      rowsNew,
      rowsDuplicate,
      rowsConflict,
      rowsError,
      messages: messages.slice(0, MAX_MESSAGES),
      period,
    };
  });
}

function findDeviation(result: ReconciliationResult | null, key: string): Deviation | null {
  if (!result) return null;
  for (const p of result.payouts) {
    const d = p.deviations.find((x) => x.key === key);
    if (d) return d;
  }
  return result.uncovered.find((x) => x.key === key) ?? null;
}

/**
 * Markerar en avvikelse som utredd (med anteckning) eller öppnar den igen. Avvikelsen räknas
 * om på servern för perioden: nyckeln måste finnas, och det sparade fingerprintet är det
 * servern räknade fram (inte klientens). Loggas i deviation_reviews (append-only) och audit_log.
 */
export async function reviewDeviationFor(
  viewer: Viewer,
  input: {
    readonly period: Period;
    readonly key: string;
    readonly action: "investigated" | "reopened";
    readonly note: string | null;
  },
): Promise<{ id: string }> {
  const orgId = viewer.organization.id;
  return asRole(viewer, OPERATOR_ROLES, async (tx) => {
    const rec = await reconcileIn(tx, orgId, input.period, viewer.organization.timezone);
    const deviation = findDeviation(rec.result, input.key);
    if (input.action === "investigated") {
      if (!deviation) {
        throw new AccountingError("Avvikelsen finns inte längre. Ladda om sidan.");
      }
      if (!deviation.requiresAction) {
        throw new AccountingError("Avvikelsen jämnas ut av sig själv och behöver inte utredas.");
      }
      if (!input.note || !input.note.trim()) {
        throw new AccountingError("Skriv vad utredningen kom fram till.");
      }
    } else {
      const latest = rec.reviews.find((r) => r.deviationKey === input.key);
      if (!latest || latest.action !== "investigated") {
        throw new AccountingError("Avvikelsen är inte markerad som utredd.");
      }
    }
    const [row] = await tx
      .insert(s.deviationReviews)
      .values({
        organizationId: orgId,
        deviationKey: input.key,
        fingerprint: deviation?.fingerprint ?? null,
        action: input.action,
        note: input.note?.trim() || null,
      })
      .returning({ id: s.deviationReviews.id });
    return { id: row!.id };
  });
}

// ---------------------------------------------------------------------------
// Bokföring
// ---------------------------------------------------------------------------

export interface AccountTotal {
  readonly account: string;
  readonly name: string;
  readonly debitOre: number;
  readonly creditOre: number;
}

export interface BookkeepingView {
  readonly month: string;
  readonly period: Period;
  readonly fiscalYear: Period;
  readonly verifications: Sie4Verification[];
  /** Summa debet och kredit per konto över månadens verifikationer. */
  readonly accountTotals: AccountTotal[];
  readonly totals: AccountantTotals | null;
  readonly accounts: LedgerAccount[];
  /** Svensk text när verifikationerna inte kan tas fram (t.ex. konto saknas). */
  readonly error: string | null;
  readonly status: BookkeepingStatus;
  readonly fileName: string;
}

/** Verifikationsserien i SIE-filen. */
export const VERIFICATION_SERIES = "BL";

/** Räkenskapsåret som innehåller månaden. */
export function fiscalYearOf(month: string, startMonth: number): Period {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  const sm = Math.min(12, Math.max(1, Math.trunc(startMonth) || 1));
  const startYear = m >= sm ? year : year - 1;
  const first = `${startYear}-${String(sm).padStart(2, "0")}`;
  return { start: `${first}-01`, end: monthEnd(addMonths(first, 11)) };
}

/** Totalsumman per konto (debet/kredit) över verifikationerna. */
function accountTotalsOf(
  verifications: readonly Sie4Verification[],
  accounts: readonly LedgerAccount[],
): AccountTotal[] {
  const names = new Map(accounts.map((a) => [a.account, a.name]));
  const totals = new Map<string, { debit: number; credit: number }>();
  for (const v of verifications) {
    for (const t of v.transactions) {
      const cur = totals.get(t.account) ?? { debit: 0, credit: 0 };
      if (t.amountOre >= 0) cur.debit += t.amountOre;
      else cur.credit -= t.amountOre;
      totals.set(t.account, cur);
    }
  }
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([account, t]) => ({
      account,
      name: names.get(account) ?? account,
      debitOre: t.debit,
      creditOre: t.credit,
    }));
}

async function buildBookkeeping(
  tx: Tx,
  viewer: Viewer,
  month: string,
): Promise<BookkeepingView & { sie: Uint8Array | null }> {
  const orgId = viewer.organization.id;
  const period = monthPeriod(month);
  const [sources, orders, accounts, stores, titles, placements] = await Promise.all([
    economicsSources(tx, orgId),
    queryOrders(tx, orgId, period, NO_SCOPE),
    queryLedgerAccounts(tx, orgId),
    queryStores(tx, orgId),
    queryTitles(tx, orgId),
    queryPlacements(tx, orgId),
  ]);
  const machines = await queryMachines(tx, orgId, placements, period.end);
  const fiscalYear = fiscalYearOf(month, sources.settings.fiscalYearStartMonth);
  const fileName = `binderlab-${month}.se`;
  const status = bookkeepingAdapter().status();
  const base = { month, period, fiscalYear, accounts, status, fileName };
  try {
    const report = buildAccountantReport(
      {
        ...sources,
        orders: orders.orders,
        stores: stores.map((x) => ({ id: x.id, name: x.name })),
        machines: machines.map((x) => ({ id: x.id, name: x.name, code: x.code })),
        titles: titles.map((x) => ({ id: x.id, name: x.name })),
      },
      period,
    );
    const options = {
      company: viewer.organization.name,
      ledgerAccounts: accounts,
      fiscalYear,
      verificationSeries: VERIFICATION_SERIES,
      generatedOn: period.end,
    };
    const verifications = sie4Verifications(report, options);
    return {
      ...base,
      verifications,
      accountTotals: accountTotalsOf(verifications, accounts),
      totals: report.totals,
      error: null,
      sie: exportSie4(report, options),
    };
  } catch (error) {
    if (error instanceof DomainError) {
      return {
        ...base,
        verifications: [],
        accountTotals: [],
        totals: null,
        error: error.message,
        sie: null,
      };
    }
    throw error;
  }
}

/** Förslag på verifikationer för månaden ('ÅÅÅÅ-MM'). */
export async function loadBookkeepingFor(viewer: Viewer, month: string): Promise<BookkeepingView> {
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const { sie: _sie, ...view } = await buildBookkeeping(tx, viewer, month);
    void _sie;
    return view;
  });
}

/** SIE 4-filen för månaden. Kastar AccountingError om den inte kan tas fram. */
export async function sieFileFor(
  viewer: Viewer,
  month: string,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const view = await buildBookkeeping(tx, viewer, month);
    if (!view.sie) throw new AccountingError(view.error ?? "SIE-filen kunde inte tas fram.");
    return { fileName: view.fileName, bytes: view.sie };
  });
}

/** Skickar månadens verifikationer till bokföringsprogrammet (ACCOUNTING_PROVIDER). */
export async function deliverVouchersFor(viewer: Viewer, month: string): Promise<VoucherDelivery> {
  return asRole(viewer, OPERATOR_ROLES, async (tx) => {
    const view = await buildBookkeeping(tx, viewer, month);
    if (!view.sie) throw new AccountingError(view.error ?? "Verifikationerna kunde inte tas fram.");
    if (view.verifications.length === 0) {
      throw new AccountingError("Månaden har inga verifikationer att skicka.");
    }
    return bookkeepingAdapter().deliver({
      organizationId: viewer.organization.id,
      month,
      verifications: view.verifications,
      sieFile: view.sie,
      fileName: view.fileName,
    });
  });
}

// ---------------------------------------------------------------------------
// Kassaflöde och fasta kostnader
// ---------------------------------------------------------------------------

/** Månader bakåt och framåt i kassaflödet. */
export const CASHFLOW_MONTHS_BACK = 5;
export const CASHFLOW_MONTHS_AHEAD = 3;

function toFixedCost(r: FixedCostRecord): FixedCost {
  return {
    id: r.id,
    name: r.name,
    amountOre: r.amountOre,
    interval: r.interval,
    start: r.startsOn,
    end: r.endsOn,
    machineId: r.machineId,
  };
}

/**
 * Inköpsorder som flöden: mottagna (helt eller delvis) räknas som betalda på mottagningsdagen,
 * beställda som planerade på förväntad dag (annars beställningsdagen).
 */
function toPurchases(records: readonly PurchaseRecord[]): Purchase[] {
  return records.flatMap((r) =>
    r.date === null || r.amountOre === 0
      ? []
      : [
          {
            id: r.id,
            date: r.date,
            amountOre: r.amountOre,
            status:
              r.status === "received" || r.status === "partially_received"
                ? ("paid" as const)
                : ("planned" as const),
            ...(r.supplier ? { label: r.supplier } : {}),
          },
        ],
  );
}

export interface CashflowView {
  readonly range: Period;
  readonly result: CashflowResult | null;
  readonly error: string | null;
  readonly purchases: number;
  readonly fixedCosts: number;
  readonly payouts: number;
}

/** Kassaflödet per månad: fem månader bakåt, innevarande och tre framåt. */
export async function loadCashflowFor(viewer: Viewer, today: IsoDate): Promise<CashflowView> {
  const orgId = viewer.organization.id;
  const thisMonth = today.slice(0, 7);
  const range: Period = {
    start: `${addMonths(thisMonth, -CASHFLOW_MONTHS_BACK)}-01`,
    end: monthEnd(addMonths(thisMonth, CASHFLOW_MONTHS_AHEAD)),
  };
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const ordersFrom = addDays(range.start, -62);
    const [sources, orders, payouts, purchases, costs] = await Promise.all([
      economicsSources(tx, orgId),
      queryOrders(tx, orgId, { start: ordersFrom, end: today }, NO_SCOPE),
      queryPayouts(tx, orgId, { start: addDays(range.start, -62), end: range.end }),
      queryPurchases(tx, orgId),
      queryFixedCosts(tx, orgId),
    ]);
    const activeCosts = costs.filter((c) => !c.archived);
    const base = {
      range,
      purchases: purchases.length,
      fixedCosts: activeCosts.length,
      payouts: payouts.length,
    };
    try {
      const result = cashflow({
        ...sources,
        orders: orders.orders,
        payouts: toAnalyticsPayouts(payouts, new Map()),
        purchases: toPurchases(purchases),
        fixedCosts: activeCosts.map(toFixedCost),
        asOf: today,
        range,
        granularity: "month",
      });
      return { ...base, result, error: null };
    } catch (error) {
      if (error instanceof DomainError) return { ...base, result: null, error: error.message };
      throw error;
    }
  });
}

export interface FixedCostsView {
  readonly costs: FixedCostRecord[];
  readonly allocation: FixedCostAllocation | null;
  readonly error: string | null;
  readonly machines: MachineRecord[];
}

/** De fasta kostnaderna och lönsamheten efter fasta kostnader för perioden. */
export async function loadFixedCostsFor(
  viewer: Viewer,
  period: Period,
  today: IsoDate,
): Promise<FixedCostsView> {
  const orgId = viewer.organization.id;
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const [sources, orders, costs, placements] = await Promise.all([
      economicsSources(tx, orgId),
      queryOrders(tx, orgId, period, NO_SCOPE),
      queryFixedCosts(tx, orgId),
      queryPlacements(tx, orgId),
    ]);
    const machines = await queryMachines(tx, orgId, placements, today);
    try {
      const allocation = profitabilityWithFixedCosts(
        {
          ...sources,
          orders: orders.orders,
          period,
          fixedCosts: costs.filter((c) => !c.archived).map(toFixedCost),
          machines: machines.map((m) => ({ id: m.id, name: m.code })),
        },
        "revenue",
      );
      return { costs, allocation, error: null, machines };
    } catch (error) {
      if (error instanceof DomainError) {
        return { costs, allocation: null, error: error.message, machines };
      }
      throw error;
    }
  });
}

export interface FixedCostInput {
  readonly id?: string | null;
  readonly name: string;
  readonly category: s.FixedCostCategory;
  readonly amountOre: number;
  readonly interval: s.FixedCostIntervalDb;
  readonly startsOn: IsoDate;
  readonly endsOn: IsoDate | null;
  readonly machineId: string | null;
  readonly note: string | null;
}

/** Skapar eller ändrar en fast kostnad. */
export async function saveFixedCostFor(
  viewer: Viewer,
  input: FixedCostInput,
): Promise<{ id: string }> {
  const orgId = viewer.organization.id;
  return asRole(viewer, OPERATOR_ROLES, async (tx) => {
    const values = {
      name: input.name.trim(),
      category: input.category,
      amountOre: input.amountOre,
      interval: input.interval,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      machineId: input.machineId,
      note: input.note?.trim() || null,
    };
    if (input.id) {
      const rows = await tx
        .update(s.fixedCosts)
        .set(values)
        .where(and(eq(s.fixedCosts.organizationId, orgId), eq(s.fixedCosts.id, input.id)))
        .returning({ id: s.fixedCosts.id });
      if (rows.length === 0) throw new AccountingError("Kostnaden finns inte.");
      return { id: rows[0]!.id };
    }
    const [row] = await tx
      .insert(s.fixedCosts)
      .values({ organizationId: orgId, ...values })
      .returning({ id: s.fixedCosts.id });
    return { id: row!.id };
  });
}

/** Arkiverar (eller återställer) en fast kostnad. Raderas aldrig. */
export async function archiveFixedCostFor(
  viewer: Viewer,
  input: { readonly id: string; readonly archived: boolean },
): Promise<void> {
  const orgId = viewer.organization.id;
  await asRole(viewer, OPERATOR_ROLES, async (tx) => {
    const rows = await tx
      .update(s.fixedCosts)
      .set({ archivedAt: input.archived ? new Date() : null })
      .where(and(eq(s.fixedCosts.organizationId, orgId), eq(s.fixedCosts.id, input.id)))
      .returning({ id: s.fixedCosts.id });
    if (rows.length === 0) throw new AccountingError("Kostnaden finns inte.");
  });
}

// ---------------------------------------------------------------------------
// Avtal
// ---------------------------------------------------------------------------

export interface ContractsView {
  readonly contracts: ContractRecord[];
  readonly agreements: AgreementRecord[];
  readonly stores: StoreRecord[];
  readonly reminders: ContractReminderResult;
  readonly overview: ExpiringRevenueOverview | null;
  readonly overviewError: string | null;
  readonly fileStore: ReturnType<typeof contractFileStoreStatus>;
}

/** Avtalet i den form @/analytics/contracts vill ha. */
export function toContract(r: ContractRecord): Contract {
  return {
    id: r.id,
    storeId: r.storeId,
    name: r.title,
    validFrom: r.validFrom,
    validTo: r.validTo,
    noticeMonths: r.noticePeriodMonths,
    noticeDays: r.noticePeriodDays,
    renewalMonths: r.renewalMonths,
    terminatedOn: r.terminatedOn,
  };
}

/** Avtalen, villkoren, påminnelserna och översikten över intäkt på avtal som löper ut. */
export async function loadContractsFor(viewer: Viewer, today: IsoDate): Promise<ContractsView> {
  const orgId = viewer.organization.id;
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const windowStart = addDays(`${addMonths(today.slice(0, 7), -12)}-01`, -1);
    const [contracts, agreements, stores, sources, orders] = await Promise.all([
      queryContracts(tx, orgId),
      queryAgreementRecords(tx, orgId),
      queryStores(tx, orgId),
      economicsSources(tx, orgId),
      queryOrders(tx, orgId, { start: windowStart, end: addDays(today, -1) }, NO_SCOPE),
    ]);
    const active = contracts.filter((c) => !c.archived).map(toContract);
    const storeRefs = stores.map((x) => ({ id: x.id, name: x.name }));
    const reminders = contractReminders({ contracts: active, asOf: today, stores: storeRefs });
    let overview: ExpiringRevenueOverview | null = null;
    let overviewError: string | null = null;
    try {
      overview = expiringRevenueOverview({
        ...sources,
        contracts: active,
        orders: orders.orders,
        asOf: today,
        stores: storeRefs,
      });
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      overviewError = error.message;
    }
    return {
      contracts,
      agreements,
      stores,
      reminders,
      overview,
      overviewError,
      fileStore: contractFileStoreStatus(),
    };
  });
}

export interface ContractInput {
  readonly id?: string | null;
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
  /** Villkor att skapa och koppla (om butiken saknar villkor för perioden). */
  readonly newTerms?: {
    readonly commissionBp: number | null;
    readonly monthlyRentOre: number | null;
  } | null;
  /** Befintliga villkor (store_agreements) att koppla till avtalet. */
  readonly agreementIds?: readonly string[];
}

/** Skapar eller ändrar ett avtal och kopplar villkoren. */
export async function saveContractFor(
  viewer: Viewer,
  input: ContractInput,
): Promise<{ id: string }> {
  const orgId = viewer.organization.id;
  return asRole(viewer, OPERATOR_ROLES, async (tx) => {
    const values = {
      storeId: input.storeId,
      title: input.title?.trim() || null,
      validFrom: input.validFrom,
      validTo: input.validTo,
      noticePeriodMonths: input.noticePeriodMonths,
      noticePeriodDays: input.noticePeriodDays,
      renewalMonths: input.renewalMonths,
      terminatedOn: input.terminatedOn,
      terms: input.terms?.trim() || null,
      note: input.note?.trim() || null,
    };
    let id: string;
    if (input.id) {
      const rows = await tx
        .update(s.contracts)
        .set(values)
        .where(and(eq(s.contracts.organizationId, orgId), eq(s.contracts.id, input.id)))
        .returning({ id: s.contracts.id });
      if (rows.length === 0) throw new AccountingError("Avtalet finns inte.");
      id = rows[0]!.id;
    } else {
      const [row] = await tx
        .insert(s.contracts)
        .values({ organizationId: orgId, ...values })
        .returning({ id: s.contracts.id });
      id = row!.id;
    }

    if (input.agreementIds) {
      const wanted = new Set(input.agreementIds);
      const current = await tx
        .select({ id: s.storeAgreements.id, contractId: s.storeAgreements.contractId })
        .from(s.storeAgreements)
        .where(
          and(
            eq(s.storeAgreements.organizationId, orgId),
            eq(s.storeAgreements.storeId, input.storeId),
          ),
        );
      for (const a of current) {
        const linked = a.contractId === id;
        if (wanted.has(a.id) && !linked) {
          await tx
            .update(s.storeAgreements)
            .set({ contractId: id })
            .where(
              and(eq(s.storeAgreements.organizationId, orgId), eq(s.storeAgreements.id, a.id)),
            );
        } else if (!wanted.has(a.id) && linked) {
          await tx
            .update(s.storeAgreements)
            .set({ contractId: null })
            .where(
              and(eq(s.storeAgreements.organizationId, orgId), eq(s.storeAgreements.id, a.id)),
            );
        }
      }
      const unknown = [...wanted].filter((w) => !current.some((a) => a.id === w));
      if (unknown.length > 0) throw new AccountingError("Villkoren hör inte till avtalets butik.");
    }

    const t = input.newTerms;
    if (t && (t.commissionBp !== null || t.monthlyRentOre !== null)) {
      await tx.insert(s.storeAgreements).values({
        organizationId: orgId,
        storeId: input.storeId,
        contractId: id,
        validFrom: input.validFrom,
        validTo: input.validTo,
        commissionBp: t.commissionBp,
        monthlyRentOre: t.monthlyRentOre,
        note: values.title ? `Enligt avtal: ${values.title}` : "Enligt avtal",
      });
    }
    return { id };
  });
}

/** Arkiverar (eller återställer) ett avtal. Raderas aldrig. */
export async function archiveContractFor(
  viewer: Viewer,
  input: { readonly id: string; readonly archived: boolean },
): Promise<void> {
  const orgId = viewer.organization.id;
  await asRole(viewer, OPERATOR_ROLES, async (tx) => {
    const rows = await tx
      .update(s.contracts)
      .set({ archivedAt: input.archived ? new Date() : null })
      .where(and(eq(s.contracts.organizationId, orgId), eq(s.contracts.id, input.id)))
      .returning({ id: s.contracts.id });
    if (rows.length === 0) throw new AccountingError("Avtalet finns inte.");
  });
}

/**
 * Bifogar avtalsfilen. Typen kontrolleras mot innehållet (PDF, PNG, JPEG eller Word), filen
 * sparas under ett namn servern väljer (sha256), och avtalet får filens namn, typ och storlek.
 * En ny fil ersätter referensen; den gamla filen ligger kvar i lagringen som underlag.
 */
export async function attachContractFileFor(
  viewer: Viewer,
  input: { readonly contractId: string; readonly fileName: string; readonly bytes: Uint8Array },
  deps: { readonly fileStore: FileStore },
): Promise<{ storagePath: string }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  if (input.bytes.byteLength === 0) throw new AccountingError("Filen är tom.");
  if (input.bytes.byteLength > MAX_CONTRACT_FILE_BYTES) {
    throw new AccountingError("Filen är för stor (högst 20 MB).");
  }
  const contentType = sniffContractFile(input.bytes);
  if (!contentType || !CONTRACT_FILE_TYPES[contentType]) {
    throw new AccountingError("Filen måste vara PDF, PNG, JPEG eller Word (.docx).");
  }
  const exists = await withUserDbFor(viewer.user, (tx) =>
    tx
      .select({ id: s.contracts.id })
      .from(s.contracts)
      .where(and(eq(s.contracts.organizationId, orgId), eq(s.contracts.id, input.contractId))),
  );
  if (exists.length === 0) throw new AccountingError("Avtalet finns inte.");
  const sha = sha256Hex(input.bytes);
  const storagePath = contractStoragePath(orgId, input.contractId, sha, contentType);
  await deps.fileStore.put(storagePath, input.bytes, contentType);
  const name =
    input.fileName
      .replace(/[\\/\u0000-\u001f]/g, " ")
      .trim()
      .slice(0, 255) || "avtal";
  await asRole(viewer, OPERATOR_ROLES, async (tx) => {
    await tx
      .update(s.contracts)
      .set({
        storagePath,
        fileName: name,
        fileContentType: contentType,
        fileSizeBytes: input.bytes.byteLength,
        fileSha256: sha,
      })
      .where(and(eq(s.contracts.organizationId, orgId), eq(s.contracts.id, input.contractId)));
  });
  return { storagePath };
}

/** Avtalsfilen (för nedladdning). Ägare, admin och läsare. */
export async function readContractFileFor(
  viewer: Viewer,
  contractId: string,
  deps: { readonly fileStore: FileStore },
): Promise<{ fileName: string; contentType: string; bytes: Uint8Array }> {
  const orgId = viewer.organization.id;
  const rows = await asRole(viewer, ECONOMY_ROLES, (tx) =>
    tx
      .select({
        storagePath: s.contracts.storagePath,
        fileName: s.contracts.fileName,
        contentType: s.contracts.fileContentType,
      })
      .from(s.contracts)
      .where(and(eq(s.contracts.organizationId, orgId), eq(s.contracts.id, contractId))),
  );
  const row = rows[0];
  if (!row?.storagePath || !row.fileName || !row.contentType) {
    throw new AccountingError("Avtalet har ingen fil.");
  }
  if (!row.storagePath.startsWith(`${orgId}/`)) throw new AuthorizationError("forbidden");
  let bytes: Uint8Array;
  try {
    bytes = await deps.fileStore.get(row.storagePath);
  } catch (error) {
    console.error("[avtal] filen kunde inte läsas", row.storagePath, error);
    throw new AccountingError("Avtalsfilen finns inte i lagringen. Ladda upp den igen.");
  }
  return { fileName: row.fileName, contentType: row.contentType, bytes };
}

export { ImportError };
