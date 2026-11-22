/**
 * Dagens rutt (V2, byggplanen 3.2 och 2.5). Ren funktion: besöksplanens dag för i dag med
 * flottans läge, dagens ändringar (route_day_changes) och vårt lager.
 *
 * - Stopp: planens dag i dag, minus "hoppa över" och "till i morgon" i dag, plus "lägg till" i
 *   dag och "till i morgon" från i går (läggs sist, med packlistan från dagen planen gav dem,
 *   annars utan pack). Numreras 1, 2, 3 … i körordning.
 * - Städer: butikens stad i stoppordning; grupperna är stopp i följd i samma stad.
 * - km "ca" = planens sträcka (fågelväg med återresa) × ROAD_FACTOR. Tid "ca" = km ÷ 65 km/h
 *   + 18 min per påfyllning + 12 min per kontroll. Utan koordinater (eller när stopp lagts
 *   till eller tagits bort): inga km och ingen tid.
 * - Kontroll: automater som är offline får en kontroll (checklista) i stället för påfyllning.
 * - Klar: påfyllt i dag på automatens plats (flottans lastRefillAt i dag).
 * - Packlista: dagens pack per titel med vårt lager (alla egna lager) och brist.
 * - Ersättare: suggestSubstitutes (@/analytics/visits) för titlar som inte räcker hemma.
 * - Räddar: Σ förlorad vinst per dag (flottans lossProfitPerDayOre) över stopp som inte är
 *   klara. Bara när flottan har ekonomi (ägare, admin, läsare); annars null.
 * - Kommande dagar: planens senare dagar (samma gräns per dag), utan dagens stopp.
 */

import {
  suggestSubstitutes,
  type Substitute,
  type VisitDay,
  type VisitStop,
} from "@/analytics/visits";
import { addDays, dayOfWeek, type IsoDate } from "@/domain";

import type {
  DayRoute,
  FleetMachine,
  FleetState,
  RouteChange,
  RouteDayChangeRow,
  RouteLimits,
  RouteStop,
  RouteUpcomingDay,
} from "./types";

/** Standardgränsen när inställningen inte går att läsa (samma som migreringens standard). */
export const DEFAULT_ROUTE_LIMITS: RouteLimits = {
  maxStops: 6,
  maxPacks: 350,
  weekdays: [1, 2, 3, 4, 5],
};

/** Vägen är längre än fågelvägen: planens sträcka × 1,25 ("ca"). */
export const ROAD_FACTOR = 1.25;
/** Snittfart på vägen, km/h. */
export const ROUTE_KMH = 65;
/** Minuter per påfyllning och per kontroll (offline). */
export const MINUTES_PER_REFILL = 18;
export const MINUTES_PER_CHECK = 12;

/** "2026-11-21T09:12:00Z" → affärsdatum i tidszonen. */
export function localDate(isoTime: string, timeZone: string): IsoDate {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(isoTime)) as IsoDate;
}

/** Hela km "ca" ur planens meter, eller null. */
export function roadKm(meters: number | null): number | null {
  if (meters === null) return null;
  return Math.round((meters * ROAD_FACTOR) / 1_000);
}

/** Minuter "ca" för rutten: körning + tid per stopp. null utan km. */
export function routeMinutes(km: number | null, refills: number, checks: number): number | null {
  if (km === null) return null;
  return (
    Math.round((km / ROUTE_KMH) * 60) + refills * MINUTES_PER_REFILL + checks * MINUTES_PER_CHECK
  );
}

/** "7 h 20 min", "45 min". */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** "Strömmen av 21:00–08:00: fyll före 21:00", eller null när strömmen alltid är på. */
export function powerLine(power: { off: string; on: string } | null | undefined): string | null {
  if (!power) return null;
  return `Strömmen av ${power.off}–${power.on}: fyll före ${power.off}`;
}

/** Tomma fack vid besöket: fack (kanaler) för titlar som väntas vara slut. */
function emptySlotsOf(lines: VisitStop["packs"]): number {
  return lines
    .filter((l) => l.projectedAtVisit === 0)
    .reduce((s, l) => s + Math.max(1, l.channels.length), 0);
}

type PlanStop = Pick<VisitStop, "machineId" | "machineName" | "packs" | "reasons" | "late">;

function stopOf(
  s: PlanStop,
  sequence: number,
  m: FleetMachine | undefined,
  date: IsoDate,
  timeZone: string,
  change: RouteChange["change"] | null,
): RouteStop {
  return {
    machineId: s.machineId,
    code: m?.code ?? "",
    name: m?.name ?? s.machineName,
    sequence,
    store: m?.store ?? null,
    status: m?.status ?? null,
    statusLabel: m?.statusLabel ?? null,
    packs: s.packs.reduce((a, p) => a + p.quantity, 0),
    lines: s.packs,
    reasons: s.reasons,
    done: !!m?.lastRefillAt && localDate(m.lastRefillAt, timeZone) === date,
    lossProfitPerDayOre: m?.economy?.lossProfitPerDayOre ?? null,
    kind: m?.status === "offline" ? "check" : "fill",
    emptySlots: emptySlotsOf(s.packs),
    daysLeft: m?.daysLeft ?? null,
    late: s.late,
    added: change === "add" || change === "later",
    power: powerLine(m?.store?.power),
  };
}

/**
 * Förra ruttdagen före `date` (närmaste dag med veckodag i `weekdays`, högst 7 dagar bakåt).
 * Utan ruttdagar: dagen före. Dit hör "till i morgon": satt på fredagen gäller den måndag.
 */
export function previousRouteDay(date: IsoDate, weekdays: readonly number[]): IsoDate {
  if (weekdays.length === 0) return addDays(date, -1);
  for (let i = 1; i <= 7; i += 1) {
    const d = addDays(date, -i);
    if (weekdays.includes(dayOfWeek(d))) return d;
  }
  return addDays(date, -1);
}

export function buildDayRoute(args: {
  readonly date: IsoDate;
  /** Besöksplanens dag för `date`, eller null när inga besök behövs i dag. */
  readonly day: VisitDay | null;
  readonly fleet: FleetState;
  readonly limits: RouteLimits;
  /** Planens senare dagar (kommande). Utelämnat = inga. */
  readonly later?: readonly VisitDay[];
  /** Ändringar i går och i dag som inte är ångrade. Utelämnat = inga. */
  readonly changes?: readonly RouteDayChangeRow[];
  /** Vårt lager per titel (alla egna lager). Utelämnat = okänt. */
  readonly home?: ReadonlyMap<string, number> | null;
  /** Titlar som aldrig föreslås som ersättare (mystery packs). */
  readonly noSubstitute?: ReadonlySet<string>;
  /** Ruttens start (standardlagret). */
  readonly depot?: DayRoute["depot"];
  /** Automater som inte ryms i veckans rutter (besöksplanens overflow). */
  readonly overflow?: readonly string[];
}): DayRoute {
  const { date, day, fleet, limits } = args;
  const later = (args.later ?? []).filter((d) => d.date > date);
  const byId = new Map(fleet.machines.map((m) => [m.id, m]));
  // "Till i morgon" från förra ruttdagen (eller dagarna mellan den och i dag), så att en
  // flytt på fredagen inte tappas till måndagen.
  const yesterday = previousRouteDay(date, limits.weekdays);
  const changes = (args.changes ?? []).filter(
    (c) => c.day === date || (c.day >= yesterday && c.day < date && c.change === "later"),
  );
  const todayChange = new Map(changes.filter((c) => c.day === date).map((c) => [c.machineId, c]));

  // Planens stopp i dag, utom de som hoppas över eller flyttas till i morgon.
  const planned = day?.stops ?? [];
  const removed: RouteChange[] = [];
  const kept: VisitStop[] = [];
  for (const s of planned) {
    const c = todayChange.get(s.machineId);
    if (c && (c.change === "skip" || c.change === "later")) {
      removed.push({
        id: c.id,
        machineId: s.machineId,
        name: byId.get(s.machineId)?.name ?? s.machineName,
        change: c.change,
      });
    } else kept.push(s);
  }
  // Tillagda: i går "till i morgon" och i dag "lägg till", som inte redan är med.
  const plannedLater = new Map(later.flatMap((d) => d.stops.map((s) => [s.machineId, s])));
  const extra: {
    stop: PlanStop | null;
    machineId: string;
    change: RouteChange["change"] | null;
  }[] = [];
  const inRoute = new Set(kept.map((s) => s.machineId));
  const added: RouteChange[] = [];
  for (const c of [
    ...changes.filter((x) => x.day !== date),
    ...changes.filter((x) => x.day === date && x.change === "add"),
  ]) {
    if (inRoute.has(c.machineId) || !byId.has(c.machineId)) continue;
    // I går "till i morgon" men i dag överhoppad eller flyttad igen: inte med.
    const now = todayChange.get(c.machineId);
    if (c.day !== date && now && now.change !== "add") continue;
    inRoute.add(c.machineId);
    extra.push({
      stop:
        planned.find((s) => s.machineId === c.machineId) ?? plannedLater.get(c.machineId) ?? null,
      machineId: c.machineId,
      change: c.change,
    });
    if (c.day === date)
      added.push({
        id: c.id,
        machineId: c.machineId,
        name: byId.get(c.machineId)?.name ?? "",
        change: c.change,
      });
  }

  // Flottans "Tom" och "Fyll på i dag" (samma läge som Kräver åtgärd på Hem) är alltid stopp
  // en ruttdag, även när besöksplanen (lagret och takten) inte tog med dem eller gränsen är
  // nådd. Inte när de hoppats över eller flyttats i dag.
  const routeDay = limits.weekdays.length === 0 || limits.weekdays.includes(dayOfWeek(date));
  if (routeDay) {
    for (const m of fleet.machines) {
      if (m.status !== "tom" && m.status !== "fyll-pa") continue;
      if (inRoute.has(m.id) || todayChange.has(m.id)) continue;
      inRoute.add(m.id);
      extra.push({
        stop: plannedLater.get(m.id) ?? null,
        machineId: m.id,
        change: null,
      });
    }
  }

  const stops: RouteStop[] = [];
  for (const s of kept) {
    stops.push(stopOf(s, stops.length + 1, byId.get(s.machineId), date, fleet.timeZone, null));
  }
  for (const e of extra) {
    const m = byId.get(e.machineId);
    const s: PlanStop = e.stop ?? {
      machineId: e.machineId,
      machineName: m?.name ?? "",
      packs: [],
      reasons: [],
      late: false,
    };
    stops.push(stopOf(s, stops.length + 1, m, date, fleet.timeZone, e.change));
  }

  // Städer och grupper (stopp i följd i samma stad).
  const cities: string[] = [];
  const groups: { city: string | null; machineIds: string[]; packs: number }[] = [];
  for (const s of stops) {
    const city = s.store?.city?.trim() || null;
    const last = groups[groups.length - 1];
    if (last && last.city === city) {
      last.machineIds.push(s.machineId);
      last.packs += s.packs;
    } else {
      groups.push({ city, machineIds: [s.machineId], packs: s.packs });
      if (city && cities[cities.length - 1] !== city) cities.push(city);
    }
  }

  // Packlista per titel och brist.
  const load = new Map<
    string,
    { titleId: string; titleName: string; quantity: number; shortBy: number }
  >();
  for (const s of stops) {
    for (const p of s.lines) {
      const cur = load.get(p.titleId) ?? {
        titleId: p.titleId,
        titleName: p.titleName,
        quantity: 0,
        shortBy: 0,
      };
      cur.quantity += p.quantity;
      cur.shortBy += Math.max(0, p.shortBy);
      load.set(p.titleId, cur);
    }
  }
  const home = args.home ?? null;
  const loadList = [...load.values()]
    .filter((l) => l.quantity > 0 || l.shortBy > 0)
    .map((l) => ({ ...l, home: home ? (home.get(l.titleId) ?? 0) : null }))
    .sort(
      (a, b) =>
        // Brist först (det man måste göra något åt), sedan flest pack.
        Number(b.shortBy > 0) - Number(a.shortBy > 0) ||
        b.quantity - a.quantity ||
        a.titleName.localeCompare(b.titleName, "sv"),
    );
  const short = loadList
    .filter((l) => l.shortBy > 0)
    .map((l) => ({ titleId: l.titleId, titleName: l.titleName, shortBy: l.shortBy }))
    .sort((a, b) => b.shortBy - a.shortBy || a.titleName.localeCompare(b.titleName, "sv"));

  const titleNames = new Map<string, string>();
  for (const d of [day, ...later])
    for (const s of d?.stops ?? []) for (const p of s.packs) titleNames.set(p.titleId, p.titleName);
  const substitutes: Substitute[] = home
    ? suggestSubstitutes({
        stops: stops.map((s) => ({
          machineId: s.machineId,
          lines: s.lines.map((p) => ({
            titleId: p.titleId,
            titleName: p.titleName,
            shortBy: p.shortBy,
            capacity: p.capacity,
            channels: p.channels,
          })),
        })),
        home,
        load: new Map(loadList.map((l) => [l.titleId, l.quantity])),
        // Bara titlar som någon automat säljer (de har ett namn i planen).
        titleName: (id) => titleNames.get(id) ?? "",
        exclude: new Set([
          ...(args.noSubstitute ?? []),
          ...[...home.keys()].filter((id) => !titleNames.has(id)),
        ]),
      })
    : [];

  const totalPacks = stops.reduce((a, s) => a + s.packs, 0);
  // Sträckan gäller planens stopp; med tillagda eller borttagna stopp är den okänd.
  const sameAsPlan = extra.length === 0 && removed.length === 0;
  let nextRouteDay: IsoDate | null = null;
  for (let i = 1; i <= 7 && limits.weekdays.length > 0; i += 1) {
    const d = addDays(date, i);
    if (limits.weekdays.includes(dayOfWeek(d))) {
      nextRouteDay = d;
      break;
    }
  }
  const needing = fleet.machines.filter((m) => m.status === "tom" || m.status === "fyll-pa");
  const overflow = (args.overflow ?? [])
    .filter((id) => !inRoute.has(id) && byId.has(id))
    .map((id) => ({ machineId: id, name: byId.get(id)?.name ?? "" }));
  const totalMeters = sameAsPlan ? (day?.totalMeters ?? null) : null;
  const km = roadKm(totalMeters);
  const checks = stops.filter((s) => s.kind === "check" && !s.done).length;
  const refills = stops.filter((s) => s.kind === "fill" && !s.done).length;
  const saves = fleet.economy
    ? stops.filter((s) => !s.done).reduce((a, s) => a + Math.max(0, s.lossProfitPerDayOre ?? 0), 0)
    : null;

  const upcoming: RouteUpcomingDay[] = later
    .map((d) => {
      const list = d.stops.filter((s) => !inRoute.has(s.machineId));
      const dayCities: string[] = [];
      for (const s of list) {
        const city = byId.get(s.machineId)?.store?.city?.trim();
        if (city && dayCities[dayCities.length - 1] !== city) dayCities.push(city);
      }
      return {
        date: d.date,
        cities: dayCities,
        packs: list.reduce((a, s) => a + s.totalPacks, 0),
        stops: list.map((s) => {
          const m = byId.get(s.machineId);
          return {
            machineId: s.machineId,
            name: m?.name ?? s.machineName,
            city: m?.store?.city ?? null,
            daysLeft: m?.daysLeft ?? null,
          };
        }),
      };
    })
    .filter((d) => d.stops.length > 0);

  return {
    date,
    stops,
    cities,
    groups,
    totalPacks,
    totalMeters,
    km,
    minutes: routeMinutes(km, refills, checks),
    routeMethod: sameAsPlan ? (day?.routeMethod ?? "urgency") : "urgency",
    load: loadList,
    short,
    substitutes,
    savesProfitPerDayOre: saves,
    removed,
    added,
    upcoming,
    depot: args.depot ?? null,
    limits,
    routeDay,
    nextRouteDay,
    needing: needing.length,
    overflow,
  };
}

/**
 * Raden när dagens rutt saknar stopp (Rutt och Hem). Säger aldrig "ingen påfyllning behövs"
 * när flottan har automater som behöver fyllas på.
 */
export function emptyRouteText(
  route: Pick<DayRoute, "date" | "routeDay" | "nextRouteDay" | "needing" | "removed" | "stops">,
): { title: string; body: string | null } {
  const weekday = (d: IsoDate) =>
    new Intl.DateTimeFormat("sv-SE", { weekday: "long", timeZone: "UTC" }).format(
      new Date(`${d}T12:00:00Z`),
    );
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const need =
    route.needing === 1
      ? "1 automat behöver fyllas på"
      : `${route.needing} automater behöver fyllas på`;
  if (!route.routeDay) {
    const next = route.nextRouteDay ? `Nästa rutt ${weekday(route.nextRouteDay)}` : null;
    return {
      title: `${cap(weekday(route.date))} är ingen ruttdag`,
      body: [next, route.needing > 0 ? need : null].filter(Boolean).join(" · ") || null,
    };
  }
  if (route.removed.length > 0 && route.stops.length === 0) {
    return { title: "Du hoppade över alla stopp i dag", body: route.needing > 0 ? need : null };
  }
  if (route.needing > 0) return { title: "Inga stopp i dag", body: need };
  return { title: "Ingen påfyllning behövs i dag", body: null };
}
