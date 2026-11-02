/**
 * Nedladdning av en rapport: /rapport/[id]/fil/pdf | xlsx | sie.
 *
 * Kräver inloggning och rollen ägare, admin eller läsare (getReportFor/ensurePdfFor
 * kontrollerar mot databasen, och RLS). PDF hämtas ur lagringen eller skapas med
 * headless Chromium första gången (bara ägare och admin). Excel och SIE räknas ur
 * ögonblicksbilden varje gång och blir därför identiska med det som godkändes.
 */

import { AuthorizationError } from "@/server/access";
import { PdfError } from "@/server/pdf/render";
import {
  CONTENT_TYPE,
  excelOf,
  reportFileName,
  ReportFileError,
  sieOf,
  type ReportFileKind,
} from "@/server/reports/files";
import { currentReportViewer, renderReportPdf } from "@/server/reports/runtime";
import { ensurePdfFor, getReportFor, ReportError } from "@/server/reports/service";
import { userReportStore } from "@/server/reports/storage";

export const runtime = "nodejs";
export const maxDuration = 60;

const KINDS = new Set<ReportFileKind>(["pdf", "xlsx", "sie"]);

function attachment(bytes: Uint8Array, fileName: string, kind: ReportFileKind): Response {
  return new Response(Buffer.from(bytes), {
    headers: {
      "Content-Type": CONTENT_TYPE[kind],
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function problem(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
  });
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; typ: string }> },
): Promise<Response> {
  const { id, typ } = await params;
  if (!KINDS.has(typ as ReportFileKind)) return problem(404, "Okänd filtyp.");
  const kind = typ as ReportFileKind;
  try {
    const viewer = await currentReportViewer();
    if (kind === "pdf") {
      const pdf = await ensurePdfFor(viewer, id, {
        store: await userReportStore(),
        render: renderReportPdf,
      });
      return attachment(pdf.bytes, pdf.fileName, "pdf");
    }
    const report = await getReportFor(viewer, id);
    const bytes = kind === "xlsx" ? await excelOf(report.snapshot) : sieOf(report.snapshot);
    return attachment(bytes, reportFileName(report.snapshot, kind), kind);
  } catch (error) {
    if (error instanceof AuthorizationError) return problem(403, error.message);
    if (error instanceof ReportError) return problem(404, error.message);
    if (error instanceof ReportFileError) return problem(409, error.message);
    if (error instanceof PdfError) return problem(503, error.message);
    // redirect() från requireUser (utloggad) ska nå Next.
    if (error && typeof error === "object" && "digest" in error) throw error;
    console.error("[rapport/fil]", error);
    return problem(500, "Filen kunde inte skapas.");
  }
}
