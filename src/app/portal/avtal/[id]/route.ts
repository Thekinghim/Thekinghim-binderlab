/**
 * GET /portal/avtal/{id} → butikens avtal (den signerade PDF:en om den finns). Åtkomsten
 * avgörs av portal_contract_file i databasen (rollen store för just den butiken). Samma 404
 * för ett avtal hos någon annan som för ett okänt.
 */

import { notFound, pdfResponse } from "@/app/signera/[token]/responses";
import { getPortalContext } from "@/server/portal/session";
import { loadPortalContractFile } from "@/server/portal/settlements";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const ctx = await getPortalContext();
  if (!ctx) return notFound("Hittades inte.");
  const { id } = await params;
  const file = await loadPortalContractFile(ctx, id);
  if (!file) return notFound("Hittades inte.");
  if (file.contentType !== "application/pdf") {
    return new Response(Buffer.from(file.bytes), {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  return pdfResponse(file.bytes, file.fileName);
}
