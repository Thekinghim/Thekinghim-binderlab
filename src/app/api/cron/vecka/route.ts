/**
 * Veckosammanfattningen: GET /api/cron/vecka med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Skickar måndagens notis (push) till ägare och admin som har den på: sålda pack och vinst
 * förra veckan mot veckan innan, bästa produkten och antalet i Att göra
 * (src/server/weekly/job.ts). Schemaläggs av pg_cron i Supabase måndagar 05:07, 06:07 och 07:07 UTC
 * (20261123000000_veckosammanfattning.sql, private.vecka_cron_tick); routen skickar första
 * tillfället från 07:00 lokal tid och aldrig två gånger för samma vecka, så en andra körning
 * gör ingenting.
 *
 * Utan CRON_SECRET svarar routen 503 och gör ingenting.
 */

import { getServiceDb } from "@/db/client";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { CRON_JOBS, withCronMonitor } from "@/server/monitoring/cron-monitor";
import { runWeeklySummaries } from "@/server/weekly/job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return json({ error: "CRON_SECRET är inte satt (minst 16 tecken). Inget skickas." }, 503);
  }
  if (!cronAuthorized(request.headers.get("authorization"), secret)) {
    return json({ error: "Obehörig." }, 401);
  }
  const result = await withCronMonitor(CRON_JOBS.vecka, () => runWeeklySummaries(getServiceDb()));
  const ran = result.organizations.filter((o) => o.status === "ran");
  const sum = (key: "sent" | "failed" | "errors") => ran.reduce((n, o) => n + (o[key] ?? 0), 0);
  const errors = sum("errors");
  const attempted = ran.reduce((n, o) => n + (o.sent ?? 0) + (o.failed ?? 0) + (o.errors ?? 0), 0);
  return json(
    {
      ranAt: result.ranAt,
      ran: ran.length,
      sent: sum("sent"),
      failed: sum("failed"),
      errors,
      organizations: result.organizations,
    },
    attempted > 0 && errors === attempted ? 500 : 200,
  );
}
