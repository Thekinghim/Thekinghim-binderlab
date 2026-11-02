/**
 * Schemalagt jobb (Vercel cron den 1:a varje månad, /api/cron/rapporter): skapar utkast
 * för föregående månad i varje organisation, så att de väntar på granskning i Rapporter
 * och syns via Att göra ("Skicka butiksrapporten …"). Inget skickas: utskick kräver att
 * en ägare eller admin godkänner.
 *
 * Utkast skapas för varje butik som hade en automat under månaden, för bokföringen och
 * för delägarna. Finns redan en rapport av samma typ, period och butik görs inget, så
 * jobbet kan köras om utan dubbletter.
 *
 * Körs som systemet (getServiceDb, kringgår RLS) eftersom ingen användare finns. Det är
 * ett av de dokumenterade systemjobben i docs/miljoer.md.
 */

import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import { addMonths, monthEnd, monthOf, monthStart, type IsoMonth } from "@/domain";
import { businessToday } from "@/server/data/core/loaders";
import { queryPlacements } from "@/server/data/core/queries";

import { DB_KIND, type ReportType } from "./kinds";
import { insertReportTx } from "./service";
import { buildSnapshot } from "./snapshot";
import { loadSnapshotInput, storesPlacedIn } from "./sources";

export interface DraftResult {
  readonly organizationId: string;
  readonly month: IsoMonth;
  readonly created: { type: ReportType; storeId: string | null; reportId: string }[];
  skipped: number;
  readonly errors: string[];
}

/** Skapar månadens utkast i alla aktiva organisationer. */
export async function createMonthlyDrafts(db: Db, now: Date = new Date()): Promise<DraftResult[]> {
  const orgs = await db
    .select({ id: s.organizations.id, timezone: s.organizations.timezone })
    .from(s.organizations)
    .where(isNull(s.organizations.archivedAt));
  const out: DraftResult[] = [];
  for (const org of orgs) out.push(await draftsForOrganization(db, org.id, org.timezone, now));
  return out;
}

export async function draftsForOrganization(
  db: Db,
  orgId: string,
  timeZone: string,
  now: Date,
): Promise<DraftResult> {
  const month = addMonths(monthOf(businessToday(now, timeZone)), -1);
  const period = { start: monthStart(month), end: monthEnd(month) };
  const result: DraftResult = { organizationId: orgId, month, created: [], skipped: 0, errors: [] };

  const placements = await db.transaction((tx) => queryPlacements(tx, orgId));
  const wanted: { type: ReportType; storeId: string | null }[] = [
    ...storesPlacedIn(placements, period).map((storeId) => ({ type: "butik" as const, storeId })),
    { type: "bokforing", storeId: null },
    { type: "delagare", storeId: null },
  ];

  for (const w of wanted) {
    try {
      await db.transaction(async (tx) => {
        const existing = await tx
          .select({ id: s.reports.id, storeId: s.reports.storeId })
          .from(s.reports)
          .where(
            and(
              eq(s.reports.organizationId, orgId),
              eq(s.reports.kind, DB_KIND[w.type]),
              eq(s.reports.periodStart, period.start),
              eq(s.reports.periodEnd, period.end),
            ),
          );
        if (existing.some((e) => e.storeId === w.storeId)) {
          result.skipped += 1;
          return;
        }
        const input = await loadSnapshotInput(tx, {
          organizationId: orgId,
          type: w.type,
          month,
          storeId: w.storeId,
          now: now.toISOString(),
        });
        const reportId = await insertReportTx(tx, orgId, buildSnapshot(input), null);
        result.created.push({ ...w, reportId });
      });
    } catch (error) {
      result.errors.push(
        `${w.type}${w.storeId ? ` ${w.storeId}` : ""}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return result;
}
