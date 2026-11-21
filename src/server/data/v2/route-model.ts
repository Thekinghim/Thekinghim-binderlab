/**
 * Dagens rutt, första versionen (V2, byggplanen 3.2): besöksplanens dag för i dag som stopp med
 * butik, status och förlust ur flottans läge. Ren funktion. Rutt-gruppen (G3) bygger vidare:
 * route_day_changes (hoppa över, lägg till, i morgon), km/tid "ca", kommande dagar, ersättare.
 */

import type { VisitDay } from "@/analytics/visits";
import type { IsoDate } from "@/domain";

import type { DayRoute, FleetState, RouteLimits } from "./types";

/** Standardgränsen när inställningen inte går att läsa (samma som migreringens standard). */
export const DEFAULT_ROUTE_LIMITS: RouteLimits = {
  maxStops: 6,
  maxPacks: 350,
  weekdays: [1, 2, 3, 4, 5],
};

/** "2026-11-21T09:12:00Z" → affärsdatum i tidszonen. */
export function localDate(isoTime: string, timeZone: string): IsoDate {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTime)) as IsoDate;
}

export function buildDayRoute(args: {
  readonly date: IsoDate;
  /** Besöksplanens dag för `date`, eller null när inga besök behövs i dag. */
  readonly day: VisitDay | null;
  readonly fleet: FleetState;
  readonly limits: RouteLimits;
}): DayRoute {
  const { date, day, fleet, limits } = args;
  const byId = new Map(fleet.machines.map((m) => [m.id, m]));
  const stops = (day?.stops ?? []).map((s) => {
    const m = byId.get(s.machineId);
    return {
      machineId: s.machineId,
      code: m?.code ?? "",
      name: m?.name ?? s.machineName,
      sequence: s.sequence,
      store: m?.store ?? null,
      status: m?.status ?? null,
      packs: s.totalPacks,
      lines: s.packs,
      reasons: s.reasons,
      done: !!m?.lastRefillAt && localDate(m.lastRefillAt, fleet.timeZone) === date,
      lossProfitPerDayOre: m?.economy?.lossProfitPerDayOre ?? null,
    };
  });
  const cities: string[] = [];
  for (const s of stops) {
    const city = s.store?.city?.trim();
    if (city && cities[cities.length - 1] !== city) cities.push(city);
  }
  const short = new Map<string, { titleId: string; titleName: string; shortBy: number }>();
  for (const s of day?.stops ?? []) {
    for (const p of s.packs) {
      if (p.shortBy <= 0) continue;
      const cur = short.get(p.titleId) ?? {
        titleId: p.titleId,
        titleName: p.titleName,
        shortBy: 0,
      };
      cur.shortBy += p.shortBy;
      short.set(p.titleId, cur);
    }
  }
  return {
    date,
    stops,
    cities,
    totalPacks: day?.totalPacks ?? 0,
    totalMeters: day?.totalMeters ?? null,
    routeMethod: day?.routeMethod ?? "urgency",
    load: day?.load ?? [],
    short: [...short.values()].sort(
      (a, b) => b.shortBy - a.shortBy || a.titleName.localeCompare(b.titleName, "sv"),
    ),
    limits,
  };
}
