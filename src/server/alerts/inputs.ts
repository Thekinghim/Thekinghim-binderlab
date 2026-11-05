/**
 * Indata till maskinhälsan och larmreglerna, lästa i en transaktion för en organisation.
 *
 * Används både av sidorna (transaktion som användaren, RLS) och av larmjobbet (systemroll).
 * Försäljningen läses ur lagrets försäljningshändelser (en per order, med betaltidpunkten
 * och utan belopp), så att samma uträkning fungerar för påfyllaren som inte får se order.
 *
 * Leverantörens maskindata: Awish-synken sparar is_online per automat
 * (public.machine_connectivity, regeln i @/analytics/health/connectivity). Läget blir
 * maskinhändelser (online/offline efter 20 minuter) som maskinhälsan använder före
 * försäljningen. Automater utan läge härleds ur försäljningen som förut.
 *
 * Försäljningens täckning (public.sales_data_until) säger hur långt den importerade
 * försäljningen räcker per automat. Awish CSV laddas upp för hand en gång per dag, så fram
 * till nästa fil är försäljningen efter den senaste filen okänd, inte noll. Maskinhälsan
 * räknar därför tystnaden bara fram till täckningen.
 */

import "server-only";

import { and, asc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";

import type { DataSourceRef, ImportRunRef } from "@/analytics/alerts";
import {
  connectivitySignals,
  machineHealth,
  type HealthInput,
  type MachineConnectivity,
  type MachineHealth,
  type MachineSignal,
  type SalesCoverage,
} from "@/analytics/health";
import type { AnalyticsOrder, StockLevelRef } from "@/analytics/todos";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { addDays, type IsoDate } from "@/domain";
import {
  queryMachines,
  queryPlacements,
  querySaleEventsAsOrders,
  isKnownStock,
  queryStock,
  queryTitles,
} from "@/server/data/core/queries";
import type { MachineRecord, TitleRecord } from "@/server/data/core";

/** Dagar bakåt som läses: 8 veckors historik för veckomönstret och samma veckodag, plus marginal. */
export const HEALTH_LOOKBACK_DAYS = 70;

export interface HealthData {
  readonly machines: MachineRecord[];
  readonly titles: TitleRecord[];
  readonly orders: AnalyticsOrder[];
  readonly stock: StockLevelRef[];
  readonly signals: MachineSignal[];
  /** Sant när leverantörens maskindata finns (Awish gRPC eller webhook). */
  readonly vendorConfigured: boolean;
  /** Hur långt försäljningen är importerad, per automat (tom om ingen datakälla har order). */
  readonly coverage: CoverageRow[];
  /** Anslutningen enligt Awish per automat (tom utan Awish API). */
  readonly connectivity: MachineConnectivity[];
}

/** Anslutningen per automat (public.machine_connectivity). Alla roller utom butiken. */
export async function loadConnectivity(tx: Tx, orgId: string): Promise<MachineConnectivity[]> {
  const res = await tx.execute(
    sql`select machine_id, online, status, seen_at, online_at, offline_since, back_online_at,
               last_offline_from
        from public.machine_connectivity(${orgId}::uuid)`,
  );
  const iso = (v: unknown): string | null =>
    v === null || v === undefined
      ? null
      : (v instanceof Date ? v : new Date(String(v))).toISOString();
  return (Array.from(res) as Record<string, unknown>[]).map((r) => ({
    machineId: String(r.machine_id),
    online: typeof r.online === "boolean" ? r.online : null,
    status: r.status === null || r.status === undefined ? null : String(r.status),
    seenAt: iso(r.seen_at),
    onlineAt: iso(r.online_at),
    offlineSince: iso(r.offline_since),
    backOnlineAt: iso(r.back_online_at),
    lastOfflineFrom: iso(r.last_offline_from),
  }));
}

/** En rad ur public.sales_data_until. */
export interface CoverageRow {
  readonly machineId: string;
  readonly dataSourceId: string | null;
  readonly sourceName: string | null;
  /** Sant för källor som laddas upp för hand (Awish CSV). */
  readonly manual: boolean;
  /** Senaste kända försäljning i källan (manuell) eller senaste hämtning (automatisk). */
  readonly dataUntil: Date | null;
  /** Senaste lyckade import från källan. */
  readonly syncedAt: Date | null;
  /** Automatens senaste order oavsett titel (även order vars titel inte matchats). */
  readonly lastOrderAt: Date | null;
}

/** Täckningen per automat. Bara tidpunkter: fungerar för alla roller utom butiken. */
export async function loadCoverage(tx: Tx, orgId: string, at: Date): Promise<CoverageRow[]> {
  const res = await tx.execute(
    sql`select machine_id, data_source_id, source_name, manual, data_until, synced_at, last_order_at
        from public.sales_data_until(${orgId}::uuid, ${at.toISOString()}::timestamptz)`,
  );
  const toDate = (v: unknown): Date | null =>
    v === null || v === undefined ? null : v instanceof Date ? v : new Date(String(v));
  return (Array.from(res) as Record<string, unknown>[]).map((r) => ({
    machineId: String(r.machine_id),
    dataSourceId: r.data_source_id === null ? null : String(r.data_source_id),
    sourceName: r.source_name === null ? null : String(r.source_name),
    manual: r.manual === true,
    dataUntil: toDate(r.data_until),
    syncedAt: toDate(r.synced_at),
    lastOrderAt: toDate(r.last_order_at),
  }));
}

/** Indata till machineHealth ur HealthData (samma för sidorna och larmjobbet). */
export function healthInputOf(data: HealthData, timeZone: string): HealthInput {
  return {
    orders: data.orders,
    machines: data.machines,
    signals: data.signals,
    stock: data.stock,
    salesCoverage: data.coverage.map((c): SalesCoverage => ({
      machineId: c.machineId,
      until: c.dataUntil?.toISOString() ?? null,
      sourceName: c.sourceName,
      lastSaleAt: c.lastOrderAt?.toISOString() ?? null,
    })),
    options: { timeZone },
  };
}

/**
 * Maskinhälsan ur datan: samma uträkning på Drift, Automater och i larmjobbet, så att en
 * automat har samma status överallt.
 */
export function healthOf(data: HealthData, timeZone: string, now: Date): MachineHealth[] {
  return machineHealth(healthInputOf(data, timeZone), now);
}

/**
 * Tidpunkten som all försäljning är känd till (den tidigaste täckningen bland källorna som
 * har automater), eller null när ingen källa har order. För en manuell källa räcker en
 * import efter tidpunkten också (filen bör då innehålla allt fram till exporten).
 */
export function knownUntil(coverage: readonly CoverageRow[]): Date | null {
  const bySource = new Map<string, number>();
  for (const c of coverage) {
    if (!c.dataSourceId || !c.dataUntil) continue;
    const ms = Math.max(c.dataUntil.getTime(), c.syncedAt?.getTime() ?? 0);
    bySource.set(c.dataSourceId, ms);
  }
  if (bySource.size === 0) return null;
  return new Date(Math.min(...bySource.values()));
}

/** Automater, titlar, försäljning (70 dagar), lager i automaterna. */
export async function loadHealthData(
  tx: Tx,
  orgId: string,
  today: IsoDate,
  now: Date = new Date(),
): Promise<HealthData> {
  const placements = await queryPlacements(tx, orgId);
  const coverage = await loadCoverage(tx, orgId, now);
  const connectivity = await loadConnectivity(tx, orgId);
  const [machines, titles, orders, stockRows] = await Promise.all([
    queryMachines(tx, orgId, placements, today),
    queryTitles(tx, orgId),
    querySaleEventsAsOrders(tx, orgId, {
      start: addDays(today, -HEALTH_LOOKBACK_DAYS),
      end: today,
    }),
    queryStock(tx, orgId),
  ]);
  const stock = stockRows
    .filter((r) => r.locationKind === "machine" && r.machineId !== null && isKnownStock(r))
    .map((r) => ({
      machineId: r.machineId as string,
      titleId: r.titleId,
      onHand: r.onHand,
      lastRestockedAt: r.lastRestockedAt,
    }));
  return {
    machines: machines.filter((m) => !m.archived),
    titles,
    orders,
    stock,
    signals: connectivitySignals(connectivity, now),
    vendorConfigured: connectivity.length > 0,
    coverage,
    connectivity,
  };
}

/**
 * Förväntat intervall mellan importer per leverantör (minuter). gRPC hämtas var tionde
 * minut. CSV laddas upp för hand varje dag: utan ny försäljning på 36 timmar larmar
 * importregeln att datat inte är importerat (ett datalarm, inte ett maskinlarm).
 */
export function expectedInterval(provider: string): number | null {
  if (provider === "awish_grpc") return 10;
  if (provider === "awish_csv") return 36 * 60;
  return null;
}

/** Datakällor och importer de senaste 14 dagarna (för importlarmet). Ägare/admin/läsare eller systemet. */
export async function loadImportData(
  tx: Tx,
  orgId: string,
  now: Date,
  coverage: readonly CoverageRow[] = [],
): Promise<{ sources: DataSourceRef[]; imports: ImportRunRef[] }> {
  const untilBySource = new Map<string, Date>();
  for (const c of coverage) {
    if (c.dataSourceId && c.dataUntil) untilBySource.set(c.dataSourceId, c.dataUntil);
  }
  const sources = await tx
    .select({
      id: s.dataSources.id,
      name: s.dataSources.name,
      provider: s.dataSources.provider,
      status: s.dataSources.status,
      lastSyncedAt: s.dataSources.lastSyncedAt,
    })
    .from(s.dataSources)
    .where(and(eq(s.dataSources.organizationId, orgId), isNull(s.dataSources.archivedAt)));
  const since = new Date(now.getTime() - 14 * 86_400_000);
  const runs = sources.length
    ? await tx
        .select({
          id: s.imports.id,
          dataSourceId: s.imports.dataSourceId,
          status: s.imports.status,
          startedAt: s.imports.startedAt,
          finishedAt: s.imports.finishedAt,
          createdAt: s.imports.createdAt,
          rowsTotal: s.imports.rowsTotal,
          rowsError: s.imports.rowsError,
          rowsConflict: s.imports.rowsConflict,
          fileName: s.imports.fileName,
        })
        .from(s.imports)
        .where(
          and(
            eq(s.imports.organizationId, orgId),
            inArray(
              s.imports.dataSourceId,
              sources.map((x) => x.id),
            ),
            gte(s.imports.createdAt, since),
            lte(s.imports.createdAt, now),
          ),
        )
        .orderBy(asc(s.imports.createdAt))
    : [];
  return {
    sources: sources.map((x) => ({
      id: x.id,
      name: x.name,
      provider: x.provider,
      status: x.status,
      lastSyncedAt: x.lastSyncedAt ? x.lastSyncedAt.toISOString() : null,
      expectedIntervalMinutes: expectedInterval(x.provider),
      manual: x.provider === "awish_csv",
      dataUntil: untilBySource.get(x.id)?.toISOString() ?? null,
    })),
    imports: runs.map((r) => ({
      id: r.id,
      dataSourceId: r.dataSourceId,
      status: r.status,
      startedAt: r.startedAt ? r.startedAt.toISOString() : null,
      finishedAt: r.finishedAt ? r.finishedAt.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      rowsTotal: r.rowsTotal,
      rowsError: r.rowsError,
      rowsConflict: r.rowsConflict,
      fileName: r.fileName,
    })),
  };
}

/** Kolumnerna i public.alerts som sidorna och jobbet läser. */
export const alertColumns = {
  id: s.alerts.id,
  incidentKey: s.alerts.incidentKey,
  alertGroup: s.alerts.alertGroup,
  kind: s.alerts.kind,
  severity: s.alerts.severity,
  status: s.alerts.status,
  machineId: s.alerts.machineId,
  titleId: s.alerts.titleId,
  title: s.alerts.title,
  message: s.alerts.message,
  evidence: s.alerts.evidence,
  link: s.alerts.link,
  triggeredAt: s.alerts.triggeredAt,
  lastSeenAt: s.alerts.lastSeenAt,
  closedAt: s.alerts.closedAt,
  lastNotifiedAt: s.alerts.lastNotifiedAt,
  notifiedSeverity: s.alerts.notifiedSeverity,
  notifyCount: s.alerts.notifyCount,
  occurrences: s.alerts.occurrences,
  reopenCount: s.alerts.reopenCount,
  oneShot: s.alerts.oneShot,
  acknowledgedAt: s.alerts.acknowledgedAt,
  acknowledgedBy: s.alerts.acknowledgedBy,
  resolvedNotifiedAt: s.alerts.resolvedNotifiedAt,
  suppressedBy: s.alerts.suppressedBy,
};
