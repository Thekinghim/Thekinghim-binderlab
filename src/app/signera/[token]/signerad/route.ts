/**
 * GET /signera/{token}/signerad → den signerade PDF:en (avtalet och signaturbladet), de
 * första 30 dagarna efter signeringen. Utan PDF-utskrift: HTML för utskrift (utan skript).
 */

import { signedDocumentForLink, SigningError } from "@/server/contracts/signing";

import { htmlResponse, notFound, pdfResponse } from "../responses";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await ctx.params;
  try {
    const doc = await signedDocumentForLink(token);
    return doc.kind === "pdf"
      ? pdfResponse(doc.bytes, doc.fileName, "attachment")
      : htmlResponse(doc.html);
  } catch (error) {
    if (error instanceof SigningError) return notFound(error.message);
    throw error;
  }
}
