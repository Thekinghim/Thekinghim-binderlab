/**
 * Indata till maskinhälsan och larmreglerna, lästa i en transaktion för en organisation.
 *
 * Används både av sidorna (transaktion som användaren, RLS) och av larmjobbet (systemroll).
 * Försäljningen läses ur lagrets försäljningshändelser (en per order, med betaltidpunkten
 * och utan belopp), så att samma uträkning fungerar för påfyllaren som inte får se order.
 *
 * Leverantörens maskindata (online/offline/fel) finns inte ännu: Awish-adaptern för gRPC
 * väntar på specifikationen (docs/awish.md). Tills dess härleds statusen ur försäljningen,
 * och `vendorSignals` är tomt med `vendorConfigured: false`.
 */

import "server-only";

import { and, asc, eq, gte, inArray, isNull, lte } from "drizzle-orm";

import type { DataSourceRef, ImportRunRef } from "@/analytics/alerts";
import type { MachineSignal } from "@/analytics/health";
import type { AnalyticsOrder, StockLevelRef } from "@/analytics/todos";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { addDays, type IsoDate } from "@/domain";
import {
  queryMachines,
  queryPlacements,
  querySaleEventsAsOrders,
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
}

/** Automater, titlar, försäljning (70 dagar), lager i automaterna. */
export async function loadHealthData(tx: Tx, orgId: string, today: IsoDate): Promise<HealthData> {
  const placements = await queryPlacements(tx, orgId);
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
    .filter((r) => r.locationKind === "machine" && r.machineId !== null)
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
    signals: [],
    vendorConfigured: false,
  };
}

/** Förväntat hämtintervall per leverantör (minuter); null = manuell uppladdning. */
function expectedInterval(provider: string): number | null {
  return provider === "awish_grpc" ? 10 : null;
}

/** Datakällor och importer de senaste 14 dagarna (för importlarmet). Ägare/admin/läsare eller systemet. */
export async function loadImportData(
  tx: Tx,
  orgId: string,
  now: Date,
): Promise<{ sources: DataSourceRef[]; imports: ImportRunRef[] }> {
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
