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

import { freshServiceDb, getServiceDb } from "@/db/client";
import { getServerEnv } from "@/lib/env";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { runOfflineAlerts } from "@/server/awish/offline-alerts";
import { resolveAppBaseUrl } from "@/server/request-info";
import { syncAllAwishSources } from "@/server/awish/sync";
import { publishAllDueCampaigns } from "@/server/campaigns/service";
import { runSaleNotifications, SALE_PUSH_BUDGET_MS } from "@/server/sales-push/job";
import { CRON_JOBS, withCronMonitor } from "@/server/monitoring/cron-monitor";
import { syncWatchAlertsForAll } from "@/server/monitoring/watch";
import { invalidateUnpaidSettlements } from "@/server/settlements/cache";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
/** Försäljningsnotiserna slutar ta om hand nya köp så här långt in i körningen (av 60 s). */
const SALE_PUSH_STOP_MS = 50_000;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

function appBaseUrl(request: Request): string | null {
  try {
    return resolveAppBaseUrl(getServerEnv(), request.headers);
  } catch {
    return null;
  }
}

/**
 * Notis vid varje försäljning (src/server/sales-push/job.ts), sist i körningen: orderna är
 * redan sparade. Högst SALE_PUSH_BUDGET_MS och aldrig efter SALE_PUSH_STOP_MS från
 * körningens start (det som inte hinns med tas om hand nästa körning). Kastar aldrig och
 * stoppar inget; ett fel loggas och svaret blir null.
 */
async function runSaleNotificationsAfterSync(startedAt: number) {
  try {
    const deadline = Math.min(Date.now() + SALE_PUSH_BUDGET_MS, startedAt + SALE_PUSH_STOP_MS);
    const run = await runSaleNotifications(getServiceDb(), { deadline });
    return {
      orders: run.organizations.reduce((n, o) => n + o.orders, 0),
      sent: run.organizations.reduce((n, o) => n + o.sent, 0),
    };
  } catch (error) {
    console.error("[awish] försäljningsnotiser", error instanceof Error ? error.message : "fel");
    return null;
  }
}

async function runOfflineAlertsAfterSync(
  request: Request,
  orgIds: string[],
  stockOrgIds: string[],
) {
  // Utan adress köas utskicken; larmjobbet skickar dem.
  const baseUrl = appBaseUrl(request);
  try {
    return await runOfflineAlerts(getServiceDb(), orgIds, { baseUrl, stockOrgIds });
  } catch (error) {
    console.error("[awish] offlinelarm", error instanceof Error ? error.message : "fel");
    return null;
  }
}

export async function GET(request: Request): Promise<Response> {
  const startedAt = Date.now();
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
  const db = await freshServiceDb();
  const result = await withCronMonitor(
    CRON_JOBS.awish,
    () => syncAllAwishSources({ db }),
    (r) => !allFailed(r),
  );
  // Vakten, före utskicken nedan så att ett nytt larm går ut i samma körning: hämtningen
  // som har stannat eller misslyckats flera gånger i rad, kontrollen eller larmjobbet som
  // inte har kört, och när ingen nås av larmen. Det här jobbet går var femte minut och
  // larmar därför om de jobb som bara går en gång per dygn. Ett fel här stoppar inget.
  const watch = await syncWatchAlertsForAll(db);
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
  // Notis vid varje försäljning till dem som har slagit på den: nya köp i den här synken (och
  // i en Synka nu sedan förra körningen). Sist, med en egen tidsgräns, så att en långsam
  // push-tjänst inte håller upp kampanjerna. Ett fel här stoppar inte synken.
  const salePush = await runSaleNotificationsAfterSync(startedAt);
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
      watch,
      salePush,
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
