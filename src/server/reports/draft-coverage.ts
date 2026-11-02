/**
 * Vilka månadsutkast som behövs (en butiksrapport per butik som hade en automat under
 * månaden, bokföringen och delägarna), och stängning av larmet `report_drafts:<månad>` när
 * alla finns, oavsett om jobbet eller en ägare för hand skapade dem.
 *
 * Används av det schemalagda jobbet (./drafts.ts) och av createReportFor (./service.ts).
 */

import "server-only";

import { and, eq, sql } from "drizzle-orm";

import { getServiceDb, type Tx } from "@/db/client";
import * as s from "@/db/schema";
import { monthEnd, monthStart, type IsoMonth } from "@/domain";
import { queryPlacements } from "@/server/data/core/queries";
import { safely, type MonitoringDeps } from "@/server/monitoring/failures";
import { resolveSystemAlert } from "@/server/monitoring/system-alerts";

import { DB_KIND, type ReportType } from "./kinds";
import { storesPlacedIn } from "./sources";

export interface WantedDraft {
  readonly type: ReportType;
  readonly storeId: string | null;
}

/** Utkasten som månaden ska ha. */
export async function wantedDraftsTx(
  tx: Tx,
  orgId: string,
  month: IsoMonth,
): Promise<WantedDraft[]> {
  const period = { start: monthStart(month), end: monthEnd(month) };
  const placements = await queryPlacements(tx, orgId);
  return [
    ...storesPlacedIn(placements, period).map((storeId) => ({ type: "butik" as const, storeId })),
    { type: "bokforing", storeId: null },
    { type: "delagare", storeId: null },
  ];
}

/** Utkasten som saknas för månaden (ingen rapport av samma typ, period och butik). */
export async function missingDraftsTx(
  tx: Tx,
  orgId: string,
  month: IsoMonth,
): Promise<WantedDraft[]> {
  const wanted = await wantedDraftsTx(tx, orgId, month);
  const existing = await tx
    .select({ kind: s.reports.kind, storeId: s.reports.storeId })
    .from(s.reports)
    .where(
      and(
        eq(s.reports.organizationId, orgId),
        eq(s.reports.periodStart, monthStart(month)),
        eq(s.reports.periodEnd, monthEnd(month)),
      ),
    );
  return wanted.filter(
    (w) => !existing.some((e) => e.kind === DB_KIND[w.type] && e.storeId === w.storeId),
  );
}

/**
 * Stänger larmet för månadens utkast när inga utkast saknas längre (t.ex. när ägaren har
 * skapat dem för hand under Rapporter, som larmet uppmanar till). Systemroll; kastar aldrig.
 * Ger antalet stängda larm.
 */
export async function closeDraftsAlertIfComplete(
  deps: MonitoringDeps,
  organizationId: string,
  month: IsoMonth,
): Promise<number> {
  return safely(
    "stänga larm för månadsutkast",
    async () => {
      const db = deps.db ?? getServiceDb();
      const key = `report_drafts:${month}`;
      const open = Array.from(
        await db.execute<{ id: string }>(sql`
          select id from public.alerts
          where organization_id = ${organizationId}::uuid and incident_key = ${key}
            and alert_group = 'system' and status = 'open'
          limit 1`),
      );
      if (open.length === 0) return 0;
      const missing = await db.transaction((tx) => missingDraftsTx(tx, organizationId, month));
      if (missing.length > 0) return 0;
      return resolveSystemAlert(db, organizationId, key, deps.now);
    },
    0,
  );
}
