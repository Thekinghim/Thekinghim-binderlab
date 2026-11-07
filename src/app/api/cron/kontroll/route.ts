/**
 * Daglig kontroll: GET /api/cron/kontroll med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Kontrollerar varje organisations egna siffror en gång per dag (src/server/self-check):
 * samma vinst på alla sidor, Awish = appen, påfyllningar som nådde Awish, synken,
 * avräkningarna och datahygienen. Läser bara; sparar resultatet och larmar ägare och
 * admin när en kontroll inte går igenom. Schemaläggs av pg_cron i Supabase 03:37 och
 * 04:37 UTC (20261114000000_daglig_kontroll.sql, private.kontroll_cron_tick); routen kör
 * varje organisation första gången efter 05:00 lokal tid, så en andra körning samma dag
 * gör ingenting.
 *
 * Utan CRON_SECRET svarar routen 503 och gör ingenting.
 */

import { getServiceDb } from "@/db/client";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { CRON_JOBS, withCronMonitor } from "@/server/monitoring/cron-monitor";
import { runScheduledSelfChecks } from "@/server/self-check/job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return json(
      { error: "CRON_SECRET är inte satt (minst 16 tecken). Kontrollen körs inte." },
      503,
    );
  }
  if (!cronAuthorized(request.headers.get("authorization"), secret)) {
    return json({ error: "Obehörig." }, 401);
  }
  const result = await withCronMonitor(CRON_JOBS.kontroll, () =>
    runScheduledSelfChecks(getServiceDb()),
  );
  const ran = result.organizations.filter((o) => o.status !== "skipped");
  const errors = ran.filter((o) => o.status === "error").length;
  return json(
    {
      ranAt: result.ranAt,
      ran: ran.length,
      failed: ran.filter((o) => o.status === "failed").length,
      errors,
      organizations: result.organizations,
    },
    ran.length > 0 && errors === ran.length ? 500 : 200,
  );
}
