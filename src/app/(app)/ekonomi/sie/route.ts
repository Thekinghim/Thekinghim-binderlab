/**
 * GET /ekonomi/sie?manad=ÅÅÅÅ-MM → månadens verifikationer som SIE 4-fil (CP437).
 *
 * Ägare, admin och läsare (kontrolleras mot databasen i sieFileFor); allt läses som
 * användaren med RLS. Påfyllaren får 403.
 */

import type { NextRequest } from "next/server";

import { AccountingError, currentViewer, sieFileFor } from "@/server/accounting";
import { AuthorizationError } from "@/server/access";

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
    const file = await sieFileFor(viewer, month);
    return new Response(Buffer.from(file.bytes), {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=IBM437",
        "content-disposition": `attachment; filename="${file.fileName}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) return text(403, error.message);
    if (error instanceof AccountingError) return text(422, error.message);
    throw error;
  }
}
