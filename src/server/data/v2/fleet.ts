/**
 * Flottans läge (V2, byggplanen 3.1): en rad per aktiv automat med status, fyllnad, takt, tom
 * om, senast fylld, ström och (för ekonomiroller) vinst per dag, mot medianen och förlorad vinst
 * per dag. Hem, Automater, Rutt och menyns räknare läser samma läge.
 *
 * Allt läses som den inloggade (RLS) efter rollkontroll. Påfyllaren läser inte order: takten
 * kommer ur försäljningen i lagret (loadHealthData, samma som Drift), och ekonomin (öre) räknas
 * aldrig för roller utan ekonomi (economy = null i svaret).
 */

import "server-only";

import { sql } from "drizzle-orm";
import { cache } from "react";

import type { AwishFillRow } from "@/analytics/fleet-status";
import { loadFleetRanking } from "@/app/(app)/automater/_lib/ranking-data";
import { withUserDbFor } from "@/server/access";
import { healthOf, loadMachinePower } from "@/server/alerts/inputs";

import { loadContext, requireViewer } from "../core";
import { businessToday, requireViewerRole, type Viewer } from "../core/loaders";
import { ALL_ROLES, canSeeEconomy, OPERATOR_ROLES } from "../core/types";
import { healthDataInRequest, machineReadinessInRequest } from "./in-request";
import { buildFleetState, type FleetEconomyInput, type FleetInput } from "./fleet-model";
import type { FleetState, FleetStore } from "./types";

type Row = Record<string, unknown>;

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const iso = (v: unknown): string | null =>
  v === null || v === undefined
    ? null
    : (v instanceof Date ? v : new Date(String(v))).toISOString();

/** Ekonomin ur rangordningen (30 d). Ett fel stoppar inte sidan: då visas ingen ekonomi per automat. */
async function loadEconomy(): Promise<FleetEconomyInput> {
  try {
    const data = await loadFleetRanking({ period: "30d" }, { withLost: false });
    return {
      rows: new Map(
        data.ranking.rows.map((r) => [
          r.machineId,
          {
            profitPerDayOre: r.profitPerDayOre,
            vsMedianOre: r.vsMedianOre,
            verdict: r.verdict,
            unitsPerDayTenths: r.unitsPerDayTenths,
          },
        ]),
      ),
      medianProfitPerDayOre: data.ranking.medianProfitPerDayOre,
    };
  } catch (error) {
    console.error("[v2/fleet] Rangordningen kunde inte räknas:", error);
    return { rows: new Map(), medianProfitPerDayOre: null };
  }
}

/** Allt flottans läge byggs av utom ekonomin (samma för alla roller, inga belopp). */
export type FleetBaseInput = Omit<FleetInput, "economy">;

/**
 * Flottans läge för en användare. `economy` (bara roller som ser ekonomi) räknar vinst och
 * förlust; utan den byggs läget utan belopp (status, fyllnad, takt är desamma).
 */
export async function loadFleetStateFor(
  viewer: Viewer,
  now: Date,
  options: { readonly economy?: Promise<FleetEconomyInput> | null } = {},
): Promise<FleetState> {
  const role = await requireViewerRole(viewer, ALL_ROLES);
  const economyP = canSeeEconomy(role) ? (options.economy ?? null) : null;
  economyP?.catch(() => {});
  const base = await loadFleetBaseFor(viewer, now);
  return buildFleetState({ ...base, economy: economyP ? await economyP : null });
}

/** Indata till flottans läge utom ekonomin, som den inloggade (RLS) efter rollkontroll. */
export async function loadFleetBaseFor(viewer: Viewer, now: Date): Promise<FleetBaseInput> {
  const role = await requireViewerRole(viewer, ALL_ROLES);
  const orgId = viewer.organization.id;
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);
  const startklarP = (OPERATOR_ROLES as readonly string[]).includes(role)
    ? machineReadinessInRequest(viewer)
    : Promise.resolve([]);

  // Hälsans indata delas med besöksplanen i samma förfrågan (in-request.ts).
  const dataP = healthDataInRequest(viewer, today, now);
  dataP.catch(() => {});
  const db = await withUserDbFor(viewer.user, async (tx) => {
    const [data, power, storeRows, fillRows, refillRows] = await Promise.all([
      dataP,
      loadMachinePower(tx, orgId, today),
      tx.execute(
        sql`select id::text as id, name, city, address, phone, contact_name, latitude, longitude,
                   power_on_time, power_off_time
            from public.stores where organization_id = ${orgId}::uuid`,
      ),
      tx.execute(
        sql`select machine_id::text as machine_id, awish_fill
            from public.stock_locations
            where organization_id = ${orgId}::uuid and kind = 'machine' and machine_id is not null
              and archived_at is null`,
      ),
      // Senaste påfyllningen per lagerplats ur delindexet stock_events_last_refill_idx (en
      // indexläsning per plats, inte ett svep över alla händelser), sedan max per automat.
      tx.execute(
        sql`select l.machine_id::text as machine_id, max(r.at) as at
            from public.stock_locations l
            cross join lateral (
              select e.occurred_at as at
              from public.stock_events e
              where e.organization_id = l.organization_id and e.location_id = l.id
                and e.kind in ('refill', 'transfer_in')
              order by e.occurred_at desc
              limit 1
            ) r
            where l.organization_id = ${orgId}::uuid and l.kind = 'machine'
              and l.machine_id is not null
            group by l.machine_id`,
      ),
    ]);
    return { data, power, storeRows, fillRows, refillRows };
  });

  const stores = new Map<string, FleetStore>();
  for (const r of Array.from(db.storeRows) as Row[]) {
    const lat = num(r.latitude);
    const lng = num(r.longitude);
    const off = str(r.power_off_time);
    const on = str(r.power_on_time);
    stores.set(String(r.id), {
      id: String(r.id),
      name: String(r.name ?? ""),
      city: str(r.city),
      address: str(r.address),
      phone: str(r.phone),
      contactName: str(r.contact_name),
      location: lat !== null && lng !== null ? { lat, lng } : null,
      power: off && on ? { off: off.slice(0, 5), on: on.slice(0, 5) } : null,
    });
  }
  const fills = new Map<string, readonly AwishFillRow[] | null>();
  for (const r of Array.from(db.fillRows) as Row[]) {
    fills.set(
      String(r.machine_id),
      Array.isArray(r.awish_fill) ? (r.awish_fill as AwishFillRow[]) : null,
    );
  }
  const lastRefill = new Map<string, string>();
  for (const r of Array.from(db.refillRows) as Row[]) {
    const at = iso(r.at);
    if (at) lastRefill.set(String(r.machine_id), at);
  }
  const health = new Map(
    healthOf(db.data, timeZone, now).map((h) => [
      h.machineId,
      { status: h.status, since: h.since },
    ]),
  );
  const startklar = new Set(
    (await startklarP).filter((r) => r.isNew && !r.complete).map((r) => r.machineId),
  );

  return {
    today,
    now,
    timeZone,
    machines: db.data.machines.map((m) => ({
      id: m.id,
      code: m.code,
      name: m.name,
      storeId: m.storeId,
      activeFrom: m.activeFrom,
      activeTo: m.activeTo,
      archived: m.archived,
    })),
    stores,
    health,
    power: db.power,
    fills,
    stock: db.data.stock,
    sales: db.data.orders,
    lastRefill,
    startklar,
  };
}

/**
 * För serverkomponenter: flottans läge som den inloggade, en gång per förfrågan (Hem,
 * Automater och Rutt i samma rendering delar det). Ekonomin räknas bara för roller som ser den.
 */
export const loadFleetState = cache(async (): Promise<FleetState> => {
  const ctx = await loadContext();
  const economy = ctx.canSeeEconomy ? loadEconomy() : null;
  economy?.catch(() => {});
  const base = await loadFleetBase();
  return buildFleetState({ ...base, economy: economy ? await economy : null });
});

/** Indata utom ekonomin, en gång per förfrågan (delas av loadFleetState och loadFleetStatus). */
const loadFleetBase = cache(async (): Promise<FleetBaseInput> => {
  const ctx = await loadContext();
  return loadFleetBaseFor(await requireViewer(), new Date(ctx.now));
});

/**
 * Flottans läge utan ekonomi (status, fyllnad, takt), en gång per förfrågan: för menyns
 * räknare, som bara räknar automater per status. Samma indata som loadFleetState, så en
 * sida som läser båda i samma förfrågan läser databasen en gång.
 */
export const loadFleetStatus = cache(async (): Promise<FleetState> =>
  buildFleetState({ ...(await loadFleetBase()), economy: null }),
);
