/**
 * POST /api/ingest/awish: en batch ordrar (högst 500 rader) eller en hjärtslag från
 * Binderlabs Chrome-tillägg, med "Authorization: Bearer <synk-token>".
 *
 * Proxyn släpper /api/ingest/* utan session (src/server/auth/paths.ts): skyddet är
 * token, som slås upp på sin sha256 och skriver som den som skapade den, med RLS
 * (src/server/ingest/service.ts). CORS bara för chrome-extension://, inga cookies.
 * Se docs/awish-tillagg.md.
 */

import { getServiceDb } from "@/db/client";
import {
  authenticate,
  checkOrigin,
  clientKeyOf,
  errorResponse,
  ingestBatch,
  ingestLimiters,
  json,
  preflight,
  readIngestBody,
} from "@/server/ingest";

export const maxDuration = 60;

export function OPTIONS(request: Request): Response {
  return preflight(request);
}

export async function POST(request: Request): Promise<Response> {
  const { origin, denied } = checkOrigin(request);
  if (denied) return denied;
  try {
    const deps = { db: getServiceDb(), limiters: ingestLimiters() };
    const ctx = await authenticate(
      deps,
      request.headers.get("authorization"),
      clientKeyOf(request),
    );
    const body = await readIngestBody(request);
    const result = await ingestBatch(deps, ctx, body);
    return json({ ok: true, ...result }, 200, origin);
  } catch (error) {
    return errorResponse(error, origin);
  }
}
