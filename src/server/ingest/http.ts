/**
 * HTTP för ingest-API:t: CORS (bara chrome-extension://), JSON-svar och fel.
 *
 * - CORS släpper bara igenom ursprung som börjar med chrome-extension:// (tillägget).
 *   En begäran från en vanlig webbsida (Origin: https://...) nekas, även med giltig
 *   token. En begäran helt utan Origin (curl, felsökning) tas emot: token är skyddet.
 * - Inga cookies: svaret sätter aldrig Set-Cookie, Access-Control-Allow-Credentials
 *   skickas aldrig, och sessionen läses inte (proxyn släpper /api/ingest/* utan
 *   inloggning, src/server/auth/paths.ts).
 * - Svaren cachas aldrig (no-store).
 */

import { clientIp } from "@/server/request-info";

import { IngestError } from "./body";

const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;

export function isExtensionOrigin(origin: string | null): origin is string {
  return origin !== null && EXTENSION_ORIGIN.test(origin);
}

/** CORS-huvuden för ett tillåtet ursprung, annars inga. */
export function corsHeaders(origin: string | null): Record<string, string> {
  if (!isExtensionOrigin(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export function json(
  body: unknown,
  status: number,
  origin: string | null,
  extra: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...corsHeaders(origin), ...extra },
  });
}

/** Svaret för ett fel: { ok: false, error, code }. */
export function errorResponse(error: unknown, origin: string | null): Response {
  if (error instanceof IngestError) {
    return json(
      { ok: false, error: error.message, code: error.code },
      error.status,
      origin,
      error.retryAfterSeconds ? { "retry-after": String(error.retryAfterSeconds) } : {},
    );
  }
  console.error("[ingest]", error);
  return json(
    { ok: false, error: "Något gick fel i Binderlab. Tillägget försöker igen.", code: "failed" },
    500,
    origin,
  );
}

/** Ursprunget, om begäran får tas emot; annars ett färdigt 403-svar. */
export function checkOrigin(request: Request): { origin: string | null; denied: Response | null } {
  const origin = request.headers.get("origin");
  if (origin === null || isExtensionOrigin(origin)) {
    return { origin, denied: null };
  }
  return {
    origin: null,
    denied: json(
      {
        ok: false,
        error: "Bara Binderlabs Chrome-tillägg får anropa det här API:t.",
        code: "forbidden",
      },
      403,
      null,
    ),
  };
}

/** Svar på CORS-förfrågan (OPTIONS). */
export function preflight(request: Request): Response {
  const origin = request.headers.get("origin");
  if (!isExtensionOrigin(origin)) {
    return new Response(null, { status: 403, headers: { "cache-control": "no-store" } });
  }
  return new Response(null, {
    status: 204,
    headers: { "cache-control": "no-store", ...corsHeaders(origin) },
  });
}

/** Nyckel för begränsningen av ogiltiga tokens: klientens IP (samma regel som inloggningen). */
export function clientKeyOf(request: Request): string {
  return clientIp(request.headers);
}
