/**
 * Bokföringen: GET /api/cron/bokforing med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Tar fram och sparar förra månadens paket för varje organisation med order, och en ny
 * version av ett sparat paket vars underlag ändrats (src/server/bokforing/stored.ts).
 * Schemaläggs en gång om dagen av pg_cron i Supabase (migreringen
 * 20261104130000_bokforing_paket.sql, private.bokforing_cron_tick). Samma underlag ger
 * inget nytt paket, så en andra körning samma dag gör ingenting.
 *
 * Utan CRON_SECRET svarar routen 503 och gör ingenting.
 */

import { cronAuthorized } from "@/server/alerts/cron-auth";
import { runBokforingForAll } from "@/server/bokforing/stored";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";

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
      { error: "CRON_SECRET är inte satt (minst 16 tecken). Bokföringen körs inte." },
      503,
    );
  }
  if (!cronAuthorized(request.headers.get("authorization"), secret)) {
    return json({ error: "Obehörig." }, 401);
  }
  const renderPdf = pdfStatus().configured
    ? (html: string) => getPdfRenderer().renderHtml(html)
    : null;
  const result = await runBokforingForAll({ renderPdf });
  const failed = result.organizations.filter((o) => o.status === "error").length;
  return json(
    { ok: failed === 0, organizations: result.organizations },
    failed > 0 && failed === result.organizations.length ? 500 : 200,
  );
}
