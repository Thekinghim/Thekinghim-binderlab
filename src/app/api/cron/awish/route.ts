/**
 * Awish-synken: GET /api/cron/awish med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Hämtar nya order från Awish officiella gRPC-API för alla aktiva datakällor av typen
 * awish_grpc (src/server/awish/sync.ts). Schemaläggs var femte minut av pg_cron i
 * Supabase (migreringarna 20261103090000_awish_api.sql och
 * 20261112000000_awish_synk_var_femte_minut.sql, private.awish_cron_tick), eftersom
 * Vercel Hobby bara tillåter en körning om dagen. Samma CRON_SECRET och samma kontroll
 * som de andra cron-routerna.
 *
 * Kör som systemroll (getServiceDb): organisation och datakälla kommer ur databasen,
 * aldrig ur anropet. Utan CRON_SECRET svarar routen 503 och gör ingenting.
 */

import { getServiceDb } from "@/db/client";
import { getServerEnv } from "@/lib/env";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { runOfflineAlerts } from "@/server/awish/offline-alerts";
import { resolveAppBaseUrl } from "@/server/request-info";
import { syncAllAwishSources } from "@/server/awish/sync";
import { publishAllDueCampaigns } from "@/server/campaigns/service";
import { CRON_JOBS, withCronMonitor } from "@/server/monitoring/cron-monitor";
import { invalidateUnpaidSettlements } from "@/server/settlements/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function runOfflineAlertsAfterSync(
  request: Request,
  orgIds: string[],
  stockOrgIds: string[],
) {
  let baseUrl: string | null = null;
  try {
    baseUrl = resolveAppBaseUrl(getServerEnv(), request.headers);
  } catch {
    // Utan adress köas utskicken; larmjobbet skickar dem.
  }
  try {
    return await runOfflineAlerts(getServiceDb(), orgIds, { baseUrl, stockOrgIds });
  } catch (error) {
    console.error("[awish] offlinelarm", error instanceof Error ? error.message : "fel");
    return null;
  }
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
  // Offlinelarmet: larmjobbet körs bara en gång om dagen, så organisationer med en automat
  // som är offline (eller ett öppet offlinelarm) utvärderas här direkt efter synken
  // (src/server/awish/offline-alerts.ts). Ett fel här stoppar inte synken.
  const offline = await runOfflineAlertsAfterSync(
    request,
    // Även när orderna misslyckades: anslutningen sparas före orderna (sync.ts).
    result.sources.filter((s) => s.skipped === null).map((s) => s.organizationId),
    // "Slut i automat" direkt: organisationerna där ett fack just blev tomt i den här
    // synken, eller vid Uppdatera i Fyll på sedan förra synken.
    result.sources
      .filter((s) => (s.stockDropped?.length ?? 0) > 0 || s.alertCheckDue === true)
      .map((s) => s.organizationId),
  );
  // Nya order ändrar obetalda avräkningar: menyns räknare, Hem och Att göra räknar om dem.
  for (const org of new Set(
    result.sources.filter((s) => (s.summary?.new ?? 0) > 0).map((s) => s.organizationId),
  )) {
    invalidateUnpaidSettlements(org);
  }
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
      offlineAlerts: offline
        ? {
            organizations: offline.organizations.length,
            sent: offline.deliveries?.sent ?? 0,
          }
        : null,
    },
    allFailed(result) ? 500 : 200,
  );
}
