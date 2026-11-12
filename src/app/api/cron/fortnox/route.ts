/**
 * Fortnox: GET /api/cron/fortnox med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Bokför det som ska vara bokfört i Fortnox för varje organisation som kopplat Fortnox och
 * slagit på skarpt läge (src/server/fortnox/sync.ts). I torrkörning skickas ingenting.
 * Schemaläggs en gång per natt av pg_cron i Supabase (migreringen 20261220000000_fortnox.sql,
 * private.fortnox_cron_tick). En andra körning samma natt skickar inget två gånger: varje
 * verifikat har en stabil nyckel i utkorgen.
 *
 * Utan CRON_SECRET svarar routen 503 och gör ingenting. Svaret innehåller bara antal och
 * organisationens id, aldrig token eller verifikatens innehåll.
 */

import { getServiceDb } from "@/db/client";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { runFortnoxForAll } from "@/server/fortnox/sync";
import { CRON_JOBS, withCronMonitor } from "@/server/monitoring/cron-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return json({ error: "CRON_SECRET är inte satt (minst 16 tecken). Inget bokförs." }, 503);
  }
  if (!cronAuthorized(request.headers.get("authorization"), secret)) {
    return json({ error: "Obehörig." }, 401);
  }
  const result = await withCronMonitor(
    CRON_JOBS.fortnox,
    () => runFortnoxForAll(getServiceDb()),
    (r) => r.organizations.every((o) => o.status !== "error"),
  );
  const failed = result.organizations.filter((o) => o.status === "error").length;
  return json(
    { ok: failed === 0, ranAt: result.ranAt, organizations: result.organizations },
    failed > 0 && failed === result.organizations.length ? 500 : 200,
  );
}
