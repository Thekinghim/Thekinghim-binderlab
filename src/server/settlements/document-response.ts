/**
 * Svaret för en avräknings dokument (Butiker → Butiksportal och butiksportalen): PDF när
 * Chromium finns och fungerar, annars samma innehåll som HTML att skriva ut i
 * webbläsaren. Ett fel i PDF-utskriften ger aldrig ett tomt 500-svar.
 */

import { htmlResponse, pdfResponse } from "@/app/signera/[token]/responses";

export type RenderHtml = (html: string) => Promise<Uint8Array>;

export async function settlementDocumentResponse(
  doc: { readonly html: string; readonly fileName: string },
  render: RenderHtml | null,
): Promise<Response> {
  if (!render) return htmlResponse(doc.html);
  try {
    return pdfResponse(await render(doc.html), doc.fileName);
  } catch (error) {
    console.error(
      "[avrakning] PDF kunde inte skapas, visar HTML",
      error instanceof Error ? error.message : error,
    );
    return htmlResponse(doc.html);
  }
}
