/**
 * Larmjobbet: GET /api/cron/larm med `Authorization: Bearer <CRON_SECRET>`.
 *
 * Utvärderar maskinhälsa, lager, importer och avvikande dag för varje organisation, sparar
 * incidenterna (samma problem larmar en gång) och skickar utskicken som är på tur (push,
 * e-post, sms). Schemaläggs var 10:e minut (Vercel Cron skickar CRON_SECRET som Bearer-token).
 *
 * Kör som systemroll (getServiceDb), eftersom ingen användare är inloggad. Proxyn släpper
 * igenom /api/cron/* utan session; skyddet är hemligheten här. Utan CRON_SECRET svarar
 * routen 503 och gör ingenting.
 */

import { getServiceDb } from "@/db/client";
import { getServerEnv } from "@/lib/env";
import { cronAuthorized } from "@/server/alerts/cron-auth";
import { runAlertJob } from "@/server/alerts/job";
import { resolveAppBaseUrl } from "@/server/request-info";

export const maxDuration = 60;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret || secret.length < 16) {
    return json(
      { error: "CRON_SECRET är inte satt (minst 16 tecken). Larmjobbet körs inte." },
      503,
    );
  }
  if (!cronAuthorized(request.headers.get("authorization"), secret)) {
    return json({ error: "Obehörig." }, 401);
  }
  let baseUrl: string;
  try {
    baseUrl = resolveAppBaseUrl(getServerEnv(), request.headers);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "APP_URL saknas." }, 500);
  }
  const result = await runAlertJob(getServiceDb(), { baseUrl });
  const failed = result.organizations.filter((o) => o.status === "failed").length;
  return json(result, failed > 0 && failed === result.organizations.length ? 500 : 200);
}
