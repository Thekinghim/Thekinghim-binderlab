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

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

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
import { isSigned } from "@/analytics/contracts/signed";
import {
  reconcilePayouts,
  type Deviation,
  type ExpectedPayout,
  type ReconciliationResult,
} from "@/analytics/reconciliation";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { MemberRole } from "@/db/schema";
import {
  addDays,
  addMonths,
  costOfGoods,
  daysBetween,
  DomainError,
  eachMonth,
  maxDate,
  minDate,
  monthEnd,
  monthPeriod,
  mulDivRound,
  type EconomicsSources,
  type IsoDate,
  type OrderLine,
  type Period,
} from "@/domain";
import { ImportError } from "@/import/errors";
import { type FileStore } from "@/import/file-store";
import { sha256Hex } from "@/import/hash";
import {
  buildAccountantReport,
  monthText as reportMonthText,
  dateText,
  type AccountantReport,
  type AccountantTotals,
  type LedgerAccount,
  type Sie4Verification,
} from "@/reports";
import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import { queryPeriodRefunds } from "@/server/data/core/queries";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
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

import {
  bookkeepingAdapter,
  BookkeepingNotConfiguredError,
  type BookkeepingStatus,
  type VoucherDelivery,
} from "./bookkeeping";
import {
  CONTRACT_FILE_TYPES,
  MAX_CONTRACT_FILE_BYTES,
  contractFileStoreStatus,
  contractStoragePath,
  payoutFileStore,
  sniffContractFile,
} from "./contract-files";
import {
  MANUAL_TOLERANCE_ORE,
  manualReference,
  manualSourceHash,
  nextPayoutPeriod,
  overlappingPayout,
} from "./manual-payout";
import { CsvPayoutSource, payoutSourceStatus } from "./payout-source";
import { buildSieFile, monthVouchers, type MonthVouchers, type PayoutForBooking } from "./vouchers";
import {
  activeResolutions,
  queryAgreementRecords,
  queryContracts,
  queryFixedCosts,
  queryLedgerAccounts,
  queryDataSources,
  queryOrderIdsFromSources,
  queryPayoutImports,
  queryPayoutLines,
  queryHasPayoutSource,
  queryPayouts,
  queryPayoutsForBooking,
  queryProviderSource,
  queryPurchases,
  queryRefunds,
  queryReviews,
  queryVoucherDeliveries,
  toAnalyticsPayouts,
  type RefundRecord,
  type VoucherDeliveryRecord,
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
  const [prices, agreements, placements, settings, refunds] = await Promise.all([
    queryPrices(tx, orgId),
    queryAgreements(tx, orgId),
    queryPlacements(tx, orgId),
    querySettings(tx, orgId),
    queryPeriodRefunds(tx, orgId, ALL_TIME),
  ]);
  return {
    prices,
    agreements,
    // Vinstdelningen drar återbetalningarna från butikens försäljning (få rader).
    refunds: refunds.map((r) => ({
      machineId: r.machineId,
      refundedOn: r.refundedOn,
      amountOre: r.amountOre,
    })),
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
const ALL_TIME = { start: "2000-01-01", end: "2999-12-31" } as const;

// ---------------------------------------------------------------------------
// Avstämning
// ---------------------------------------------------------------------------

export interface ReconciliationView {
  readonly period: Period;
  /** Kända återbetalningar till kunder runt utbetalningarnas perioder (kundärenden). */
  readonly refunds: RefundRecord[];
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
  refunds: RefundRecord[];
}> {
  const [payouts, reviews, provider, settings, sources] = await Promise.all([
    queryPayouts(tx, orgId, period),
    queryReviews(tx, orgId),
    queryProviderSource(tx, orgId),
    querySettings(tx, orgId),
    queryDataSources(tx, orgId),
  ]);
  // Leverantörens tidszon: utbetalningarnas datakälla när de har en gemensam, annars den
  // första aktiva datakällan.
  const payoutSources = [
    ...new Set(payouts.flatMap((p) => (p.dataSourceId ? [p.dataSourceId] : []))),
  ];
  const own =
    payoutSources.length === 1 ? sources.find((x) => x.id === payoutSources[0]) : undefined;
  const providerTimeZone = own?.timeZone ?? provider?.timeZone ?? null;
  if (payouts.length === 0) {
    return {
      result: null,
      payouts,
      reviews,
      providerTimeZone,
      settings,
      withoutTitle: 0,
      refunds: [],
    };
  }
  const start = payouts.reduce((d, p) => minDate(d, p.periodStart), payouts[0]!.periodStart);
  const end = payouts.reduce((d, p) => maxDate(d, p.periodEnd), payouts[0]!.periodEnd);
  const range = { start: addDays(start, -ORDER_MARGIN_DAYS), end: addDays(end, ORDER_MARGIN_DAYS) };
  // Med fler än en datakälla jämförs utbetalningarna bara med order från sin egen källa.
  const filterSources = sources.length > 1 && payoutSources.length > 0;
  const [lines, orders, refunds, sourceOrderIds] = await Promise.all([
    queryPayoutLines(
      tx,
      orgId,
      payouts.map((p) => p.id),
    ),
    queryOrders(tx, orgId, range, NO_SCOPE),
    queryRefunds(tx, orgId, range),
    filterSources ? queryOrderIdsFromSources(tx, orgId, payoutSources, range) : null,
  ]);
  const ownOrders = sourceOrderIds
    ? orders.orders.filter((o) => sourceOrderIds.has(o.id))
    : orders.orders;
  const ownRefunds = sourceOrderIds
    ? refunds.filter((r) => r.orderId === null || sourceOrderIds.has(r.orderId))
    : refunds;
  // En utbetalning som är inskriven för hand: ägaren läser av kontot och skriver ofta hela
  // kronor, så några kronors skillnad räknas som avrundning.
  const manualRefs = new Set(payouts.filter((p) => p.manual).map((p) => p.reference));
  const run = (list: ReturnType<typeof toAnalyticsPayouts>) =>
    reconcilePayouts({
      orders: ownOrders,
      payouts: list,
      refunds: ownRefunds.map((r) => ({
        id: r.id,
        date: r.date,
        amountOre: r.amountOre,
        orderId: r.orderId,
      })),
      settings,
      resolutions: activeResolutions(reviews),
      options: {
        providerTimeZone,
        timeZone,
        ...(manualRefs.size > 0 ? { toleranceOre: MANUAL_TOLERANCE_ORE } : {}),
      },
    });
  const analyticsPayouts = toAnalyticsPayouts(payouts, lines);
  let result = run(analyticsPayouts);
  if (manualRefs.size > 0) {
    // Avgifterna för en inskriven utbetalning är okända (0 i raden). De sätts till det
    // inställningen ger, så att hela skillnaden mot försäljningen visas som en avvikelse i
    // stället för som "avgifterna är lägre än väntat".
    const fees = new Map(result.payouts.map((p) => [p.key, p.expected.feesOre]));
    result = run(
      analyticsPayouts.map((p) =>
        manualRefs.has(p.reference) ? { ...p, feesOre: fees.get(p.reference) ?? 0 } : p,
      ),
    );
  }
  return {
    result,
    payouts,
    reviews,
    providerTimeZone,
    settings,
    withoutTitle: orders.withoutTitle,
    refunds: ownRefunds,
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
      refunds: rec.refunds,
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

// ---------------------------------------------------------------------------
// "Vad betalade Awish?": utbetalningen skrivs in för hand
// ---------------------------------------------------------------------------

/** Frågan överst på Ekonomi: perioden som saknar utbetalning och vad den borde ge. */
export interface PayoutQuestion {
  readonly period: Period;
  /** Väntat enligt försäljningen: samma siffror som avstämningen räknar med. */
  readonly expected: ExpectedPayout;
}

/** Det avstämningen väntar sig för `period` (försäljning − avgifter − återbetalningar). */
async function expectedPayoutIn(
  tx: Tx,
  orgId: string,
  period: Period,
  timeZone: string,
): Promise<ExpectedPayout> {
  const range = {
    start: addDays(period.start, -ORDER_MARGIN_DAYS),
    end: addDays(period.end, ORDER_MARGIN_DAYS),
  };
  const [provider, settings, orders, refunds] = await Promise.all([
    queryProviderSource(tx, orgId),
    querySettings(tx, orgId),
    queryOrders(tx, orgId, range, NO_SCOPE),
    queryRefunds(tx, orgId, range),
  ]);
  // Samma räkning som avstämningen gör när raden väl finns: ett utkast utan belopp.
  const draft = reconcilePayouts({
    orders: orders.orders,
    payouts: [{ reference: "utkast", period, amountOre: 0, feesOre: 0 }],
    refunds: refunds.map((r) => ({
      id: r.id,
      date: r.date,
      amountOre: r.amountOre,
      orderId: r.orderId,
    })),
    settings,
    options: { providerTimeZone: provider?.timeZone ?? null, timeZone },
  });
  return draft.payouts[0]!.expected;
}

function assertManualPeriod(period: Period, today: IsoDate): void {
  if (period.end < period.start) {
    throw new AccountingError("Sista dagen kan inte ligga före första dagen.");
  }
  if (daysBetween(period.start, period.end) > 366) {
    throw new AccountingError("Perioden får vara högst ett år.");
  }
  if (period.end >= today) {
    throw new AccountingError("Perioden måste vara slut. Välj en sista dag före i dag.");
  }
}

/**
 * Frågan "Vad betalade Awish?" för nästa period utan utbetalning (./manual-payout.ts), eller
 * null när det inte finns något att fråga om: perioden är inte slut, eller inget såldes.
 * Ägare och admin (de som får skriva in svaret).
 */
export async function loadPayoutQuestionFor(
  viewer: Viewer,
  today: IsoDate,
): Promise<PayoutQuestion | null> {
  const orgId = viewer.organization.id;
  return asRole(viewer, OPERATOR_ROLES, async (tx) => {
    const period = nextPayoutPeriod(await queryPayouts(tx, orgId, null), today);
    if (!period) return null;
    const expected = await expectedPayoutIn(tx, orgId, period, viewer.organization.timezone);
    return expected.orders > 0 ? { period, expected } : null;
  });
}

/** Det försäljningen ger för en period som ägaren själv valt (när frågans period ändras). */
export async function payoutExpectationFor(
  viewer: Viewer,
  period: Period,
  today: IsoDate,
): Promise<PayoutQuestion> {
  const orgId = viewer.organization.id;
  assertManualPeriod(period, today);
  return asRole(viewer, OPERATOR_ROLES, async (tx) => ({
    period,
    expected: await expectedPayoutIn(tx, orgId, period, viewer.organization.timezone),
  }));
}

export interface ManualPayoutResult {
  readonly id: string;
  readonly reference: string;
  readonly expectedOre: number;
  /** Utbetalt − väntat. */
  readonly differenceOre: number;
  /** Sant när skillnaden ligger inom avrundningen (inget att utreda). */
  readonly matches: boolean;
}

/** Högsta belopp som går att skriva in (skydd mot en nolla för mycket): 100 miljoner kr. */
const MAX_MANUAL_PAYOUT_ORE = 10_000_000_000;

/**
 * Sparar en utbetalning som ägaren skrivit in för hand: belopp som kom in, dagen och
 * perioden den gäller. En rad i payouts (manual = true, referens och fingeravtryck skapas
 * här). Dagar som redan har en utbetalning nekas. Raden går inte att ändra efteråt, bara
 * arkivera (som en importerad). Ägare och admin.
 */
export async function addManualPayoutFor(
  viewer: Viewer,
  input: { readonly period: Period; readonly amountOre: number; readonly paidOn: IsoDate },
  today: IsoDate,
): Promise<ManualPayoutResult> {
  const orgId = viewer.organization.id;
  const { period, amountOre, paidOn } = input;
  assertManualPeriod(period, today);
  if (!Number.isSafeInteger(amountOre) || amountOre <= 0) {
    throw new AccountingError("Skriv beloppet som kom in.");
  }
  if (amountOre > MAX_MANUAL_PAYOUT_ORE) {
    throw new AccountingError("Beloppet är för stort. Kontrollera siffrorna.");
  }
  if (paidOn > today) throw new AccountingError("Dagen pengarna kom kan inte vara efter i dag.");
  if (paidOn < period.start) {
    throw new AccountingError("Pengarna kan inte ha kommit före periodens första dag.");
  }
  return asRole(viewer, OPERATOR_ROLES, async (tx) => {
    // Samma lås som filimporten: två samtidiga sparningar får inte ge två rader.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`payouts:${orgId}`}))`);
    const active = await queryPayouts(tx, orgId, null);
    const clash = overlappingPayout(active, period);
    // Samma svar en gång till (svaret från förra försöket kom aldrig fram, eller ett dubbelt
    // tryck): ingen ny rad och inget fel, utan samma kvitto som första gången.
    if (
      clash &&
      clash.manual &&
      clash.periodStart === period.start &&
      clash.periodEnd === period.end &&
      clash.amountOre === amountOre &&
      clash.paidOn === paidOn
    ) {
      return manualReceipt(
        clash.id,
        clash.reference,
        amountOre,
        await reconcileIn(tx, orgId, period, viewer.organization.timezone),
      );
    }
    if (clash) {
      throw new AccountingError(
        `Det finns redan en utbetalning för de dagarna (${clash.reference}). Arkivera den först om den är fel.`,
      );
    }
    const reference = manualReference(period, new Set(active.map((p) => p.reference)));
    const [row] = await tx
      .insert(s.payouts)
      .values({
        organizationId: orgId,
        // Ingen datakälla: beloppet på kontot gäller all försäljning. Med en källa på raden
        // jämförs den bara med den källans order (reconcileIn), och då stämmer inte
        // skillnaden med det frågan visade.
        dataSourceId: null,
        reference,
        periodStart: period.start,
        periodEnd: period.end,
        paidOn,
        amountOre,
        feesOre: 0,
        refundsOre: null,
        sourceHash: manualSourceHash({ reference, period, paidOn, amountOre }),
        manual: true,
      })
      .returning({ id: s.payouts.id });
    return manualReceipt(
      row!.id,
      reference,
      amountOre,
      await reconcileIn(tx, orgId, period, viewer.organization.timezone),
    );
  });
}

/** Kvittot efter Spara: vad avstämningen säger om den inskrivna utbetalningen. */
function manualReceipt(
  id: string,
  reference: string,
  amountOre: number,
  rec: { readonly result: ReconciliationResult | null },
): ManualPayoutResult {
  const mine = rec.result?.payouts.find((p) => p.reference === reference);
  return {
    id,
    reference,
    expectedOre: mine?.expected.payoutOre ?? amountOre,
    differenceOre: mine?.differenceOre ?? 0,
    matches: mine ? mine.deviations.every((d) => !d.requiresAction) : true,
  };
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
  const store = deps.fileStore ?? (await payoutFileStore());
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
              and(
                eq(s.payouts.organizationId, orgId),
                inArray(s.payouts.reference, references),
                isNull(s.payouts.archivedAt),
              ),
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

/**
 * Arkiverar en felaktig utbetalning (med anteckning om varför). Den räknas inte längre i
 * avstämningen, bokföringen eller kassaflödet, och samma referens kan importeras igen rättad.
 * Raderas aldrig; ändringen loggas i audit_log.
 */
export async function archivePayoutFor(
  viewer: Viewer,
  input: { readonly id: string; readonly note: string },
): Promise<{ reference: string }> {
  const orgId = viewer.organization.id;
  const note = input.note.trim();
  if (!note) throw new AccountingError("Skriv varför utbetalningen arkiveras.");
  return asRole(viewer, OPERATOR_ROLES, async (tx) => {
    const rows = await tx
      .update(s.payouts)
      .set({ archivedAt: new Date(), note: note.slice(0, 2000) })
      .where(
        and(
          eq(s.payouts.organizationId, orgId),
          eq(s.payouts.id, input.id),
          isNull(s.payouts.archivedAt),
        ),
      )
      .returning({ reference: s.payouts.reference });
    if (rows.length === 0)
      throw new AccountingError("Utbetalningen finns inte eller är redan arkiverad.");
    return { reference: rows[0]!.reference };
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

/** 'closed' = avslutad månad (kan laddas ned och skickas), 'open' = innevarande månad. */
export type BookkeepingMonthState = "closed" | "open";

export interface BookkeepingView {
  readonly month: string;
  readonly period: Period;
  readonly fiscalYear: Period;
  readonly state: BookkeepingMonthState;
  readonly verifications: Sie4Verification[];
  /** Summa debet och kredit per konto över månadens verifikationer. */
  readonly accountTotals: AccountTotal[];
  readonly totals: AccountantTotals | null;
  readonly accounts: LedgerAccount[];
  /** Svensk text när verifikationerna inte kan tas fram (t.ex. konto saknas). */
  readonly error: string | null;
  readonly status: BookkeepingStatus;
  readonly fileName: string;
  /** Sant om kontoplanen saknar bankkonto och BAS 1930 användes för utbetalningarna. */
  readonly bankFallback: boolean;
  /** Utbetalningar som kom in i månaden (en verifikation var). */
  readonly payoutsBooked: number;
  /** Dagar där den uppskattade kortavgiften ersatts av leverantörens faktiska avgifter. */
  readonly daysWithActualFees: number;
  /** Leveransen av månaden till bokföringsprogrammet, om den är skickad. */
  readonly delivery: VoucherDeliveryRecord | null;
  /** Sant om månadens verifikationer har ändrats sedan de skickades. */
  readonly changedSinceDelivery: boolean;
  /** En senare månad i räkenskapsåret som redan är skickad (då kan den här inte skickas). */
  readonly laterDelivery: VoucherDeliveryRecord | null;
}

/** Verifikationsserien i SIE-filen. Numren löper över hela räkenskapsåret. */
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

/** Avslutad eller pågående månad. Kastar AccountingError för en månad som inte har börjat. */
export function bookkeepingMonthState(month: string, today: IsoDate): BookkeepingMonthState {
  const thisMonth = today.slice(0, 7);
  if (month > thisMonth) {
    throw new AccountingError(`${sentenceCase(reportMonthText(month))} har inte börjat.`);
  }
  return month === thisMonth ? "open" : "closed";
}

function sentenceCase(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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

/** Utbetalningar i bokföringens form: återbetalningar enligt leverantören, annars de kända. */
function payoutsForBooking(
  payouts: readonly PayoutRecord[],
  refunds: readonly RefundRecord[],
): PayoutForBooking[] {
  return payouts.map((p) => {
    const period = { start: p.periodStart, end: p.periodEnd };
    const known = refunds
      .filter((r) => r.date >= period.start && r.date <= period.end)
      .reduce((sum, r) => sum + r.amountOre, 0);
    return {
      reference: p.reference,
      period,
      paidOn: p.paidOn ?? p.periodEnd,
      amountOre: p.amountOre,
      feesOre: p.feesOre,
      refundsOre: p.refundsOre ?? known,
      feesKnown: !p.manual,
    };
  });
}

interface BuiltMonth {
  readonly month: string;
  readonly vouchers: MonthVouchers;
  readonly totals: AccountantTotals;
  readonly payoutsBooked: number;
}

/**
 * Bygger verifikationerna för räkenskapsårets månader fram till och med `month`, så att
 * numren löper fortlöpande över året: en skickad månad behåller sina nummer (från leveransen),
 * nästa månad fortsätter efter dem.
 */
async function buildBookkeeping(
  tx: Tx,
  viewer: Viewer,
  month: string,
  today: IsoDate,
): Promise<BookkeepingView & { sie: Uint8Array | null }> {
  const orgId = viewer.organization.id;
  const state = bookkeepingMonthState(month, today);
  const period = monthPeriod(month);
  const [sources, accounts, stores, titles, placements] = await Promise.all([
    economicsSources(tx, orgId),
    queryLedgerAccounts(tx, orgId),
    queryStores(tx, orgId),
    queryTitles(tx, orgId),
    queryPlacements(tx, orgId),
  ]);
  const fiscalYear = fiscalYearOf(month, sources.settings.fiscalYearStartMonth);
  const yearToDate = { start: fiscalYear.start, end: period.end };
  const [machines, orders, payouts, deliveries] = await Promise.all([
    queryMachines(tx, orgId, placements, period.end),
    queryOrders(tx, orgId, yearToDate, NO_SCOPE),
    queryPayoutsForBooking(tx, orgId, yearToDate),
    queryVoucherDeliveries(tx, orgId, fiscalYear),
  ]);
  const refundStart = payouts.reduce((d, p) => minDate(d, p.periodStart), fiscalYear.start);
  const refunds = await queryRefunds(tx, orgId, { start: refundStart, end: period.end });
  const booking = payoutsForBooking(payouts, refunds);

  const fileName = `binderlab-${month}.se`;
  const adapter = bookkeepingAdapter();
  const status = adapter.status();
  const latestDelivery = (m: string) =>
    deliveries
      .filter((d) => d.month === m)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] ?? null;
  const delivery = latestDelivery(month);
  const laterDelivery =
    deliveries.filter((d) => d.month > month).sort((a, b) => (a.month < b.month ? -1 : 1))[0] ??
    null;
  const base = {
    month,
    period,
    fiscalYear,
    state,
    accounts,
    status,
    fileName,
    delivery,
    laterDelivery,
  };
  const empty = {
    ...base,
    verifications: [],
    accountTotals: [],
    totals: null,
    bankFallback: false,
    payoutsBooked: 0,
    daysWithActualFees: 0,
    changedSinceDelivery: false,
    sie: null,
  };

  try {
    let next = 1;
    let built: BuiltMonth | null = null;
    for (const m of eachMonth(fiscalYear.start, period.end)) {
      const mp = monthPeriod(m);
      const report = buildAccountantReport(
        {
          ...sources,
          orders: orders.orders.filter(
            (o) => o.businessDate >= mp.start && o.businessDate <= mp.end,
          ),
          stores: stores.map((x) => ({ id: x.id, name: x.name })),
          machines: machines.map((x) => ({ id: x.id, name: x.name, code: x.code })),
          titles: titles.map((x) => ({ id: x.id, name: x.name })),
        },
        mp,
      );
      const monthPayouts = booking.filter(
        (p) =>
          (p.period.start <= mp.end && p.period.end >= mp.start) ||
          (p.paidOn >= mp.start && p.paidOn <= mp.end),
      );
      const sent = latestDelivery(m);
      const first = sent ? sent.firstNumber : next;
      const vouchers = monthVouchers({
        report,
        payouts: monthPayouts,
        accounts,
        fiscalYear,
        series: VERIFICATION_SERIES,
        firstNumber: first,
      });
      next = sent ? sent.lastNumber + 1 : first + vouchers.verifications.length;
      if (m === month) {
        built = {
          month: m,
          vouchers,
          totals: report.totals,
          payoutsBooked: monthPayouts.filter((p) => p.paidOn >= mp.start && p.paidOn <= mp.end)
            .length,
        };
      }
    }
    if (!built) throw new DomainError("invalid_period", "Månaden ligger utanför räkenskapsåret.");
    const { vouchers } = built;
    const sieArgs = {
      company: viewer.organization.name,
      fiscalYear,
      accounts: vouchers.accounts,
      verifications: vouchers.verifications,
    };
    let changedSinceDelivery = false;
    if (delivery) {
      const sentOn = businessToday(new Date(delivery.createdAt), viewer.organization.timezone);
      const again = sha256Hex(buildSieFile({ ...sieArgs, generatedOn: sentOn }));
      changedSinceDelivery = again !== delivery.fileSha256;
    }
    return {
      ...base,
      verifications: vouchers.verifications,
      accountTotals: accountTotalsOf(vouchers.verifications, vouchers.accounts),
      accounts: [
        ...accounts,
        ...vouchers.accounts.filter((a) => !accounts.some((x) => x.key === a.key)),
      ],
      totals: built.totals,
      error: null,
      bankFallback: vouchers.bankFallback,
      payoutsBooked: built.payoutsBooked,
      daysWithActualFees: vouchers.daysWithActualFees,
      changedSinceDelivery,
      sie:
        state === "closed" && vouchers.verifications.length > 0
          ? buildSieFile({ ...sieArgs, generatedOn: today })
          : null,
    };
  } catch (error) {
    if (error instanceof DomainError) return { ...empty, error: error.message };
    throw error;
  }
}

/** Förslag på verifikationer för månaden ('ÅÅÅÅ-MM'). Kastar för en månad som inte har börjat. */
export async function loadBookkeepingFor(
  viewer: Viewer,
  month: string,
  today: IsoDate,
): Promise<BookkeepingView> {
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const { sie: _sie, ...view } = await buildBookkeeping(tx, viewer, month, today);
    void _sie;
    return view;
  });
}

/**
 * SIE 4-filen för en avslutad månad (#GEN = i dag). Kastar AccountingError för en pågående
 * eller framtida månad, eller om verifikationerna inte kan tas fram.
 */
export async function sieFileFor(
  viewer: Viewer,
  month: string,
  today: IsoDate,
): Promise<{ fileName: string; bytes: Uint8Array }> {
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const view = await buildBookkeeping(tx, viewer, month, today);
    if (view.state === "open") {
      throw new AccountingError(
        `${sentenceCase(reportMonthText(month))} pågår. SIE-filen kan tas fram när månaden är slut.`,
      );
    }
    if (!view.sie) {
      throw new AccountingError(view.error ?? "Månaden har inga verifikationer.");
    }
    return { fileName: view.fileName, bytes: view.sie };
  });
}

/**
 * Skickar en avslutad månads verifikationer till bokföringsprogrammet (ACCOUNTING_PROVIDER).
 * En månad skickas en gång, och i ordning: inte om en senare månad redan är skickad. Leveransen
 * loggas i voucher_deliveries (append-only, audit) i samma transaktion; misslyckas leveransen
 * sparas ingen logg.
 */
export async function deliverVouchersFor(
  viewer: Viewer,
  month: string,
  today: IsoDate,
): Promise<VoucherDelivery & { firstNumber: number; lastNumber: number }> {
  const orgId = viewer.organization.id;
  return asRole(viewer, OPERATOR_ROLES, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`vouchers:${orgId}`}))`);
    const view = await buildBookkeeping(tx, viewer, month, today);
    const name = sentenceCase(reportMonthText(month));
    if (view.state === "open") {
      throw new AccountingError(`${name} pågår. Verifikationerna kan skickas när månaden är slut.`);
    }
    if (view.error) throw new AccountingError(view.error);
    if (view.delivery) {
      throw new AccountingError(
        `${name} är redan skickad (${VERIFICATION_SERIES} ${view.delivery.firstNumber}–${view.delivery.lastNumber}, ${dateText(
          view.delivery.createdAt.slice(0, 10),
        )}).`,
      );
    }
    if (view.laterDelivery) {
      throw new AccountingError(
        `${sentenceCase(reportMonthText(view.laterDelivery.month))} är redan skickad. Månaderna skickas i ordning, så ${reportMonthText(
          month,
        )} bokförs för hand eller med SIE-filen.`,
      );
    }
    if (!view.sie || view.verifications.length === 0) {
      throw new AccountingError("Månaden har inga verifikationer att skicka.");
    }
    const adapter = bookkeepingAdapter();
    const adapterStatus = adapter.status();
    if (adapter.kind === "none" || !adapterStatus.configured) {
      throw new BookkeepingNotConfiguredError(adapterStatus.detail);
    }
    const firstNumber = view.verifications[0]!.number;
    const lastNumber = view.verifications[view.verifications.length - 1]!.number;
    await tx.insert(s.voucherDeliveries).values({
      organizationId: orgId,
      month: `${month}-01`,
      provider: adapter.kind as s.VoucherProvider,
      series: VERIFICATION_SERIES,
      firstNumber,
      lastNumber,
      verificationCount: view.verifications.length,
      fileSha256: sha256Hex(view.sie),
    });
    const result = await adapter.deliver({
      organizationId: orgId,
      month,
      verifications: view.verifications,
      sieFile: view.sie,
      fileName: view.fileName,
    });
    return { ...result, firstNumber, lastNumber };
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
 * Inköpsorder som flöden: mottagna (och den mottagna delen av en delvis mottagen order)
 * räknas som betalda på mottagningsdagen, beställda (och resten) som planerade på förväntad dag
 * (annars beställningsdagen). Se queryPurchases.
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
            status: r.status === "received" ? ("paid" as const) : ("planned" as const),
            ...(r.supplier ? { label: r.supplier } : {}),
          },
        ],
  );
}

/** Påfyllnad av lagret i prognosen (inköp som inte är beställda än). */
export interface ReplenishmentForecast {
  /** Fönstret som inköpsvärdet räknas på (samma som kassaflödets prognosfönster). */
  readonly window: Period;
  readonly windowDays: number;
  /** Inköpsvärdet för sålda pack i fönstret (@/domain costOfGoods). */
  readonly windowCostOre: number;
  /** Andel order i fönstret med inköpspris, i bp. */
  readonly coverageBp: number | null;
  /** Per månad: prognos, redan planerade inköpsorder och det som läggs till. */
  readonly months: {
    readonly month: string;
    readonly days: number;
    readonly projectedOre: number;
    readonly plannedOre: number;
    readonly addedOre: number;
  }[];
}

export interface CashflowView {
  readonly range: Period;
  readonly result: CashflowResult | null;
  readonly error: string | null;
  readonly purchases: number;
  readonly fixedCosts: number;
  readonly payouts: number;
  /** null när det saknas försäljning att bygga prognosen på. */
  readonly replenishment: ReplenishmentForecast | null;
  /** Antagandet om utbetalningsrytmen, i klartext. */
  readonly payoutCycleNote: string;
  /**
   * Sant när utbetalningar läses in (queryHasPayoutSource). Falskt: inga utbetalningar visas
   * som väntade eller saknade (Awish-utbetalningarna är inte inlästa).
   */
  readonly payoutsTracked: boolean;
}

/** Minsta antal registrerade utbetalningar för att rytmen ska läsas ur dem. */
const MIN_PAYOUTS_FOR_CYCLE = 2;

/**
 * Kassaflödet per månad: fem månader bakåt (dock inte före första ordern), innevarande och
 * tre framåt.
 *
 * - Utbetalningsrytmen läses ur utbetalningarna först när det finns minst två; annars antas
 *   en utbetalning i månaden (med samma fördröjning som den senaste utbetalningen).
 * - Inköp framåt: utöver lagda inköpsorder prognostiseras påfyllnaden av lagret som
 *   inköpsvärdet för sålda pack i prognosfönstret, per dag, för månadens återstående dagar,
 *   minus de inköpsorder som redan är planerade samma månad (aldrig under 0).
 */
export async function loadCashflowFor(
  viewer: Viewer,
  today: IsoDate,
  dataStart: IsoDate | null = null,
): Promise<CashflowView> {
  const orgId = viewer.organization.id;
  const thisMonth = today.slice(0, 7);
  const back = `${addMonths(thisMonth, -CASHFLOW_MONTHS_BACK)}-01`;
  const first = dataStart ? `${dataStart.slice(0, 7)}-01` : back;
  const range: Period = {
    start: first > back && first <= today ? first : back,
    end: monthEnd(addMonths(thisMonth, CASHFLOW_MONTHS_AHEAD)),
  };
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const ordersFrom = addDays(range.start, -62);
    const [sources, orders, payouts, purchases, costs, payoutsTracked] = await Promise.all([
      economicsSources(tx, orgId),
      queryOrders(tx, orgId, { start: ordersFrom, end: today }, NO_SCOPE),
      queryPayouts(tx, orgId, { start: addDays(range.start, -62), end: range.end }),
      queryPurchases(tx, orgId),
      queryFixedCosts(tx, orgId),
      queryHasPayoutSource(tx, orgId),
    ]);
    const activeCosts = costs.filter((c) => !c.archived);
    const fewPayouts = payouts.length < MIN_PAYOUTS_FOR_CYCLE;
    const payoutCycleNote = fewPayouts
      ? payouts.length === 0
        ? payoutsTracked
          ? "Ingen utbetalning är registrerad: en utbetalning i månaden antas."
          : "Inga utbetalningar är inlästa: kommande utbetalningar antas en gång i månaden."
        : "Bara en utbetalning är registrerad, så rytmen går inte att läsa ut: en utbetalning i månaden antas."
      : "Utbetalningsrytmen följer den senaste utbetalningens period.";
    const base = {
      range,
      purchases: purchases.length,
      fixedCosts: activeCosts.length,
      payouts: payouts.length,
      payoutCycleNote,
      payoutsTracked,
    };
    const planned = toPurchases(purchases);
    const input = {
      ...sources,
      orders: orders.orders,
      payouts: toAnalyticsPayouts(payouts, new Map()),
      purchases: planned,
      fixedCosts: activeCosts.map(toFixedCost),
      asOf: today,
      range,
      granularity: "month" as const,
      options: {
        ...(fewPayouts ? { payoutCycle: "month" as const } : {}),
        payoutsTracked,
      },
    };
    try {
      const firstPass = cashflow(input);
      const replenishment = replenishmentForecast(
        firstPass,
        sources,
        orders.orders,
        planned,
        today,
      );
      const result =
        replenishment && replenishment.months.some((m) => m.addedOre > 0)
          ? cashflow({
              ...input,
              purchases: [
                ...planned,
                ...replenishment.months
                  .filter((m) => m.addedOre > 0)
                  .map((m) => ({
                    id: `pafyllnad-${m.month}`,
                    date: monthEnd(m.month),
                    amountOre: m.addedOre,
                    status: "planned" as const,
                    label: "Påfyllnad av lager (prognos)",
                  })),
              ],
            })
          : firstPass;
      return { ...base, result, error: null, replenishment };
    } catch (error) {
      if (error instanceof DomainError) {
        return { ...base, result: null, error: error.message, replenishment: null };
      }
      throw error;
    }
  });
}

/** Påfyllnaden av lagret per framtida månad (se loadCashflowFor). */
function replenishmentForecast(
  result: CashflowResult,
  sources: EconomicsSources,
  orders: readonly OrderLine[],
  planned: readonly Purchase[],
  today: IsoDate,
): ReplenishmentForecast | null {
  const { window, windowDays } = result.basis;
  if (!window || windowDays <= 0) return null;
  const windowOrders = orders.filter(
    (o) => o.businessDate >= window.start && o.businessDate <= window.end,
  );
  const cost = costOfGoods({ ...sources, orders: windowOrders, period: window });
  const tomorrow = addDays(today, 1);
  if (tomorrow > result.range.end) return null;
  const months = eachMonth(tomorrow, result.range.end).map((m) => {
    const span = {
      start: maxDate(`${m}-01`, tomorrow),
      end: minDate(monthEnd(m), result.range.end),
    };
    const days = daysBetween(span.start, span.end) + 1;
    const projectedOre = mulDivRound(cost.costOre, days, windowDays);
    const plannedOre = planned
      .filter((p) => p.status === "planned" && p.date >= span.start && p.date <= span.end)
      .reduce((sum, p) => sum + p.amountOre, 0);
    return {
      month: m,
      days,
      projectedOre,
      plannedOre,
      addedOre: Math.max(0, projectedOre - plannedOre),
    };
  });
  return {
    window,
    windowDays,
    windowCostOre: cost.costOre,
    coverageBp: cost.coverageBp,
    months,
  };
}

export interface FixedCostsView {
  readonly costs: FixedCostRecord[];
  readonly allocation: FixedCostAllocation | null;
  readonly error: string | null;
  readonly machines: MachineRecord[];
}

/**
 * De fasta kostnaderna och lönsamheten efter fasta kostnader för perioden. Vinsten är före
 * butikernas andel, eller efter den med `storeShare` (vyknappen "Visa butikernas andel",
 * samma regel som övriga sidor, @/domain storeShareDeducted).
 */
export async function loadFixedCostsFor(
  viewer: Viewer,
  period: Period,
  today: IsoDate,
  options: { readonly storeShare?: boolean } = {},
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
          settings: { ...sources.settings, deductStoreShare: options.storeShare === true },
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

/**
 * Avtalen, villkoren, påminnelserna och översikten över intäkt på avtal som löper ut.
 * `overview: false` hoppar över översikten (12 månaders order, den tyngsta frågan) när
 * sidan inte visar den; `overview` blir då null.
 */
export async function loadContractsFor(
  viewer: Viewer,
  today: IsoDate,
  opts: { readonly overview?: boolean } = {},
): Promise<ContractsView> {
  const orgId = viewer.organization.id;
  const withOverview = opts.overview !== false;
  return asRole(viewer, ECONOMY_ROLES, async (tx) => {
    const windowStart = addDays(`${addMonths(today.slice(0, 7), -12)}-01`, -1);
    const [contracts, agreements, stores, sources, orders] = await Promise.all([
      queryContracts(tx, orgId),
      queryAgreementRecords(tx, orgId),
      queryStores(tx, orgId),
      withOverview ? economicsSources(tx, orgId) : null,
      withOverview
        ? queryOrders(tx, orgId, { start: windowStart, end: addDays(today, -1) }, NO_SCOPE)
        : null,
    ]);
    const active = contracts.filter((c) => !c.archived).map(toContract);
    // Intäkten "i riskzonen" räknas bara på signerade kontrakt: ett utkast eller ett skickat
    // kontrakt skyddar ingen intäkt (butiken hamnar under "utan signerat kontrakt").
    const signed = contracts.filter((c) => !c.archived && isSigned(c)).map(toContract);
    const storeRefs = stores.map((x) => ({ id: x.id, name: x.name }));
    const reminders = contractReminders({ contracts: active, asOf: today, stores: storeRefs });
    let overview: ExpiringRevenueOverview | null = null;
    let overviewError: string | null = null;
    try {
      overview =
        sources && orders
          ? expiringRevenueOverview({
              ...sources,
              contracts: signed,
              orders: orders.orders,
              asOf: today,
              stores: storeRefs,
            })
          : null;
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
  // Filkolumnerna sätts bara via public.attach_contract_file (rollkontroll, tillåten typ och
  // sökvägen {org}/{avtal}/{sha256}.{ändelse}); en klient kan inte skriva dem direkt.
  await asRole(viewer, OPERATOR_ROLES, async (tx) => {
    await tx.execute(
      sql`select public.attach_contract_file(${orgId}::uuid, ${input.contractId}::uuid,
            ${storagePath}, ${name}, ${contentType}, ${input.bytes.byteLength}::bigint, ${sha})`,
    );
  });
  return { storagePath };
}

/**
 * Avtalsfilen (för nedladdning). Ägare, admin och läsare. Typen som skickas till webbläsaren
 * är alltid en av de tillåtna (CONTRACT_FILE_TYPES) och kontrolleras mot innehållet igen när
 * filen läses: stämmer den sparade typen inte med innehållet skickas filen inte alls.
 */
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
  if (!CONTRACT_FILE_TYPES[row.contentType]) {
    console.error("[avtal] otillåten filtyp", contractId, row.contentType);
    throw new AccountingError("Avtalsfilen har en filtyp som inte tas emot. Ladda upp den igen.");
  }
  let bytes: Uint8Array;
  try {
    bytes = await deps.fileStore.get(row.storagePath);
  } catch (error) {
    console.error("[avtal] filen kunde inte läsas", row.storagePath, error);
    throw new AccountingError("Avtalsfilen finns inte i lagringen. Ladda upp den igen.");
  }
  const sniffed = sniffContractFile(bytes);
  if (sniffed !== row.contentType) {
    console.error(
      "[avtal] filens innehåll stämmer inte med typen",
      contractId,
      row.contentType,
      sniffed,
    );
    throw new AccountingError(
      "Avtalsfilens innehåll stämmer inte med filtypen. Ladda upp den igen.",
    );
  }
  return { fileName: row.fileName, contentType: sniffed, bytes };
}

export { ImportError };

// ---------------------------------------------------------------------------
// Månadsrapporter för Bokföring (src/server/bokforing)
// ---------------------------------------------------------------------------

/** En månads bokföringsrapport och mottagna inköp, för månadspaketet. */
export interface MonthReport {
  readonly month: string;
  readonly report: AccountantReport;
  /** Mottagna inköp (mottaget antal × pris) med mottagningsdag i månaden. */
  readonly receivedPurchasesOre: number;
  /** Återbetalningar till kunder med återbetalningsdag i månaden. */
  readonly refundsOre: number;
}

/**
 * Bokföringsrapporten per månad ('ÅÅÅÅ-MM') i användarens transaktion `tx` (RLS), från samma
 * beräkning som resten av Ekonomi. Organisationen ges uttryckligen; inget läses utanför den.
 */
export async function monthReportsIn(
  tx: Tx,
  orgId: string,
  months: readonly string[],
): Promise<Map<string, MonthReport>> {
  const out = new Map<string, MonthReport>();
  if (months.length === 0) return out;
  const sorted = [...months].sort();
  const range = { start: monthPeriod(sorted[0]!).start, end: monthPeriod(sorted.at(-1)!).end };
  const [sources, stores, titles, placements, received, refunds] = await Promise.all([
    economicsSources(tx, orgId),
    queryStores(tx, orgId),
    queryTitles(tx, orgId),
    queryPlacements(tx, orgId),
    // Mottaget antal (högst beställt) × pris, per mottagningsdag. Även för en order med status
    // 'received' räknas bara det som faktiskt kom.
    tx.execute(sql`
      select coalesce(po.received_on, po.ordered_on)::text as date,
             coalesce(sum(least(l.received_quantity, l.quantity)::bigint * l.unit_cost_ore), 0)::bigint
               as ore
      from public.purchase_orders po
      join public.purchase_order_lines l
        on l.organization_id = po.organization_id and l.purchase_order_id = po.id
      where po.organization_id = ${orgId}::uuid
        and po.status::text in ('received', 'partially_received')
        and coalesce(po.received_on, po.ordered_on) between ${range.start}::date and ${range.end}::date
      group by 1`),
    queryRefunds(tx, orgId, range),
  ]);
  const receivedByDate = Array.from(received).map((row) => {
    const r = row as { date: string; ore: string | number };
    return { date: r.date, ore: Number(r.ore) };
  });
  const [machines, orders] = await Promise.all([
    queryMachines(tx, orgId, placements, range.end),
    queryOrders(tx, orgId, range, NO_SCOPE),
  ]);
  for (const m of sorted) {
    const mp = monthPeriod(m);
    const report = buildAccountantReport(
      {
        ...sources,
        orders: orders.orders.filter((o) => o.businessDate >= mp.start && o.businessDate <= mp.end),
        stores: stores.map((x) => ({ id: x.id, name: x.name })),
        machines: machines.map((x) => ({ id: x.id, name: x.name, code: x.code })),
        titles: titles.map((x) => ({ id: x.id, name: x.name })),
      },
      mp,
    );
    const inMonth = (d: string) => d >= mp.start && d <= mp.end;
    const receivedPurchasesOre = receivedByDate
      .filter((p) => inMonth(p.date))
      .reduce((s, p) => s + p.ore, 0);
    const refundsOre = refunds.filter((r) => inMonth(r.date)).reduce((s, r) => s + r.amountOre, 0);
    out.set(m, { month: m, report, receivedPurchasesOre, refundsOre });
  }
  return out;
}
