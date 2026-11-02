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
import { recordDraftsOutcome, recordJobOutcome } from "@/server/monitoring/failures";
import { captureToSentry } from "@/server/monitoring/sentry";
import { addMonths, monthEnd, monthOf, monthStart, type IsoMonth } from "@/domain";
import { businessToday } from "@/server/data/core/loaders";

import { wantedDraftsTx } from "./draft-coverage";
import { DB_KIND, type ReportType } from "./kinds";
import { insertReportTx } from "./service";
import { buildSnapshot } from "./snapshot";
import { loadSnapshotInput } from "./sources";

export interface DraftResult {
  readonly organizationId: string;
  readonly month: IsoMonth;
  readonly created: { type: ReportType; storeId: string | null; reportId: string }[];
  skipped: number;
  readonly errors: string[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Skapar månadens utkast i alla aktiva organisationer. Ett fel i en organisation stoppar
 * inte de andra: det blir ett larm (job:rapporter) för just den organisationen. Kan inte
 * ens organisationerna läsas kastas felet (routen svarar 500, Sentry får händelsen och
 * Sentry Cron Monitors larmar).
 */
export async function createMonthlyDrafts(
  db: Db,
  now: Date = new Date(),
  options: {
    /** Bara de här organisationerna (tester). Standard: alla aktiva. */
    readonly organizationIds?: readonly string[];
    /** Utkasten för en organisation (tester kan byta ut den). */
    readonly draftsFor?: typeof draftsForOrganization;
  } = {},
): Promise<DraftResult[]> {
  const draftsFor = options.draftsFor ?? draftsForOrganization;
  let orgs: { id: string; timezone: string }[];
  try {
    orgs = (
      await db
        .select({ id: s.organizations.id, timezone: s.organizations.timezone })
        .from(s.organizations)
        .where(isNull(s.organizations.archivedAt))
    ).filter((o) => !options.organizationIds || options.organizationIds.includes(o.id));
  } catch (error) {
    await captureToSentry({
      error,
      message: `Jobbet för månadsutkast kunde inte läsa organisationerna: ${messageOf(error)}`,
      tags: { area: "job", kind: "job_failed", job: "rapporter" },
      fingerprint: ["job_failed", "rapporter", "organisationer"],
    });
    throw error;
  }
  const out: DraftResult[] = [];
  for (const org of orgs) {
    try {
      out.push(await draftsFor(db, org.id, org.timezone, now));
      await recordJobOutcome(
        { db, now },
        { organizationId: org.id, job: "rapporter", error: null },
      );
    } catch (error) {
      await recordJobOutcome({ db, now }, { organizationId: org.id, job: "rapporter", error });
      out.push({
        organizationId: org.id,
        month: addMonths(monthOf(businessToday(now, org.timezone)), -1),
        created: [],
        skipped: 0,
        errors: [`jobbet: ${messageOf(error)}`],
      });
    }
  }
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

  let wanted: { type: ReportType; storeId: string | null }[] = [];
  try {
    wanted = await db.transaction((tx) => wantedDraftsTx(tx, orgId, month));
  } catch (error) {
    // Utan placeringarna vet jobbet inte vilka utkast som behövs: ett larm för månaden.
    result.errors.push(`placeringar: ${messageOf(error)}`);
  }

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
      result.errors.push(`${w.type}${w.storeId ? ` ${w.storeId}` : ""}: ${messageOf(error)}`);
    }
  }
  // Felövervakning: misslyckade utkast ger larm på Drift och Sentry-händelse; ett lyckat
  // jobb stänger månadens larm.
  await recordDraftsOutcome(
    { db, now },
    { organizationId: orgId, month, created: result.created.length, errors: result.errors },
  );
  return result;
}
