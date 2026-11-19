/**
 * Daglig kontroll: GET /api/cron/kontroll med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Kontrollerar varje organisations egna siffror en gång per dag (src/server/self-check):
 * samma vinst på alla sidor, Awish = appen, påfyllningar som nådde Awish, synken,
 * avräkningarna och datahygienen. Läser bara; sparar resultatet och larmar ägare och
 * admin när en kontroll inte går igenom. Schemaläggs av pg_cron i Supabase varje timme
 * 03:52–09:52 UTC (20261220110100_cron_svar_och_fler_tillfallen.sql,
 * private.kontroll_cron_tick); routen kör varje organisation första gången efter 05:00
 * lokal tid, så de senare tillfällena gör ingenting när kontrollen har kört och är nya
 * försök när den inte har det. Larmjobbet (/api/cron/larm, Vercel Cron) kör den också, så
 * att kontrollen inte hänger på en enda schemaläggare.
 *
 * Anslutningen till databasen kontrolleras först (freshServiceDb): en anslutning som dött
 * medan funktionen låg fryst byts ut i stället för att körningen hänger tills den dödas.
 *
 * Utan CRON_SECRET svarar routen 503 och gör ingenting.
 */

import { freshServiceDb } from "@/db/client";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { CRON_JOBS, withCronMonitor } from "@/server/monitoring/cron-monitor";
import { syncWatchAlertsForAll } from "@/server/monitoring/watch";
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
  const db = await freshServiceDb();
  const result = await withCronMonitor(CRON_JOBS.kontroll, () => runScheduledSelfChecks(db));
  // Vakten: stänger "Kontrollen har inte körts" när den nu har kört (och larmar om det andra).
  await syncWatchAlertsForAll(db);
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
