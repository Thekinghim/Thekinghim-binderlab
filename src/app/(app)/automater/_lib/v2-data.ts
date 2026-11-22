/**
 * Laddaren för Automater i V2 (byggplanen 2.3): flottans läge (src/server/data/v2/fleet.ts),
 * facken per automat (stock_locations.awish_fill med titlarnas namn och Awish-kanaler) och,
 * bara för roller som ser ekonomi, periodens intäkt och vinst per automat ur Automaters vanliga
 * uträkning (loadOverview). Påfyllaren får aldrig några belopp: `economy` är null på servern.
 */

import "server-only";

import { sql } from "drizzle-orm";

import {
  parsePeriod,
  periodNameInline,
  type SearchParamsInput,
} from "@/components/shell/period-state";
import { withUserDbFor } from "@/server/access";
import type { AppContext } from "@/server/data/core";
import { loadFleetState } from "@/server/data/v2/fleet";

import { loadOverview } from "./data";
import { currentViewer } from "./session";
import { cityOrderFrom, type AutoMachine, type AutoSlot } from "./v2-model";

type Row = Record<string, unknown>;

const num = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

export interface AutomaterV2Data {
  readonly machines: readonly AutoMachine[];
  /** Ekonomin finns (ägare, admin, läsare). */
  readonly economy: boolean;
  /** Städerna i körordning från lagret (tom utan koordinater). */
  readonly cityOrder: readonly string[];
  /** Periodens etikett ("30 d") för intäkt och vinst i den valda automaten. */
  readonly periodLabel: string;
  /** Rollen får fylla på (ägare, admin, påfyllare). */
  readonly canFill: boolean;
  readonly now: string;
  readonly timeZone: string;
}

/** Facken per automat (titel, kanaler, pack, kapacitet, tomma) som den inloggade. */
async function loadSlots(orgId: string): Promise<{
  slots: Map<string, AutoSlot[]>;
  origin: { lat: number; lng: number } | null;
}> {
  const viewer = await currentViewer();
  return withUserDbFor(viewer.user, async (tx) => {
    const [fillRows, levelRows, originRows] = await Promise.all([
      tx.execute(sql`
        select l.machine_id::text as machine_id, f.title_id, t.name, f.units, f.capacity,
               f.channels, f.empty, c.channels as names
        from public.stock_locations l
        cross join lateral jsonb_to_recordset(
          case when jsonb_typeof(l.awish_fill) = 'array' then l.awish_fill else '[]'::jsonb end
        ) as f(title_id uuid, units int, capacity int, channels int, empty int)
        join public.titles t on t.organization_id = l.organization_id and t.id = f.title_id
        left join public.machine_slot_capacity c
          on c.organization_id = l.organization_id and c.machine_id = l.machine_id
         and c.title_id = f.title_id
        where l.organization_id = ${orgId}::uuid and l.kind = 'machine'
          and l.machine_id is not null and l.archived_at is null`),
      // Utan Awish-läsning: titlarna med pack enligt lagret (kapaciteten okänd).
      tx.execute(sql`
        select l.machine_id::text as machine_id, sl.title_id::text as title_id, t.name,
               sl.quantity
        from public.stock_locations l
        join public.stock_levels sl
          on sl.organization_id = l.organization_id and sl.location_id = l.id
        join public.titles t on t.organization_id = l.organization_id and t.id = sl.title_id
        where l.organization_id = ${orgId}::uuid and l.kind = 'machine'
          and l.machine_id is not null and l.archived_at is null
          and (l.awish_fill is null or jsonb_array_length(l.awish_fill) = 0)
          and sl.quantity > 0`),
      tx.execute(sql`
        select latitude, longitude from public.stock_locations
        where organization_id = ${orgId}::uuid and kind = 'warehouse' and archived_at is null
          and latitude is not null and longitude is not null
        order by is_central desc nulls last
        limit 1`),
    ]);
    const slots = new Map<string, AutoSlot[]>();
    const push = (machineId: string, s: AutoSlot) => {
      const list = slots.get(machineId) ?? [];
      list.push(s);
      slots.set(machineId, list);
    };
    for (const r of Array.from(fillRows) as Row[]) {
      const names = Array.isArray(r.names) ? (r.names as string[]) : [];
      push(String(r.machine_id), {
        titleId: String(r.title_id),
        name: String(r.name ?? ""),
        channels: names,
        units: Math.max(0, num(r.units) ?? 0),
        capacity: Math.max(0, num(r.capacity) ?? 0) || null,
        slots: Math.max(1, num(r.channels) ?? 1),
        empty: Math.max(0, num(r.empty) ?? 0),
      });
    }
    for (const r of Array.from(levelRows) as Row[]) {
      push(String(r.machine_id), {
        titleId: String(r.title_id),
        name: String(r.name ?? ""),
        channels: [],
        units: Math.max(0, num(r.quantity) ?? 0),
        capacity: null,
        slots: 1,
        empty: 0,
      });
    }
    const o = (Array.from(originRows) as Row[])[0];
    const lat = num(o?.latitude);
    const lng = num(o?.longitude);
    return { slots, origin: lat !== null && lng !== null ? { lat, lng } : null };
  });
}

/** "30 d", "7 d", "i går", "14–20 nov." efter periodvalet (?period, ?from&to). */
function periodLabel(sp: SearchParamsInput, timeZone: string): string {
  const p = parsePeriod(sp, { timeZone });
  if (p.key === "7d") return "7 d";
  if (p.key === "30d") return "30 d";
  return periodNameInline(p);
}

/** Periodens intäkt och vinst per automat (bara ekonomiroller; ett fel stoppar inte sidan). */
async function loadPeriodMoney(
  sp: SearchParamsInput,
  timeZone: string,
): Promise<{ byId: Map<string, { revenueOre: number; profitOre: number }>; label: string }> {
  try {
    const data = await loadOverview(sp);
    return {
      byId: new Map(
        data.overview.rows.map((r) => [r.id, { revenueOre: r.revenueOre, profitOre: r.profitOre }]),
      ),
      label: periodLabel(sp, timeZone),
    };
  } catch (error) {
    console.error("[automater/v2] Periodens siffror kunde inte räknas:", error);
    return { byId: new Map(), label: "30 d" };
  }
}

export async function loadAutomaterV2(
  ctx: AppContext,
  sp: SearchParamsInput,
): Promise<AutomaterV2Data> {
  const [fleet, slotData, money] = await Promise.all([
    loadFleetState(),
    loadSlots(ctx.organization.id),
    ctx.canSeeEconomy ? loadPeriodMoney(sp, ctx.timeZone) : Promise.resolve(null),
  ]);
  const machines: AutoMachine[] = fleet.machines.map((m) => {
    const p = money?.byId.get(m.id);
    return {
      id: m.id,
      code: m.code,
      name: m.name,
      storeId: m.store?.id ?? null,
      storeName: m.store?.name ?? null,
      city: m.store?.city ?? null,
      address: m.store?.address ?? null,
      phone: m.store?.phone ?? null,
      contactName: m.store?.contactName ?? null,
      lat: m.store?.location?.lat ?? null,
      lng: m.store?.location?.lng ?? null,
      power: m.store?.power ?? null,
      status: m.status,
      statusLabel: m.statusLabel,
      tone: m.tone,
      fillBp: m.fill?.fillBp ?? null,
      units: m.units,
      capacity: m.fill?.capacity ?? null,
      emptyChannels: m.fill?.emptyChannels ?? 0,
      daysLeft: m.daysLeft,
      perDayMilli: m.unitsPerDayMilli,
      lastRefillAt: m.lastRefillAt,
      sales30: m.sales30,
      powerOffNow: m.powerOffNow,
      offlineSince: m.offlineSince,
      slots: slotData.slots.get(m.id) ?? [],
      // Belopp bara för roller med ekonomi (flottans läge har redan null för påfyllaren).
      economy:
        ctx.canSeeEconomy && m.economy
          ? {
              profitPerDayOre: m.economy.profitPerDayOre,
              vsMedianOre: m.economy.vsMedianOre,
              verdict: m.economy.verdict,
              lossProfitPerDayOre: m.economy.lossProfitPerDayOre,
              revenueOre: p?.revenueOre ?? null,
              profitOre: p?.profitOre ?? null,
            }
          : null,
    };
  });
  return {
    machines,
    economy: ctx.canSeeEconomy && fleet.economy,
    cityOrder: cityOrderFrom(machines, slotData.origin),
    periodLabel: money?.label ?? periodLabel(sp, ctx.timeZone),
    canFill: ctx.role === "owner" || ctx.role === "admin" || ctx.role === "refiller",
    now: fleet.now,
    timeZone: fleet.timeZone,
  };
}
