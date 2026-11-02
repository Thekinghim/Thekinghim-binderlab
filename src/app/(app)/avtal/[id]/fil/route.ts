/**
 * GET /avtal/{id}/fil → avtalsfilen. Ägare, admin och läsare (kontrolleras mot databasen i
 * readContractFileFor, filen läses som användaren). Påfyllaren får 403.
 *
 * Säkerhet (filen kommer från en användare och serveras på appens egen domän):
 * - Typen är alltid en av de tillåtna och har kontrollerats mot innehållet när filen lästes.
 * - Bara PDF visas i webbläsaren (inline); bilder och Word laddas ned (attachment).
 * - nosniff, och för allt som inte är PDF en CSP med sandbox och default-src 'none', så att
 *   inget i filen kan köras i användarens session även om en webbläsare skulle tolka den.
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
function disposition(kind: "inline" | "attachment", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
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
    const pdf = file.contentType === "application/pdf";
    const headers: Record<string, string> = {
      "content-type": file.contentType,
      "content-disposition": disposition(pdf ? "inline" : "attachment", file.fileName),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    };
    if (!pdf) headers["content-security-policy"] = "sandbox; default-src 'none'";
    return new Response(Buffer.from(file.bytes), { status: 200, headers });
  } catch (error) {
    if (error instanceof AuthorizationError) return text(403, error.message);
    if (error instanceof AccountingError) return text(404, error.message);
    throw error;
  }
}
