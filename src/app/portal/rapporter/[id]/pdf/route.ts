import { loadPortalReport } from "@/server/portal/load";
import { isLegacyPortalReport } from "@/server/portal/model";
import { getPortalContext } from "@/server/portal/session";
import { reportStorageStatus, userReportStore } from "@/server/reports/storage";

/**
 * PDF:en till en av butikens rapporter. Åtkomsten avgörs av portal_report i
 * databasen (rollen store för just den butiken, bara butiksrapporter); filen läses
 * sedan med användarens egen session, så att storage-policyn
 * binderlab_reports_select_store också gäller i Supabase. Samma 404 för en rapport
 * som finns hos någon annan som för en som inte finns.
 *
 * En äldre rapport (från före den korta rapporten, utan sparat val) har en sparad PDF med
 * den gamla mallen, med titlar och service. Den lämnas inte ut: butiken skickas till
 * rapportens sida i portalen, som är kort och går att skriva ut.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await getPortalContext();
  if (!ctx) return new Response("Hittades inte.", { status: 404 });
  const { id } = await params;
  const detail = await loadPortalReport(ctx, id);
  if (!detail || !detail.storagePath) return new Response("Hittades inte.", { status: 404 });
  if (isLegacyPortalReport(detail.report)) {
    return new Response(null, {
      status: 303,
      headers: {
        location: new URL(`/portal/rapporter/${detail.reportId}`, request.url).toString(),
        "cache-control": "no-store",
      },
    });
  }

  const status = reportStorageStatus();
  if (!status.configured) {
    return new Response(`Rapportlagringen är inte konfigurerad: ${status.missing.join(", ")}.`, {
      status: 503,
    });
  }
  let file: Uint8Array;
  try {
    file = await (await userReportStore()).get(detail.storagePath);
  } catch {
    return new Response("PDF:en finns inte i lagringen än.", { status: 404 });
  }
  const month = detail.periodStart.slice(0, 7);
  return new Response(new Uint8Array(file), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="manadsrapport-${month}.pdf"`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
