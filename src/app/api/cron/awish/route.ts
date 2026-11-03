/**
 * Awish-synken: GET /api/cron/awish med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Hämtar nya order från Awish officiella gRPC-API för alla aktiva datakällor av typen
 * awish_grpc (src/server/awish/sync.ts). Schemaläggs var tionde minut av pg_cron i
 * Supabase (migreringen 20261103090000_awish_api.sql, private.awish_cron_tick), eftersom
 * Vercel Hobby bara tillåter en körning om dagen. Samma CRON_SECRET och samma kontroll
 * som de andra cron-routerna.
 *
 * Kör som systemroll (getServiceDb): organisation och datakälla kommer ur databasen,
 * aldrig ur anropet. Utan CRON_SECRET svarar routen 503 och gör ingenting.
 */

import { getServiceDb } from "@/db/client";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { syncAllAwishSources } from "@/server/awish/sync";
import { publishAllDueCampaigns } from "@/server/campaigns/service";
import { CRON_JOBS, withCronMonitor } from "@/server/monitoring/cron-monitor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return json(
      { error: "CRON_SECRET är inte satt (minst 16 tecken). Awish-synken körs inte." },
      503,
    );
  }
  if (!cronAuthorized(request.headers.get("authorization"), secret)) {
    return json({ error: "Obehörig." }, 401);
  }
  const allFailed = (r: Awaited<ReturnType<typeof syncAllAwishSources>>) =>
    r.sources.length > 0 && r.sources.every((s) => !s.ok);
  const result = await withCronMonitor(
    CRON_JOBS.awish,
    () => syncAllAwishSources({ db: getServiceDb() }),
    (r) => !allFailed(r),
  );
  // Kampanjer med en senare start som användaren redan har bekräftat (Kampanjer): de vars
  // starttid har passerat skickas till Awish nu. Ett fel här stoppar inte synken.
  const campaigns = await publishAllDueCampaigns({ db: getServiceDb() }).catch((error: unknown) => {
    console.error("[kampanjer] schemalagda kampanjer", error instanceof Error ? error.name : "fel");
    return null;
  });
  // Inga hemligheter och inga order i svaret, bara räknare och felmeddelanden.
  return json(
    {
      ok: !allFailed(result),
      sources: result.sources.map((s) => ({
        id: s.dataSourceId,
        ok: s.ok,
        skipped: s.skipped,
        message: s.message,
        pages: s.pages,
        fetched: s.fetched,
        new: s.summary?.new ?? 0,
        historyDone: s.historyDone,
      })),
      campaigns: campaigns ? { shown: campaigns.shown, failed: campaigns.failed } : null,
    },
    allFailed(result) ? 500 : 200,
  );
}
