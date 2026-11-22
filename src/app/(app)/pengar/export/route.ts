/**
 * GET /pengar/export  Tabellen "Vinst per automat · kr per dag" (12 månader) som CSV: samma
 * laddare som kortet på Pengar (loadMoneyMonths), semikolon och svenska decimaler. Bara
 * ägare, admin och läsare; påfyllaren får 403.
 */

import { ECONOMY_ROLES, loadContext, requireContextRole } from "@/server/data/core";
import { loadMoneyMonths } from "@/server/data/v2/analytics/months12";
import { monthTableCsv } from "@/server/data/v2/analytics/money-model";
import { AuthorizationError } from "@/server/session";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
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
