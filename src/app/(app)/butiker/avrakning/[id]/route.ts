/**
 * GET /butiker/avrakning/{id} → avräkningen som PDF, eller som HTML att skriva ut när PDF
 * inte kan skapas här (ingen Chromium, eller utskriften misslyckas). Ägare, admin och
 * läsare (läses som användaren med RLS). Påfyllaren får 403; en avräkning i en annan
 * organisation är 404 som ett okänt id.
 */

import { notFound } from "@/app/signera/[token]/responses";
import { AuthorizationError, isUuid } from "@/server/access";
import { requireViewer } from "@/server/data/core";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";
import { settlementDocumentResponse } from "@/server/settlements/document-response";
import { settlementDocumentFor, SettlementError } from "@/server/settlements/service";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound("Avräkningen finns inte.");
  try {
    const viewer = await requireViewer();
    const doc = await settlementDocumentFor(viewer, id);
    return await settlementDocumentResponse(
      doc,
      pdfStatus().configured ? (html) => getPdfRenderer().renderHtml(html) : null,
    );
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
