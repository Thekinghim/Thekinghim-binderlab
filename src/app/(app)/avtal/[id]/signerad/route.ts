/**
 * GET /avtal/{id}/signerad → den signerade PDF:en (avtalet och signaturbladet). Ägare,
 * admin och läsare (signaturen läses som användaren med RLS i signedDocumentFor).
 * Påfyllaren får 403; ett avtal i en annan organisation är 404 som ett okänt id.
 */

import { htmlResponse, notFound, pdfResponse } from "@/app/signera/[token]/responses";
import { currentViewer } from "@/server/accounting";
import { AuthorizationError, isUuid } from "@/server/access";
import { signedDocumentFor, SigningError } from "@/server/contracts/signing";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return notFound("Avtalet finns inte.");
  try {
    const viewer = await currentViewer();
    const doc = await signedDocumentFor(viewer, id);
    return doc.kind === "pdf" ? pdfResponse(doc.bytes, doc.fileName) : htmlResponse(doc.html);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return new Response(error.message, {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    if (error instanceof SigningError) return notFound(error.message);
    throw error;
  }
}
