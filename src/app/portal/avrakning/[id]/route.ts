/**
 * GET /portal/avrakning/{id} → en av butikens avräkningar som PDF (HTML när PDF inte kan
 * skrivas ut här). Åtkomsten avgörs av portal_settlements i databasen (rollen store för
 * just den butiken). Samma 404 för en avräkning hos någon annan som för en okänd.
 */

import { htmlResponse, notFound, pdfResponse } from "@/app/signera/[token]/responses";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";
import { getPortalContext } from "@/server/portal/session";
import { loadPortalSettlementDocument } from "@/server/portal/settlements";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getPortalContext();
  if (!ctx) return notFound("Hittades inte.");
  const { id } = await params;
  const doc = await loadPortalSettlementDocument(ctx, id);
  if (!doc) return notFound("Hittades inte.");
  if (!pdfStatus().configured) return htmlResponse(doc.html);
  return pdfResponse(await getPdfRenderer().renderHtml(doc.html), doc.fileName);
}
