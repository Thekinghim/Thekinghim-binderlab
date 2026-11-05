/**
 * POST /installningar/export  "Exportera all data": organisationens egna data som CSV-filer
 * i en ZIP. Bara ägaren, högst 3 gånger per timme och organisation (räknas i databasen,
 * se src/server/export/service.ts). POST och samma ursprung, så att en länk eller bild på
 * en annan webbplats inte kan starta en export.
 *
 * Svaret strömmas i delar så att stora exporter inte stoppas av plattformens gräns för ett
 * buffrat svar.
 */

import { AuthorizationError, getActiveOrganization, getSessionUser } from "@/server/session";
import { ExportRateLimitError, exportOrganizationDataFor } from "@/server/export/service";

export const dynamic = "force-dynamic";
/** En stor organisation (100 000 order) tar några sekunder; marginal för databasen. */
export const maxDuration = 60;

const TEXT = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" };

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return request.headers.get("sec-fetch-site") !== "cross-site";
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function text(status: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { ...TEXT, ...extra } });
}

export async function POST(request: Request): Promise<Response> {
  if (!sameOrigin(request)) return text(403, "Fel ursprung.");
  const user = await getSessionUser();
  if (!user) return text(401, "Du är inte inloggad.");
  const organization = await getActiveOrganization();
  if (!organization) return text(403, "Du är inte medlem i någon organisation.");

  let result: Awaited<ReturnType<typeof exportOrganizationDataFor>>;
  try {
    result = await exportOrganizationDataFor({ user, organization });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return text(403, "Bara ägaren kan exportera all data.");
    }
    if (error instanceof ExportRateLimitError) {
      return text(429, error.message, { "retry-after": "3600" });
    }
    console.error("[export] exporten misslyckades", error);
    return text(500, "Exporten misslyckades. Försök igen om en stund.");
  }

  const parts = result.parts;
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[i];
      i += 1;
      if (part) controller.enqueue(part);
      else controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${result.fileName}"`,
      "content-length": String(result.bytes),
      "cache-control": "private, no-store",
      "x-export-id": result.id,
    },
  });
}
