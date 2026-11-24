/**
 * Larmjobbet: GET /api/cron/larm med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Utvärderar maskinhälsa, lager, importer och avvikande dag för varje organisation, sparar
 * incidenterna (samma problem larmar en gång) och skickar utskicken som är på tur (push,
 * e-post, sms). Schemaläggs var 10:e minut (Vercel Cron skickar CRON_SECRET som Bearer-token).
 *
 * Kör som systemroll (getServiceDb), eftersom ingen användare är inloggad. Proxyn släpper
 * igenom /api/cron/* utan session; skyddet är hemligheten här. Utan CRON_SECRET svarar
 * routen 503 och gör ingenting.
 */

import { freshServiceDb } from "@/db/client";
import { getServerEnv } from "@/lib/env";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { runAlertJob } from "@/server/alerts/job";
import { CRON_JOBS, withCronMonitor } from "@/server/monitoring/cron-monitor";
import { recordSettlementRuns } from "@/server/monitoring/failures";
import { syncWatchAlertsForAll } from "@/server/monitoring/watch";
import { resolveAppBaseUrl } from "@/server/request-info";
import { runScheduledSelfChecks } from "@/server/self-check/job";
import { remindUnpaidForAll } from "@/server/payouts/reminders";
import { runPayoutJob } from "@/server/payouts/service";
import { createMonthlySettlements } from "@/server/settlements/service";

// 300 s: larmen först, sedan avräkningarna och sist dagens kontroll om den inte har kört.
export const maxDuration = 300;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return json(
      { error: "CRON_SECRET är inte satt (minst 16 tecken). Larmjobbet körs inte." },
      503,
    );
  }
  if (!cronAuthorized(request.headers.get("authorization"), secret)) {
    return json({ error: "Obehörig." }, 401);
  }
  let baseUrl: string;
  try {
    baseUrl = resolveAppBaseUrl(getServerEnv(), request.headers);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "APP_URL saknas." }, 500);
  }
  // Sentry Cron Monitors (när SENTRY_DSN finns): larmar när körningen uteblir eller felar.
  const allFailed = (r: Awaited<ReturnType<typeof runAlertJob>>) => {
    const failed = r.organizations.filter((o) => o.status === "failed").length;
    return failed > 0 && failed === r.organizations.length;
  };
  const db = await freshServiceDb();
  const result = await withCronMonitor(
    CRON_JOBS.larm,
    () => runAlertJob(db, { baseUrl }),
    (r) => !allFailed(r),
  );
  // Butikernas avräkningar (src/server/settlements): förra månadens saknade skapas från den
  // 2:a, och obetalda räknas om så att butiken i portalen ser samma belopp som ägaren.
  // Ett fel här påverkar inte larmen.
  let settlements: { created: number; refreshed: number; errors: number } | null = null;
  try {
    const runs = await createMonthlySettlements(db, new Date(), {
      create: "not-first",
    });
    settlements = {
      created: runs.reduce((n, r) => n + r.created, 0),
      refreshed: runs.reduce((n, r) => n + r.refreshed, 0),
      errors: runs.reduce((n, r) => n + r.errors.length, 0),
    };
    // En butik som inte gick att räkna ska höras (larmet job:avrakningar), inte bara loggas.
    await recordSettlementRuns({ db }, runs);
  } catch (error) {
    console.error("[cron/larm] avräkningar", error instanceof Error ? error.message : error);
  }
  // Utbetalningarna från Nayax (src/server/payouts): utkasten räknas om efter avräkningarna,
  // så att nästa utbetalning får "Justering" för en månad som just fått sin avräkning.
  // Saknade sammanfattningar skrivs, gamla utkast tas bort och obetalda belopp påminns om.
  let payouts: Record<string, number> | null = null;
  try {
    const job = await runPayoutJob(db, new Date());
    const reminders = await remindUnpaidForAll(db, new Date());
    payouts = { ...job, reminders };
  } catch (error) {
    console.error("[cron/larm] utbetalningar", error instanceof Error ? error.message : error);
  }
  // Dagens kontroll, om den inte redan har kört (pg_cron anropar /api/cron/kontroll): två
  // schemaläggare som inte beror på varandra. Sist, så att den aldrig kostar larmen tid.
  let selfChecks: { ran: number; errors: number } | null = null;
  try {
    const checks = await runScheduledSelfChecks(db);
    const ran = checks.organizations.filter((o) => o.status !== "skipped");
    selfChecks = { ran: ran.length, errors: ran.filter((o) => o.status === "error").length };
  } catch (error) {
    console.error("[cron/larm] kontrollen", error instanceof Error ? error.message : error);
  }
  // Vakten: larmar när kontrollen eller hämtningen från Awish har stannat, eller ingen nås.
  const watch = await syncWatchAlertsForAll(db);
  return json(
    { ...result, settlements, payouts, selfChecks, watch },
    allFailed(result) ? 500 : 200,
  );
}
