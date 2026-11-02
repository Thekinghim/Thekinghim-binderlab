/**
 * GET /avtal/{id}/fil → avtalsfilen. Ägare, admin och läsare (kontrolleras mot databasen i
 * readContractFileFor, filen läses som användaren). Påfyllaren får 403.
 */

import {
  AccountingError,
  contractFileStore,
  currentViewer,
  readContractFileFor,
} from "@/server/accounting";
import { AuthorizationError, isUuid } from "@/server/access";

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

/** Filnamn för Content-Disposition: ASCII-reserv plus UTF-8 enligt RFC 5987. */
function disposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return text(404, "Avtalet finns inte.");
  try {
    const viewer = await currentViewer();
    const file = await readContractFileFor(viewer, id, { fileStore: await contractFileStore() });
    return new Response(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "content-type": file.contentType,
        "content-disposition": disposition(file.fileName),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return text(403, error.message);
    if (error instanceof AccountingError) return text(404, error.message);
    throw error;
  }
}
