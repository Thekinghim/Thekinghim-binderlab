/**
 * GET /drift/besok/kalender?dag=YYYY-MM-DD&mina=1  Besöksplanen som kalenderfil (.ics):
 * en heldagshändelse per besöksdag med stoppen i ordning och kartlänken. Utan dag: hela
 * veckan. Samma plan som sidan (loadVisitPlan). Roller som ser Drift.
 */

import type { NextRequest } from "next/server";

import { visitIcs } from "@/analytics/visits";
import { ALL_ROLES } from "@/server/data/core/types";
import { requireContextRole } from "@/server/data/core";
import { AuthorizationError } from "@/server/session";

import { loadVisitPlan } from "../../_lib/load";
import { calendarDays } from "../../_lib/route";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  let ctx: Awaited<ReturnType<typeof requireContextRole>>;
  try {
    ctx = await requireContextRole(ALL_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return new Response("Du har inte behörighet.", {
        status: 403,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    throw error;
  }
  const params = request.nextUrl.searchParams;
  const raw = params.get("dag");
  const date = raw && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
  const { plan, data, places } = await loadVisitPlan(ctx, { mine: params.get("mina") === "1" });
  const days = calendarDays(plan, data.machines, places, date);
  const body = visitIcs(days, ctx.organization.id, new Date(ctx.now));
  const name = date ? `besok-${date}.ics` : `besok-vecka-${plan.period.start}.ics`;
  return new Response(body, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "private, no-store",
    },
  });
}
