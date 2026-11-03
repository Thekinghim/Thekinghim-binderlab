/**
 * GET /ekonomi/bokforing/kvitto/{id} → kvittots fil. Ägare, admin och läsare; filen läses
 * med användarens session (storage-policyerna gäller). Typen är den som kontrollerades vid
 * uppladdningen; svaret får aldrig tolkas som något annat (nosniff, sandlåda).
 */

import { AccountingError, currentViewer } from "@/server/accounting";
import { AuthorizationError } from "@/server/access";
import { readReceiptFor } from "@/server/bokforing/service";

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  try {
    const viewer = await currentViewer();
    const file = await readReceiptFor(viewer, id);
    const ascii = file.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
    return new Response(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.fileName).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return text(403, error.message);
    if (error instanceof AccountingError) return text(404, error.message);
    throw error;
  }
}
