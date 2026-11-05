/**
 * GET /plattform/underlag/csv?manad=ÅÅÅÅ-MM[&kund=<id>]  Fakturaunderlaget som CSV (svenskt
 * Excel-format): en rad per kund och valuta. Bara plattformsoperatörer; alla andra får 404,
 * och RPC:n platform_overview_data nekar ändå.
 */

import type { NextRequest } from "next/server";

import type { IsoMonth } from "@/domain";
import { todayIn } from "@/server/portal/model";
import { getSessionUser } from "@/server/session";
import { invoiceCsv, parseMonthParam } from "@/server/subscriptions/model";
import { isPlatformOperatorFor, loadInvoiceBasisFor } from "@/server/subscriptions/service";

import { PLATFORM_TIME_ZONE } from "../../_lib/context";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const user = await getSessionUser();
  if (!user || !(await isPlatformOperatorFor(user))) {
    return new Response("Hittades inte.", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  const params = request.nextUrl.searchParams;
  const current = todayIn(PLATFORM_TIME_ZONE).slice(0, 7) as IsoMonth;
  const month = parseMonthParam(params.get("manad"), current);
  const only = params.get("kund");
  const rows = (await loadInvoiceBasisFor(user, month)).filter(
    (r) => !only || r.customer.id === only,
  );
  const csv = invoiceCsv(
    month,
    rows.map((r) => ({
      name: r.customer.name,
      slug: r.customer.slug,
      countryCode: r.customer.customer.countryCode,
      vatNumber: r.customer.customer.vatNumber,
      basis: r.basis,
    })),
  );
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="fakturaunderlag-${month}.csv"`,
      "cache-control": "no-store",
    },
  });
}
