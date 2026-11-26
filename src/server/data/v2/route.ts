/**
 * Dagens rutt (V2, byggplanen 3.2): besöksplanens dag för i dag (samma plan som Att göra, Hem,
 * Drift och Lager: loadTodoVisitPlan, med dagens gräns ur inställningarna) med flottans läge,
 * dagens ändringar (route_day_changes), vårt lager och ruttens start. Den rena delen är
 * ./route-model.ts (buildDayRoute).
 *
 * Påfyllaren läser inte organization_settings: gränsen läses med public.route_settings(), som
 * alla roller får köra. Belopp (förlust per dag, räddar) bara för ekonomiroller (flottans läge).
 * Alla läsningar görs som användaren (RLS).
 */

import "server-only";

import { sql } from "drizzle-orm";
import { cache } from "react";

import { addDays, type IsoDate } from "@/domain";
import { withUserDbFor } from "@/server/access";

import {
  cachedViewState,
  loadContext,
  loadMasterData,
  markViewStateDegraded,
  requireViewer,
} from "../core";
import type { Viewer } from "../core/loaders";
import { stockRowsInRequest } from "../core/loaders";
import { ownStockTotals } from "../core/own-stock";
import { queryRoutePlanSettings, ROUTE_LIMIT_DEFAULTS } from "../route-settings";
import { loadTodoVisitPlan } from "../todos";
import { loadFleetState, loadFleetStatus } from "./fleet";
import { buildDayRoute } from "./route-model";
import type { DayRoute, RouteDayChangeRow, RouteLimits } from "./types";

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
      if (!row) return ROUTE_LIMIT_DEFAULTS;
      return {
        maxStops: Number(row.max_stops),
        maxPacks: Number(row.max_packs),
        weekdays: (row.weekdays ?? []).map(Number).sort((a, b) => a - b),
      };
    });
  } catch (error) {
    console.error("[v2/route] Gränsen kunde inte läsas:", error);
    markViewStateDegraded();
    return ROUTE_LIMIT_DEFAULTS;
  }
}

/** Dagens gräns för den inloggade, en gång per förfrågan. */
export const loadRouteLimits = cache(async (): Promise<RouteLimits> =>
  loadRouteLimitsFor(await requireViewer()),
);

/** Gällande ändringar i rutten från förra ruttdagen t.o.m. i dag (ej ångrade). */
export async function loadRouteChangesFor(
  viewer: Viewer,
  today: IsoDate,
  /** Första dagen att läsa (förra ruttdagen). Standard: i går. */
  from: IsoDate = addDays(today, -1),
): Promise<RouteDayChangeRow[]> {
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = Array.from(
      await tx.execute(sql`
        select id::text as id, day::text as day, machine_id::text as machine_id, change
        from public.route_day_changes
        where organization_id = ${viewer.organization.id}::uuid
          and day between ${from}::date and ${today}::date
          and undone_at is null
        order by created_at`),
    ) as { id: string; day: string; machine_id: string; change: RouteDayChangeRow["change"] }[];
    return rows.map((r) => ({
      id: r.id,
      day: r.day as IsoDate,
      machineId: r.machine_id,
      change: r.change,
    }));
  });
}

type DayRouteInput = Parameters<typeof buildDayRoute>[0];

/** Allt dagens rutt byggs av utom flottans läge, en gång per förfrågan. */
const loadDayRouteInputs = cache(async (): Promise<Omit<DayRouteInput, "fleet">> => {
  const ctx = await loadContext();
  const viewer = await requireViewer();
  const [plan, settings, changes, stock, master] = await Promise.all([
    loadTodoVisitPlan(),
    // Gränsen och ruttens start i en transaktion (vid fel: standarden och ingen start).
    withUserDbFor(viewer.user, (tx) => queryRoutePlanSettings(tx, viewer.organization.id)).catch(
      () => {
        markViewStateDegraded();
        return { limits: ROUTE_LIMIT_DEFAULTS, depot: null };
      },
    ),
    // En vecka bakåt: modellen tar "till i morgon" från förra ruttdagen (route-model.ts).
    loadRouteChangesFor(viewer, ctx.today, addDays(ctx.today, -7)).catch((error: unknown) => {
      console.error("[v2/route] Ändringarna kunde inte läsas:", error);
      markViewStateDegraded();
      return [];
    }),
    stockRowsInRequest(viewer).catch(() => {
      markViewStateDegraded();
      return null;
    }),
    loadMasterData(),
  ]);
  const { limits, depot } = settings;
  const days = plan?.plan.days ?? [];
  const day = days.find((d) => d.date === ctx.today) ?? null;
  return {
    date: ctx.today,
    day,
    limits,
    later: days.filter((d) => d.date > ctx.today),
    overflow: plan?.plan.overflow ?? [],
    changes,
    home: stock ? new Map(ownStockTotals(stock).map((r) => [r.titleId, r.onHand])) : null,
    noSubstitute: new Set(
      master.titles
        .filter((t) => (t.mysteryBatchSize ?? null) !== null || t.archived)
        .map((t) => t.id),
    ),
    depot: depot ? { name: depot.name, address: depot.address, location: depot.location } : null,
  };
});

/**
 * Dagens rutt för den inloggade, en gång per förfrågan. Utan besök i dag (eller när planen inte
 * gick att räkna): en rutt utan stopp.
 */
export const loadDayRoute = cache(async (): Promise<DayRoute> =>
  // Beror inte på vald period: sparad mellan förfrågningar (core/cachedViewState).
  cachedViewState("day-route", async () => {
    const [inputs, fleet] = await Promise.all([loadDayRouteInputs(), loadFleetState()]);
    return buildDayRoute({ ...inputs, fleet });
  }),
);

/**
 * Dagens rutt byggd på flottans läge utan ekonomi (inga belopp, "räddar" saknas), en gång per
 * förfrågan: för menyns räknare. Samma stopp, pack och brist som loadDayRoute (ekonomin
 * påverkar bara beloppen), och samma indata, så en sida som läser båda läser databasen en gång.
 */
export const loadDayRouteStatus = cache(async (): Promise<DayRoute> => {
  const [inputs, fleet] = await Promise.all([loadDayRouteInputs(), loadFleetStatus()]);
  return buildDayRoute({ ...inputs, fleet });
});
