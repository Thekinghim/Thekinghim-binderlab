/**
 * AI-rådgivaren: GET /api/cron/ai med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Tar fram dagens förslag för varje organisation med försäljning de senaste 30 dagarna
 * (src/server/assistant/advisor). Schemaläggs en gång om dagen av pg_cron i Supabase
 * (migreringen 20261104090000_ai_radgivare.sql, private.ai_cron_tick). En andra körning
 * samma dag gör ingenting. Stannar när månadens AI-budget är slut.
 *
 * Utan CRON_SECRET svarar routen 503 och gör ingenting.
 */

import { getServiceDb } from "@/db/client";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { runAdvisorForAll } from "@/server/assistant/advisor/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return json({ error: "CRON_SECRET är inte satt (minst 16 tecken). Förslagen körs inte." }, 503);
  }
  if (!cronAuthorized(request.headers.get("authorization"), secret)) {
    return json({ error: "Obehörig." }, 401);
  }
  const result = await runAdvisorForAll({ db: getServiceDb() });
  const failed = result.organizations.filter((o) => o.status === "error").length;
  return json(
    { ok: failed === 0, organizations: result.organizations },
    failed > 0 && failed === result.organizations.length ? 500 : 200,
  );
}
