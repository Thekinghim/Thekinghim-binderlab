/**
 * GET /portal/avrakning/{id} → en av butikens avräkningar som PDF, eller som HTML att skriva
 * ut när PDF inte kan skapas här. Åtkomsten avgörs av portal_settlements i databasen
 * (rollen store för just den butiken). Samma 404 för en avräkning hos någon annan som för
 * en okänd.
 */

import { notFound } from "@/app/signera/[token]/responses";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";
import { getPortalContext } from "@/server/portal/session";
import { loadPortalSettlementDocument } from "@/server/portal/settlements";
import { settlementDocumentResponse } from "@/server/settlements/document-response";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getPortalContext();
  if (!ctx) return notFound("Hittades inte.");
  const { id } = await params;
  const doc = await loadPortalSettlementDocument(ctx, id);
  if (!doc) return notFound("Hittades inte.");
  return settlementDocumentResponse(
    doc,
    pdfStatus().configured ? (html) => getPdfRenderer().renderHtml(html) : null,
  );
}
