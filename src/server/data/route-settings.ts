/**
 * Dagens gräns och ruttens start (V2, byggplanen 3.2), för alla som räknar besöksplanen
 * (Att göra, Hem, Rutt, Lager, Drift och assistenten), så att planen är densamma överallt.
 *
 *   gräns = public.route_settings(org): stopp och pack per dag och besöksdagar. Funktionen
 *           får köras av alla roller (påfyllaren läser inte organization_settings). Går den
 *           inte att läsa: standarden (6 stopp, 350 pack, mån–fre), samma som migreringen.
 *   depå  = standardlagrets (is_central) adress och koordinat, om den finns.
 *
 * Läses i anroparens transaktion (som användaren, RLS).
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { GeoPoint } from "@/analytics/visits";
import type { Tx } from "@/db/client";

import type { PlanLimits } from "./visit-plan";

/** Standardgränsen (samma som migreringen 20261223000000_v2_rutt.sql). */
export const ROUTE_LIMIT_DEFAULTS: PlanLimits = {
  maxStops: 6,
  maxPacks: 350,
  weekdays: [1, 2, 3, 4, 5],
};

/** Dagens gräns (utan rad: standarden). Fel kastas: använd queryRoutePlanSettings. */
export async function queryRouteLimits(tx: Tx, orgId: string): Promise<PlanLimits> {
  const rows = Array.from(
    await tx.execute(
      sql`select max_stops, max_packs, weekdays from public.route_settings(${orgId}::uuid)`,
    ),
  ) as { max_stops: number; max_packs: number; weekdays: number[] | null }[];
  const row = rows[0];
  if (!row) return ROUTE_LIMIT_DEFAULTS;
  return {
    maxStops: Number(row.max_stops),
    maxPacks: Number(row.max_packs),
    weekdays: (row.weekdays ?? []).map(Number).sort((a, b) => a - b),
  };
}

/** Standardlagret som ruttens start: namn, adress och plats (null utan koordinat). */
export interface RouteDepot {
  readonly id: string;
  readonly name: string;
  readonly address: string | null;
  readonly location: GeoPoint | null;
}

export async function queryRouteDepot(tx: Tx, orgId: string): Promise<RouteDepot | null> {
  const rows = Array.from(
    await tx.execute(sql`
      select id::text as id, name, address, latitude, longitude
      from public.stock_locations
      where organization_id = ${orgId}::uuid and kind = 'warehouse'
        and archived_at is null and held_by = 'own'
      order by is_central desc, created_at
      limit 1`),
  ) as {
    id: string;
    name: string;
    address: string | null;
    latitude: number | null;
    longitude: number | null;
  }[];
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    name: r.name,
    address: r.address,
    location:
      r.latitude !== null && r.longitude !== null
        ? { lat: Number(r.latitude), lng: Number(r.longitude) }
        : null,
  };
}

/** Gräns och depå i en savepoint, så att ett fel aldrig avbryter anroparens transaktion. */
export async function queryRoutePlanSettings(
  tx: Tx,
  orgId: string,
): Promise<{ limits: PlanLimits; depot: RouteDepot | null }> {
  try {
    return await tx.transaction(async (sp) => ({
      limits: await queryRouteLimits(sp as unknown as Tx, orgId),
      depot: await queryRouteDepot(sp as unknown as Tx, orgId),
    }));
  } catch (error) {
    console.error("[rutt] Dagens gräns kunde inte läsas, standarden används:", error);
    return { limits: ROUTE_LIMIT_DEFAULTS, depot: null };
  }
}
