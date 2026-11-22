/**
 * GET /pengar/export  Tabellen "Vinst per automat · kr per dag" (12 månader) som CSV: samma
 * laddare som kortet på Pengar (loadMoneyMonths), semikolon och svenska decimaler.
 *
 * GET /pengar/export?period=igar (eller ?from=&to=, alla periodval): perioden per titel och
 * automat (antal, intäkt, vinst) med total, samma laddare som "Sålt i går" (loadDaySales).
 *
 * Bara ägare, admin och läsare; påfyllaren får 403.
 */

import { daySalesCsv } from "@/analytics/day-sales";
import { hasPeriodParam } from "@/components/shell/period-state";
import { ECONOMY_ROLES, loadContext, requireContextRole } from "@/server/data/core";
import { loadDaySales } from "@/server/data/v2/analytics/day-sales";
import { loadMoneyMonths } from "@/server/data/v2/analytics/months12";
import { monthTableCsv } from "@/server/data/v2/analytics/money-model";
import { AuthorizationError } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    await requireContextRole(ECONOMY_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return new Response("Bara ägare, admin och läsare kan exportera.", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }
  const sp = new URL(request.url).searchParams;
  if (hasPeriodParam(sp)) {
    const v = await loadDaySales(sp);
    const name =
      v.period.start === v.period.end ? v.period.start : `${v.period.start}_${v.period.end}`;
    return new Response(daySalesCsv(v.sales, v.period), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="salt-${name}.csv"`,
        "cache-control": "no-store",
      },
    });
  }
  const [ctx, table] = await Promise.all([loadContext(), loadMoneyMonths()]);
  if (!table) return new Response("Ingen data.", { status: 404 });
  return new Response(monthTableCsv(table), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="vinst-per-automat-${ctx.today}.csv"`,
      "cache-control": "no-store",
    },
  });
}
