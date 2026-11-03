/**
 * GET /butiker/avrakning/{id} → avräkningen som PDF (HTML när PDF inte kan skrivas ut här).
 * Ägare, admin och läsare (läses som användaren med RLS). Påfyllaren får 403; en avräkning
 * i en annan organisation är 404 som ett okänt id.
 */

import { htmlResponse, notFound, pdfResponse } from "@/app/signera/[token]/responses";
import { AuthorizationError, isUuid } from "@/server/access";
import { requireViewer } from "@/server/data/core";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";
import { settlementDocumentFor, SettlementError } from "@/server/settlements/service";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound("Avräkningen finns inte.");
  try {
    const viewer = await requireViewer();
    const doc = await settlementDocumentFor(viewer, id);
    if (!pdfStatus().configured) return htmlResponse(doc.html);
    const bytes = await getPdfRenderer().renderHtml(doc.html);
    return pdfResponse(bytes, doc.fileName);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return new Response("Du har inte behörighet.", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (error instanceof SettlementError) return notFound(error.message);
    throw error;
  }
}
