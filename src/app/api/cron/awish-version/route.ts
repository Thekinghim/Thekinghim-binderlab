/**
 * Awishs version: GET /api/cron/awish-version med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Läser Version från Awishs gRPC-API för varje aktiv Awish API-källa (inte demo) och
 * larmar när versionen byts (src/server/awish/control/version.ts). Provar också TLS igen
 * när den sparade anslutningen är den okrypterade. Schemaläggs varje timme (minut 41) av
 * pg_cron (20261229200000_awish_styrning.sql, private.awish_version_cron_tick).
 *
 * Kör som systemroll: organisationerna kommer ur databasen, aldrig ur anropet. Utan
 * CRON_SECRET svarar routen 503 och gör ingenting. Inga hemligheter i svaret.
 */

import { freshServiceDb } from "@/db/client";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { runAwishVersionChecks } from "@/server/awish/control/version";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return json({ error: "CRON_SECRET är inte satt (minst 16 tecken)." }, 503);
  }
  if (!cronAuthorized(request.headers.get("authorization"), secret)) {
    return json({ error: "Obehörig." }, 401);
  }
  const db = await freshServiceDb();
  const results = await runAwishVersionChecks({ db });
  const allFailed = results.length > 0 && results.every((r) => !r.ok);
  return json(
    {
      ok: !allFailed,
      organizations: results.map((r) => ({
        ok: r.ok,
        version: r.version,
        changed: r.changed,
        message: r.message,
      })),
    },
    allFailed ? 500 : 200,
  );
}
