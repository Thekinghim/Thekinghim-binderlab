/**
 * Dagens rutt (V2, byggplanen 3.2), första versionen från grunden (F0): besöksplanens dag för i
 * dag (samma plan som Att göra, Drift och Lager: loadTodoVisitPlan) med flottans läge och
 * dagens gräns ur inställningarna. Rutt-gruppen (G3) tar över filen.
 *
 * Påfyllaren läser inte organization_settings: gränsen läses med public.route_settings(), som
 * alla roller får köra. Belopp (förlust per dag) bara för ekonomiroller (flottans läge).
 */

import "server-only";

import { sql } from "drizzle-orm";
import { cache } from "react";

import { withUserDbFor } from "@/server/access";

import { loadContext, requireViewer } from "../core";
import type { Viewer } from "../core/loaders";
import { loadTodoVisitPlan } from "../todos";
import { loadFleetState } from "./fleet";
import { buildDayRoute, DEFAULT_ROUTE_LIMITS } from "./route-model";
import type { DayRoute, RouteLimits } from "./types";

/** Dagens gräns (inställningarna). Vid fel: standarden (6 stopp, 350 pack, mån–fre). */
export async function loadRouteLimitsFor(viewer: Viewer): Promise<RouteLimits> {
  try {
    return await withUserDbFor(viewer.user, async (tx) => {
      const [row] = Array.from(
        await tx.execute(
          sql`select max_stops, max_packs, weekdays
              from public.route_settings(${viewer.organization.id}::uuid)`,
        ),
      ) as { max_stops: number; max_packs: number; weekdays: number[] }[];
      if (!row) return DEFAULT_ROUTE_LIMITS;
      return {
        maxStops: Number(row.max_stops),
        maxPacks: Number(row.max_packs),
        weekdays: (row.weekdays ?? []).map(Number),
      };
    });
  } catch (error) {
    console.error("[v2/route] Gränsen kunde inte läsas:", error);
    return DEFAULT_ROUTE_LIMITS;
  }
}

/** Dagens gräns för den inloggade, en gång per förfrågan. */
export const loadRouteLimits = cache(async (): Promise<RouteLimits> =>
  loadRouteLimitsFor(await requireViewer()),
);

/**
 * Dagens rutt för den inloggade, en gång per förfrågan. Utan besök i dag (eller när planen inte
 * gick att räkna): en rutt utan stopp.
 */
export const loadDayRoute = cache(async (): Promise<DayRoute> => {
  const ctx = await loadContext();
  const [plan, fleet, limits] = await Promise.all([
    loadTodoVisitPlan(),
    loadFleetState(),
    loadRouteLimits(),
  ]);
  const day = plan?.plan.days.find((d) => d.date === ctx.today) ?? null;
  return buildDayRoute({ date: ctx.today, day, fleet, limits });
});
