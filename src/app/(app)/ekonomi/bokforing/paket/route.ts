/**
 * GET /ekonomi/bokforing/paket?manad=ÅÅÅÅ-MM → månadspaketet (ZIP): SIE 4, sammanfattning
 * (PDF, eller HTML om PDF inte kan skapas här), Excel och månadens kvitton.
 *
 * Ägare, admin och läsare (kontrolleras mot databasen i monthPackageFor); allt läses som
 * användaren med RLS. Påfyllaren får 403. En pågående månad ger 422.
 */

import type { NextRequest } from "next/server";

import { AccountingError, currentViewer } from "@/server/accounting";
import { AuthorizationError } from "@/server/access";
import { monthPackageFor } from "@/server/bokforing/service";
import { businessToday } from "@/server/data/core/loaders";
import { getPdfRenderer, pdfStatus } from "@/server/pdf/render";

export const maxDuration = 60;

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

function text(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const month = request.nextUrl.searchParams.get("manad") ?? "";
  if (!MONTH.test(month)) return text(400, "Ange månaden som ?manad=ÅÅÅÅ-MM.");
  try {
    const viewer = await currentViewer();
    const today = businessToday(new Date(), viewer.organization.timezone);
    const renderPdf = pdfStatus().configured
      ? (html: string) => getPdfRenderer().renderHtml(html)
      : null;
    const pkg = await monthPackageFor(viewer, month, today, { renderPdf });
    // Strömmas i bitar: ett paket med kvitton blir lätt större än 4,5 MB, som är taket
    // för ett icke-strömmat svar från en Vercel Function.
    const bytes = pkg.bytes;
    const CHUNK = 512 * 1024;
    let at = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (at >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(at, at + CHUNK));
        at += CHUNK;
      },
    });
    return new Response(body, {
      status: 200,
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${pkg.fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return text(403, error.message);
    if (error instanceof AccountingError) return text(422, error.message);
    throw error;
  }
}
