/**
 * GET /order/export?…  Orderlistan som CSV: exakt det listan visar (period, butik,
 * automat, titel, sökning och sortering ur samma query), alla rader och inte bara de
 * som hunnit laddas. Bara ägare, admin och läsare.
 */

import type { NextRequest } from "next/server";

import { ECONOMY_ROLES, requireContextRole } from "@/server/data/core";
import { AuthorizationError } from "@/server/session";

import { orderCsv, orderCsvFileName } from "../_lib/csv";
import { loadOrderExportFor } from "../_lib/service";
import { currentViewer, listArgsFrom } from "../_lib/session";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  try {
    const ctx = await requireContextRole(ECONOMY_ROLES);
    const { args } = await listArgsFrom(request.nextUrl.searchParams);
    const result = await loadOrderExportFor(await currentViewer(), args);
    if (result.truncated) {
      return new Response(
        "Exporten rymmer högst 500 000 order. Välj en kortare period eller ett filter.",
        { status: 413, headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    const csv = orderCsv(result.rows, result.refs, ctx.timeZone);
    const name = orderCsvFileName(args.period);
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${name}"`,
        "cache-control": "private, no-store",
      },
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return new Response("Du har inte behörighet att exportera order.", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }
}
