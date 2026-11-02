/**
 * GET /api/ingest/awish/status: tilläggets statusfråga med "Authorization: Bearer
 * <synk-token>". Svarar med datakällan, senaste synk och de senaste ordernumren, så
 * att tillägget vet hur långt bakåt i Awish orderlista det behöver läsa.
 * Se src/app/api/ingest/awish/route.ts och docs/awish-tillagg.md.
 */

import { getServiceDb } from "@/db/client";
import {
  authenticate,
  checkOrigin,
  clientKeyOf,
  errorResponse,
  ingestLimiters,
  ingestStatus,
  json,
  preflight,
} from "@/server/ingest";

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

export async function GET(request: Request): Promise<Response> {
  const { origin, denied } = checkOrigin(request);
  if (denied) return denied;
  try {
    const deps = { db: getServiceDb(), limiters: ingestLimiters() };
    const ctx = await authenticate(
      deps,
      request.headers.get("authorization"),
      clientKeyOf(request),
    );
    return json(await ingestStatus(deps, ctx), 200, origin);
  } catch (error) {
    return errorResponse(error, origin);
  }
}
