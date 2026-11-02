/**
 * Frågorna bakom de gemensamma laddarna. Varje funktion tar en transaktion som redan
 * kör som användaren (withUserDb/withUserDbFor, alltså med RLS) och organisationens id.
 * Ingen funktion här kontrollerar roller; det gör loaders.ts innan den anropar dem.
 * RLS är det andra lagret: en påfyllare som ändå kom hit får tomma resultat för order,
 * priser, avtal och inställningar.
 *
 * Ingen ekonomilogik: frågorna hämtar och formar rader, beräkningarna görs i @/domain.
 */

import {
  and,
  asc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  max,
  sql,
  type SQL,
} from "drizzle-orm";

import type { Contract } from "@/analytics/contracts";
import type { AlertRef, AnalyticsOrder, ReportDraftRef } from "@/analytics/todos";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { toSafeInteger } from "@/db/types";
import { reportStatuses, type DeliveryStatus } from "@/server/reports/status";
import type { IsoDate, MachineInvestment, Period, PurchasePrice, StoreAgreement } from "@/domain";

import type {
  DataScope,
  MachineRecord,
  OrgSettings,
  PlacementRecord,
  SalesCountRow,
  StockRow,
  StoreRecord,
  TitleRecord,
} from "./types";

export const DEFAULT_SETTINGS: OrgSettings = {
  vatRateBp: 0,
  cardFeeBp: 0,
  fiscalYearStartMonth: 1,
};

function iso(d: Date | null): string | null {
  return d ? d.toISOString() : null;
}

/** Placeringen som gällde automaten på dagen `dateColumn` ligger i butiken. */
function placedInStore(machineColumn: SQL, dateColumn: SQL, orgId: string, storeId: string): SQL {
  return sql`exists (
    select 1 from public.machine_placements mp
    where mp.organization_id = ${orgId}::uuid
      and mp.store_id = ${storeId}::uuid
      and mp.machine_id = ${machineColumn}
      and mp.valid_from <= ${dateColumn}
      and (mp.valid_to is null or mp.valid_to >= ${dateColumn})
  )`;
}

// ---------------------------------------------------------------------------
// Profil och inställningar
// ---------------------------------------------------------------------------

export async function queryDisplayName(
  tx: Tx,
  orgId: string,
  userId: string,
): Promise<string | null> {
  const rows = await tx
    .select({ displayName: s.profiles.displayName })
    .from(s.profiles)
    .where(
      and(
        eq(s.profiles.organizationId, orgId),
        eq(s.profiles.userId, userId),
        isNull(s.profiles.anonymizedAt),
      ),
    )
    .limit(1);
  const name = rows[0]?.displayName?.trim();
  return name ? name : null;
}

/** Inställningarna (standardvärden om raden saknas). Påfyllaren kan inte läsa dem (RLS). */
export async function querySettings(tx: Tx, orgId: string): Promise<OrgSettings> {
  const rows = await tx
    .select({
      vatRateBp: s.organizationSettings.vatRateBp,
      cardFeeBp: s.organizationSettings.cardFeeBp,
      fiscalYearStartMonth: s.organizationSettings.fiscalYearStartMonth,
    })
    .from(s.organizationSettings)
    .where(eq(s.organizationSettings.organizationId, orgId))
    .limit(1);
  return rows[0] ?? DEFAULT_SETTINGS;
}

/** Antal aktiva automater per organisation (för organisationsväxlaren). */
export async function queryMachineCountsByOrg(
  tx: Tx,
  orgIds: readonly string[],
): Promise<Map<string, number>> {
  if (orgIds.length === 0) return new Map();
  const rows = await tx
    .select({ orgId: s.machines.organizationId, n: sql<number>`count(*)::int` })
    .from(s.machines)
    .where(and(inArray(s.machines.organizationId, [...orgIds]), isNull(s.machines.archivedAt)))
    .groupBy(s.machines.organizationId);
  return new Map(rows.map((r) => [r.orgId, Number(r.n)]));
}

// ---------------------------------------------------------------------------
// Stamdata (alla roller)
// ---------------------------------------------------------------------------

export async function queryTitles(tx: Tx, orgId: string): Promise<TitleRecord[]> {
  const rows = await tx
    .select({
      id: s.titles.id,
      name: s.titles.name,
      series: s.titles.series,
      mergedIntoId: s.titles.mergedIntoId,
      archivedAt: s.titles.archivedAt,
    })
    .from(s.titles)
    .where(eq(s.titles.organizationId, orgId))
    .orderBy(asc(s.titles.name), asc(s.titles.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    series: r.series,
    mergedIntoId: r.mergedIntoId,
    archived: r.archivedAt !== null || r.mergedIntoId !== null,
  }));
}

export async function queryPlacements(tx: Tx, orgId: string): Promise<PlacementRecord[]> {
  const rows = await tx
    .select({
      id: s.machinePlacements.id,
      machineId: s.machinePlacements.machineId,
      storeId: s.machinePlacements.storeId,
      from: s.machinePlacements.validFrom,
      to: s.machinePlacements.validTo,
    })
    .from(s.machinePlacements)
    .where(eq(s.machinePlacements.organizationId, orgId))
    .orderBy(asc(s.machinePlacements.machineId), asc(s.machinePlacements.validFrom));
  return rows;
}

/** Automaterna, med butiken de står i `today` (aktuell placering). */
export async function queryMachines(
  tx: Tx,
  orgId: string,
  placements: readonly PlacementRecord[],
  today: IsoDate,
): Promise<MachineRecord[]> {
  const rows = await tx
    .select({
      id: s.machines.id,
      code: s.machines.code,
      name: s.machines.name,
      serial: s.machines.serial,
      activeFrom: s.machines.activeFrom,
      activeTo: s.machines.activeTo,
      isExample: s.machines.isExample,
      archivedAt: s.machines.archivedAt,
    })
    .from(s.machines)
    .where(eq(s.machines.organizationId, orgId))
    .orderBy(asc(s.machines.code), asc(s.machines.id));
  const current = new Map<string, string>();
  for (const p of placements) {
    if (p.from <= today && (p.to === null || p.to >= today)) current.set(p.machineId, p.storeId);
  }
  return rows.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    serial: r.serial,
    activeFrom: r.activeFrom,
    activeTo: r.activeTo,
    isExample: r.isExample,
    archived: r.archivedAt !== null,
    storeId: current.get(r.id) ?? null,
  }));
}

export async function queryStores(tx: Tx, orgId: string): Promise<StoreRecord[]> {
  const rows = await tx
    .select({
      id: s.stores.id,
      name: s.stores.name,
      address: s.stores.address,
      contactName: s.stores.contactName,
      email: s.stores.email,
      phone: s.stores.phone,
      isExample: s.stores.isExample,
      archivedAt: s.stores.archivedAt,
    })
    .from(s.stores)
    .where(eq(s.stores.organizationId, orgId))
    .orderBy(asc(s.stores.name), asc(s.stores.id));
  return rows.map(({ archivedAt, ...r }) => ({ ...r, archived: archivedAt !== null }));
}

// ---------------------------------------------------------------------------
// Ekonomi (bara ägare, admin och läsare; RLS ger påfyllaren tomma resultat)
// ---------------------------------------------------------------------------

export async function queryPrices(tx: Tx, orgId: string): Promise<PurchasePrice[]> {
  return tx
    .select({
      titleId: s.purchasePrices.titleId,
      unitCostOre: s.purchasePrices.unitCostOre,
      validFrom: s.purchasePrices.validFrom,
    })
    .from(s.purchasePrices)
    .where(eq(s.purchasePrices.organizationId, orgId))
    .orderBy(asc(s.purchasePrices.titleId), asc(s.purchasePrices.validFrom));
}

export async function queryAgreements(tx: Tx, orgId: string): Promise<StoreAgreement[]> {
  return tx
    .select({
      storeId: s.storeAgreements.storeId,
      validFrom: s.storeAgreements.validFrom,
      validTo: s.storeAgreements.validTo,
      commissionBp: s.storeAgreements.commissionBp,
      monthlyRentOre: s.storeAgreements.monthlyRentOre,
    })
    .from(s.storeAgreements)
    .where(eq(s.storeAgreements.organizationId, orgId))
    .orderBy(asc(s.storeAgreements.storeId), asc(s.storeAgreements.validFrom));
}

export async function queryInvestments(tx: Tx, orgId: string): Promise<MachineInvestment[]> {
  const rows = await tx
    .select({
      machineId: s.machineInvestments.machineId,
      kind: s.machineInvestments.kind,
      amountOre: s.machineInvestments.amountOre,
      date: s.machineInvestments.investedOn,
      depreciationMonths: s.machineInvestments.depreciationMonths,
    })
    .from(s.machineInvestments)
    .where(eq(s.machineInvestments.organizationId, orgId))
    .orderBy(asc(s.machineInvestments.investedOn), asc(s.machineInvestments.id));
  return rows;
}

export interface OrderQueryResult {
  readonly orders: AnalyticsOrder[];
  readonly withoutTitle: number;
}

/**
 * Order med affärsdatum i [start, end], filtrerade på butik (automatens placering den
 * dagen) eller automat. Order utan titel räknas men tas inte med (de kan inte prissättas).
 */
export async function queryOrders(
  tx: Tx,
  orgId: string,
  range: Period,
  scope: DataScope,
): Promise<OrderQueryResult> {
  const conditions: SQL[] = [
    sql`o.organization_id = ${orgId}::uuid`,
    sql`o.business_date >= ${range.start}::date`,
    sql`o.business_date <= ${range.end}::date`,
  ];
  if (scope.machineId) conditions.push(sql`o.machine_id = ${scope.machineId}::uuid`);
  if (scope.storeId) {
    conditions.push(placedInStore(sql`o.machine_id`, sql`o.business_date`, orgId, scope.storeId));
  }
  // Rå SQL i stället för Drizzles select: med 100 000 order är det radernas omvandling
  // som tar tid. Tidpunkten formateras i databasen precis som Date.toISOString()
  // (UTC, millisekunder, "Z"), och beloppet kontrolleras som säkert heltal som i schemat.
  const rows = (await tx.execute(sql`
    select o.id, o.external_id, o.title_id, o.machine_id,
           o.business_date::text as business_date, o.amount_ore,
           to_char(o.ordered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as ordered_at
    from public.orders o
    where ${sql.join(conditions, sql` and `)}
    order by o.ordered_at, o.id
  `)) as unknown as Iterable<OrderRow>;
  const orders: AnalyticsOrder[] = [];
  let withoutTitle = 0;
  for (const r of rows) {
    if (r.title_id === null) {
      withoutTitle += 1;
      continue;
    }
    orders.push({
      id: r.id,
      externalId: r.external_id,
      titleId: r.title_id,
      machineId: r.machine_id,
      businessDate: r.business_date,
      amountOre: toSafeInteger(r.amount_ore),
      orderedAt: r.ordered_at,
    });
  }
  return { orders, withoutTitle };
}

interface OrderRow {
  readonly id: string;
  readonly external_id: string;
  readonly title_id: string | null;
  readonly machine_id: string | null;
  readonly business_date: string;
  readonly amount_ore: string | number;
  readonly ordered_at: string;
}

/** Första affärsdagen med en order, eller null. */
export async function queryFirstOrderDate(tx: Tx, orgId: string): Promise<IsoDate | null> {
  const rows = await tx
    .select({ first: sql<string | null>`min(${s.orders.businessDate})::text` })
    .from(s.orders)
    .where(eq(s.orders.organizationId, orgId));
  return rows[0]?.first ?? null;
}

// ---------------------------------------------------------------------------
// Lager och försäljning i antal (alla roller)
// ---------------------------------------------------------------------------

/** Första affärsdagen med en försäljning i lagret, eller null (för påfyllare). */
export async function queryFirstSaleDate(tx: Tx, orgId: string): Promise<IsoDate | null> {
  const rows = await tx
    .select({ first: sql<string | null>`min(${s.stockEvents.businessDate})::text` })
    .from(s.stockEvents)
    .where(and(eq(s.stockEvents.organizationId, orgId), eq(s.stockEvents.kind, "sale")));
  return rows[0]?.first ?? null;
}

export async function queryStock(tx: Tx, orgId: string): Promise<StockRow[]> {
  const levels = await tx
    .select({
      locationId: s.stockLevels.locationId,
      titleId: s.stockLevels.titleId,
      quantity: s.stockLevels.quantity,
      lastCountedAt: s.stockLevels.lastCountedAt,
      lastEventAt: s.stockLevels.lastEventAt,
      locationName: s.stockLocations.name,
      locationKind: s.stockLocations.kind,
      isCentral: s.stockLocations.isCentral,
      machineId: s.stockLocations.machineId,
    })
    .from(s.stockLevels)
    .innerJoin(
      s.stockLocations,
      and(
        eq(s.stockLocations.id, s.stockLevels.locationId),
        eq(s.stockLocations.organizationId, s.stockLevels.organizationId),
      ),
    )
    .where(and(eq(s.stockLevels.organizationId, orgId), isNull(s.stockLocations.archivedAt)))
    .orderBy(asc(s.stockLocations.name), asc(s.stockLevels.titleId));

  const restocked = await tx
    .select({
      locationId: s.stockEvents.locationId,
      titleId: s.stockEvents.titleId,
      at: max(s.stockEvents.occurredAt),
    })
    .from(s.stockEvents)
    .where(
      and(
        eq(s.stockEvents.organizationId, orgId),
        inArray(s.stockEvents.kind, ["refill", "count"]),
      ),
    )
    .groupBy(s.stockEvents.locationId, s.stockEvents.titleId);
  const restockedAt = new Map(
    restocked.map((r) => [`${r.locationId}\u0000${r.titleId}`, r.at ? new Date(r.at) : null]),
  );

  return levels.map((r) => ({
    locationId: r.locationId,
    locationName: r.locationName,
    locationKind: r.locationKind,
    isCentral: r.isCentral,
    machineId: r.machineId,
    titleId: r.titleId,
    onHand: r.quantity,
    lastCountedAt: iso(r.lastCountedAt),
    lastEventAt: iso(r.lastEventAt),
    lastRestockedAt: iso(restockedAt.get(`${r.locationId}\u0000${r.titleId}`) ?? null),
  }));
}

/** Sålda pack per dag, titel och automat ur lagerhändelser av typen sale. Inga belopp. */
export async function querySalesCounts(
  tx: Tx,
  orgId: string,
  range: Period,
  scope: DataScope,
): Promise<SalesCountRow[]> {
  const conditions: SQL[] = [
    eq(s.stockEvents.organizationId, orgId),
    eq(s.stockEvents.kind, "sale"),
    gte(s.stockEvents.businessDate, range.start),
    lte(s.stockEvents.businessDate, range.end),
  ];
  if (scope.machineId) conditions.push(eq(s.stockLocations.machineId, scope.machineId));
  if (scope.storeId) {
    conditions.push(isNotNull(s.stockLocations.machineId));
    conditions.push(
      placedInStore(
        sql`${s.stockLocations.machineId}`,
        sql`${s.stockEvents.businessDate}`,
        orgId,
        scope.storeId,
      ),
    );
  }
  const rows = await tx
    .select({
      date: s.stockEvents.businessDate,
      titleId: s.stockEvents.titleId,
      machineId: s.stockLocations.machineId,
      units: sql<number>`(-sum(${s.stockEvents.quantity}))::int`,
    })
    .from(s.stockEvents)
    .innerJoin(
      s.stockLocations,
      and(
        eq(s.stockLocations.id, s.stockEvents.locationId),
        eq(s.stockLocations.organizationId, s.stockEvents.organizationId),
      ),
    )
    .where(and(...conditions))
    .groupBy(s.stockEvents.businessDate, s.stockEvents.titleId, s.stockLocations.machineId)
    .orderBy(asc(s.stockEvents.businessDate), asc(s.stockEvents.titleId));
  return rows.map((r) => ({ ...r, units: Number(r.units) }));
}

/**
 * Försäljningar i lagret som order utan belopp (amountOre 0), för regler som bara räknar
 * pack (påfyllning, tyst automat) när användaren inte får se order. orderedAt är händelsens tid.
 */
export async function querySaleEventsAsOrders(
  tx: Tx,
  orgId: string,
  range: Period,
): Promise<AnalyticsOrder[]> {
  const rows = await tx
    .select({
      id: s.stockEvents.id,
      orderId: s.stockEvents.orderId,
      titleId: s.stockEvents.titleId,
      machineId: s.stockLocations.machineId,
      businessDate: s.stockEvents.businessDate,
      occurredAt: s.stockEvents.occurredAt,
    })
    .from(s.stockEvents)
    .innerJoin(
      s.stockLocations,
      and(
        eq(s.stockLocations.id, s.stockEvents.locationId),
        eq(s.stockLocations.organizationId, s.stockEvents.organizationId),
      ),
    )
    .where(
      and(
        eq(s.stockEvents.organizationId, orgId),
        eq(s.stockEvents.kind, "sale"),
        gte(s.stockEvents.businessDate, range.start),
        lte(s.stockEvents.businessDate, range.end),
      ),
    )
    .orderBy(asc(s.stockEvents.occurredAt), asc(s.stockEvents.seq));
  return rows.map((r) => ({
    id: r.orderId ?? r.id,
    externalId: "",
    titleId: r.titleId,
    machineId: r.machineId,
    businessDate: r.businessDate,
    amountOre: 0,
    orderedAt: r.occurredAt.toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Datakällor och Att göra
// ---------------------------------------------------------------------------

export interface DataSourceSummary {
  readonly lastSyncedAt: Date | null;
  readonly sources: number;
  readonly failing: number;
}

/** Senaste synk och status över datakällorna. Påfyllaren kan inte läsa dem (RLS). */
export async function queryDataSources(tx: Tx, orgId: string): Promise<DataSourceSummary> {
  const rows = await tx
    .select({
      lastSyncedAt: sql<string | null>`max(${s.dataSources.lastSyncedAt})`,
      sources: sql<number>`count(*)::int`,
      failing: sql<number>`(count(*) filter (where ${s.dataSources.status} = 'error'))::int`,
    })
    .from(s.dataSources)
    .where(and(eq(s.dataSources.organizationId, orgId), isNull(s.dataSources.archivedAt)));
  const r = rows[0];
  return {
    lastSyncedAt: r?.lastSyncedAt ? new Date(r.lastSyncedAt) : null,
    sources: Number(r?.sources ?? 0),
    failing: Number(r?.failing ?? 0),
  };
}

export async function queryReportRecipients(tx: Tx, orgId: string) {
  return tx
    .select({
      id: s.reportRecipients.id,
      name: s.reportRecipients.name,
      kind: s.reportRecipients.kind,
      storeId: s.reportRecipients.storeId,
      active: s.reportRecipients.active,
    })
    .from(s.reportRecipients)
    .where(eq(s.reportRecipients.organizationId, orgId));
}

export async function queryReportDeliveries(tx: Tx, orgId: string, since: IsoDate) {
  const rows = await tx
    .select({
      id: s.reportDeliveries.id,
      recipientId: s.reportDeliveries.recipientId,
      reportKind: s.reports.kind,
      periodStart: s.reports.periodStart,
      periodEnd: s.reports.periodEnd,
      storeId: s.reports.storeId,
      status: s.reportDeliveries.status,
      sentAt: s.reportDeliveries.sentAt,
    })
    .from(s.reportDeliveries)
    .innerJoin(
      s.reports,
      and(
        eq(s.reports.id, s.reportDeliveries.reportId),
        eq(s.reports.organizationId, s.reportDeliveries.organizationId),
      ),
    )
    .where(and(eq(s.reportDeliveries.organizationId, orgId), gte(s.reports.periodEnd, since)));
  return rows.map((r) => ({ ...r, sentAt: iso(r.sentAt) }));
}

/**
 * Sparade avbockningar i Att göra, om tabellen public.todo_dismissals finns
 * (organization_id, key, fingerprint). Saknas den, eller har den andra kolumner, blir
 * resultatet tomt (frågan körs i en savepoint så att transaktionen överlever).
 */
export async function queryTodoDismissals(
  tx: Tx,
  orgId: string,
): Promise<Array<{ key: string; fingerprint: string }>> {
  const exists = await tx.execute(
    sql`select to_regclass('public.todo_dismissals') is not null as present`,
  );
  if (!(Array.from(exists)[0] as { present?: boolean } | undefined)?.present) return [];
  try {
    return await tx.transaction(async (sp) => {
      const result = await sp.execute(
        sql`select key::text as key, fingerprint::text as fingerprint
            from public.todo_dismissals where organization_id = ${orgId}::uuid`,
      );
      return Array.from(result).map((r) => {
        const row = r as { key: string; fingerprint: string };
        return { key: row.key, fingerprint: row.fingerprint };
      });
    });
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Att göra: avtal, rapportutkast och larm (ägare och admin)
// ---------------------------------------------------------------------------

/** Butiksavtalen som inte är arkiverade, i den form @/analytics/contracts vill ha. */
export async function queryActiveContracts(tx: Tx, orgId: string): Promise<Contract[]> {
  const rows = await tx
    .select({
      id: s.contracts.id,
      storeId: s.contracts.storeId,
      name: s.contracts.title,
      validFrom: s.contracts.validFrom,
      validTo: s.contracts.validTo,
      noticeMonths: s.contracts.noticePeriodMonths,
      noticeDays: s.contracts.noticePeriodDays,
      renewalMonths: s.contracts.renewalMonths,
      terminatedOn: s.contracts.terminatedOn,
    })
    .from(s.contracts)
    .where(and(eq(s.contracts.organizationId, orgId), isNull(s.contracts.archivedAt)))
    .orderBy(asc(s.contracts.validFrom), asc(s.contracts.id));
  return rows;
}

/**
 * Rapportutkast som väntar på granskning: senaste versionen av varje rapport (typ, period,
 * butik) med period som slutar `since` eller senare, som inte är godkänd och inte skickad.
 * Samma regel som arkivet i Rapporter (`reportStatuses`).
 */
export async function queryReportDrafts(
  tx: Tx,
  orgId: string,
  since: IsoDate,
): Promise<ReportDraftRef[]> {
  const reports = await tx
    .select({
      id: s.reports.id,
      kind: s.reports.kind,
      periodStart: s.reports.periodStart,
      periodEnd: s.reports.periodEnd,
      storeId: s.reports.storeId,
      generatedAt: s.reports.generatedAt,
    })
    .from(s.reports)
    .where(and(eq(s.reports.organizationId, orgId), gte(s.reports.periodEnd, since)));
  if (reports.length === 0) return [];
  const ids = reports.map((r) => r.id);
  const [approvals, deliveries] = await Promise.all([
    tx
      .select({ reportId: s.reportApprovals.reportId })
      .from(s.reportApprovals)
      .where(
        and(eq(s.reportApprovals.organizationId, orgId), inArray(s.reportApprovals.reportId, ids)),
      ),
    tx
      .select({ reportId: s.reportDeliveries.reportId, status: s.reportDeliveries.status })
      .from(s.reportDeliveries)
      .where(
        and(
          eq(s.reportDeliveries.organizationId, orgId),
          inArray(s.reportDeliveries.reportId, ids),
        ),
      ),
  ]);
  const approved = new Set(approvals.map((a) => a.reportId));
  const deliveriesBy = new Map<string, { status: DeliveryStatus }[]>();
  for (const d of deliveries) {
    const list = deliveriesBy.get(d.reportId) ?? [];
    list.push({ status: d.status });
    deliveriesBy.set(d.reportId, list);
  }
  const statuses = reportStatuses(
    reports.map((r) => ({
      id: r.id,
      kind: r.kind,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      storeId: r.storeId,
      generatedAt: r.generatedAt.toISOString(),
      approved: approved.has(r.id),
      deliveries: deliveriesBy.get(r.id) ?? [],
    })),
  );
  return reports
    .filter((r) => statuses.get(r.id) === "draft")
    .map((r) => ({
      id: r.id,
      reportKind: r.kind,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      storeId: r.storeId,
      generatedAt: r.generatedAt.toISOString(),
    }));
}

/** Öppna larm (incidenter) som inte strukits av ett annat larm. */
export async function queryOpenAlerts(tx: Tx, orgId: string): Promise<AlertRef[]> {
  const rows = await tx
    .select({
      id: s.alerts.id,
      key: s.alerts.incidentKey,
      kind: s.alerts.kind,
      severity: s.alerts.severity,
      machineId: s.alerts.machineId,
      titleId: s.alerts.titleId,
      title: s.alerts.title,
      message: s.alerts.message,
      triggeredAt: s.alerts.triggeredAt,
      acknowledgedAt: s.alerts.acknowledgedAt,
    })
    .from(s.alerts)
    .where(
      and(
        eq(s.alerts.organizationId, orgId),
        eq(s.alerts.status, "open"),
        isNull(s.alerts.suppressedBy),
        isNotNull(s.alerts.incidentKey),
      ),
    )
    .orderBy(asc(s.alerts.triggeredAt), asc(s.alerts.id))
    .limit(200);
  return rows.map((r) => ({
    id: r.id,
    key: r.key ?? r.id,
    kind: r.kind,
    severity: r.severity,
    machineId: r.machineId,
    titleId: r.titleId,
    title: r.title ?? "",
    detail: r.message ?? "",
    openedAt: r.triggeredAt.toISOString(),
    acknowledged: r.acknowledgedAt !== null,
  }));
}
