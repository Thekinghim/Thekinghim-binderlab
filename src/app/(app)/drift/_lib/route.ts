/**
 * Besöksplanen som karta och kalender: stoppen med butikens adress och plats, länkarna till
 * Google Maps och dagarna för kalenderfilen (@/analytics/visits/links). Ren och utan I/O.
 */

import {
  googleMapsUrls,
  stopsWithoutPlace,
  type CalendarDay,
  type GeoPoint,
  type RouteStop,
  type VisitDay,
  type VisitPlan,
} from "@/analytics/visits";

/** Butikens adress och plats (som StorePlace i @/server/data/team). */
export interface PlaceRef {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly city: string | null;
  readonly location: GeoPoint | null;
}

export interface MachinePlaceRef {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly storeId: string | null;
}

/** Hårt bindestreck i BL-001, så att koden inte bryts. */
function code(c: string): string {
  return c.replace(/-/g, "‑");
}

/** Dagens stopp i besöksordning, med butikens adress och plats. */
export function dayRouteStops(
  day: Pick<VisitDay, "stops">,
  machines: readonly MachinePlaceRef[],
  places: ReadonlyMap<string, PlaceRef>,
): RouteStop[] {
  const byId = new Map(machines.map((m) => [m.id, m]));
  return day.stops.map((s) => {
    const m = byId.get(s.machineId);
    const place = m?.storeId ? places.get(m.storeId) : undefined;
    return {
      machineId: s.machineId,
      label: `${m ? code(m.code) : ""} ${s.machineName}`.trim(),
      storeId: m?.storeId ?? null,
      storeName: place?.name ?? null,
      address: place?.address ?? null,
      city: place?.city ?? null,
      location: place?.location ?? null,
      packs: s.totalPacks,
    };
  });
}

/** Vad dagen visar om rutten. */
export interface DayRouteView {
  readonly stops: RouteStop[];
  /** En länk per 10 stopp (oftast en). */
  readonly mapsUrls: string[];
  /** Butiker där adress saknas (unika, i besöksordning). */
  readonly missing: { readonly storeId: string | null; readonly name: string }[];
  /** Sant när alla har adress men minst en saknar plats: ordningen är efter brådska. */
  readonly needsLocation: boolean;
}

export function dayRouteView(
  day: Pick<VisitDay, "stops" | "routeMethod">,
  machines: readonly MachinePlaceRef[],
  places: ReadonlyMap<string, PlaceRef>,
): DayRouteView {
  const stops = dayRouteStops(day, machines, places);
  const seen = new Set<string>();
  const missing: DayRouteView["missing"][number][] = [];
  for (const s of stopsWithoutPlace(stops)) {
    const k = s.storeId ?? `automat:${s.machineId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    missing.push({ storeId: s.storeId, name: s.storeName ?? s.label });
  }
  return {
    stops,
    mapsUrls: googleMapsUrls(stops),
    missing,
    needsLocation: missing.length === 0 && day.routeMethod === "urgency" && stops.length > 1,
  };
}

/** "Påfyllning: 3 besök, 46 pack". */
export function calendarSummary(day: Pick<VisitDay, "stops" | "totalPacks">): string {
  return `Påfyllning: ${day.stops.length} besök, ${day.totalPacks} pack`;
}

/** Planens dagar för kalenderfilen; med `date` bara den dagen. */
export function calendarDays(
  plan: Pick<VisitPlan, "days">,
  machines: readonly MachinePlaceRef[],
  places: ReadonlyMap<string, PlaceRef>,
  date: string | null = null,
): CalendarDay[] {
  return plan.days
    .filter((d) => date === null || d.date === date)
    .map((d) => ({
      date: d.date,
      summary: calendarSummary(d),
      stops: dayRouteStops(d, machines, places),
    }));
}
