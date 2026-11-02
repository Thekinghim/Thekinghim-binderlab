/**
 * Vercel cron (vercel.json): den 1:a varje månad kl. 05:17 UTC skapas utkast för
 * föregående månad (src/server/reports/drafts). Skyddad med CRON_SECRET: Vercel skickar
 * "Authorization: Bearer <CRON_SECRET>". Utan hemlighet svarar routen 503 och gör inget.
 * Inget skickas härifrån; utkasten väntar på godkännande i Rapporter.
 */

import { timingSafeEqual } from "node:crypto";

import { getServiceDb } from "@/db/client";
import { CRON_JOBS, withCronMonitor } from "@/server/monitoring/cron-monitor";
import { createMonthlyDrafts } from "@/server/reports/drafts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(header: string | null, secret: string): boolean {
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(header ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return Response.json(
      { ok: false, error: "CRON_SECRET saknas (minst 16 tecken)." },
      { status: 503 },
    );
  }
  if (!authorized(request.headers.get("authorization"), secret)) {
    return Response.json({ ok: false, error: "Obehörig." }, { status: 401 });
  }
  // Sentry Cron Monitors (när SENTRY_DSN finns): larmar när körningen uteblir eller felar.
  // Fel per organisation blir dessutom larm på Drift (src/server/monitoring).
  const results = await withCronMonitor(
    CRON_JOBS.rapporter,
    () => createMonthlyDrafts(getServiceDb()),
    (rs) => rs.every((r) => r.errors.length === 0),
  );
  const created = results.reduce((n, r) => n + r.created.length, 0);
  const errors = results.flatMap((r) => r.errors.map((e) => `${r.organizationId}: ${e}`));
  if (errors.length > 0) console.error("[cron/rapporter]", errors);
  return Response.json({
    ok: errors.length === 0,
    created,
    organizations: results.map((r) => ({
      id: r.organizationId,
      month: r.month,
      created: r.created.length,
      skipped: r.skipped,
      errors: r.errors.length,
    })),
  });
}
