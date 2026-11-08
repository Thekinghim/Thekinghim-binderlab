/**
 * Laddaren för Fyll på: automaterna, saldot i dem, packen i våra egna lager (Hemma,
 * Kontoret …, och automaternas "Fylls på från") och senaste Awish-läsningen. Som användaren med RLS efter rollkontroll mot databasen (ägare, admin,
 * påfyllare). Bara antal, aldrig belopp. Testbar utan Next (test/db/fyll-pa.test.ts).
 */

import "server-only";

import { and, count, eq, gte, isNull, lte, or, sql } from "drizzle-orm";

import { isMine } from "@/analytics/team";
import { retiredPairs } from "@/analytics/todos";
import * as s from "@/db/schema";
import { addDays } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { querySlotPeriods } from "@/server/data/assortment";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { queryRefillSources, type RefillSources } from "@/server/data/core/places";
import { mysteryBatchSql } from "@/server/data/core/queries";
import { FIELD_REFILL_ROLES } from "@/server/data/field-refills";
import { queryResponsibles } from "@/server/data/team";

import {
  fillMachines,
  pairKey,
  SALES_WINDOW_DAYS,
  type AwishFillEntry,
  type FillMachine,
} from "./model";

export interface FillData {
  /** Automaterna; radernas `home` är standardlagrets saldo (webbläsaren räknar om för valt lager). */
  readonly machines: FillMachine[];
  /** Lagren, saldot per lager och automaternas "Fylls på från". */
  readonly sources: RefillSources;
  readonly hasWarehouse: boolean;
  /** Sant när någon automat har en annan ansvarig än jag ("Mina" visas då). */
  readonly hasOthers: boolean;
}

function cleanFill(raw: unknown): AwishFillEntry[] | null {
  if (!Array.isArray(raw)) return null;
  const out: AwishFillEntry[] = [];
  for (const e of raw) {
    if (typeof e !== "object" || e === null) continue;
    const r = e as Record<string, unknown>;
    if (typeof r.title_id !== "string") continue;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : 0);
    out.push({
      title_id: r.title_id,
      units: n(r.units),
      capacity: n(r.capacity),
      channels: n(r.channels),
      empty: n(r.empty),
    });
  }
  return out;
}

export async function loadFillDataFor(viewer: Viewer, now: Date = new Date()): Promise<FillData> {
  await requireRoleFor(viewer.user, viewer.organization.id, FIELD_REFILL_ROLES);
  const orgId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  const yesterday = addDays(today, -1);
  const windowStart = addDays(yesterday, -(SALES_WINDOW_DAYS - 1));
  return withUserDbFor(viewer.user, async (tx) => {
    const [machines, placements, locations, levels, titles, periods, sources, sales, responsibles] =
      await Promise.all([
        tx
          .select({ id: s.machines.id, code: s.machines.code, name: s.machines.name })
          .from(s.machines)
          .where(and(eq(s.machines.organizationId, orgId), isNull(s.machines.archivedAt))),
        tx
          .select({ machineId: s.machinePlacements.machineId, storeName: s.stores.name })
          .from(s.machinePlacements)
          .innerJoin(
            s.stores,
            and(
              eq(s.stores.organizationId, s.machinePlacements.organizationId),
              eq(s.stores.id, s.machinePlacements.storeId),
            ),
          )
          .where(
            and(
              eq(s.machinePlacements.organizationId, orgId),
              lte(s.machinePlacements.validFrom, today),
              or(isNull(s.machinePlacements.validTo), gte(s.machinePlacements.validTo, today)),
            ),
          ),
        tx
          .select({
            id: s.stockLocations.id,
            machineId: s.stockLocations.machineId,
            syncedAt: s.stockLocations.awishSyncedAt,
            fill: s.stockLocations.awishFill,
          })
          .from(s.stockLocations)
          .where(
            and(eq(s.stockLocations.organizationId, orgId), isNull(s.stockLocations.archivedAt)),
          ),
        tx
          .select({
            locationId: s.stockLevels.locationId,
            titleId: s.stockLevels.titleId,
            quantity: s.stockLevels.quantity,
          })
          .from(s.stockLevels)
          .where(eq(s.stockLevels.organizationId, orgId)),
        tx
          .select({
            id: s.titles.id,
            name: s.titles.name,
            // Mystery pack: pack per omgång (fylls bara på när facket är tomt).
            batch: sql<number | null>`${mysteryBatchSql("titles")}`,
          })
          .from(s.titles)
          .where(
            and(
              eq(s.titles.organizationId, orgId),
              isNull(s.titles.archivedAt),
              isNull(s.titles.mergedIntoId),
            ),
          ),
        querySlotPeriods(tx, orgId),
        queryRefillSources(tx, orgId),
        // Sålda pack per automat och titel de senaste 14 hela dagarna (försäljningshändelserna i
        // automaternas lager; påfyllaren får läsa dem men inte orderna).
        tx
          .select({
            locationId: s.stockEvents.locationId,
            titleId: s.stockEvents.titleId,
            n: count(),
          })
          .from(s.stockEvents)
          .where(
            and(
              eq(s.stockEvents.organizationId, orgId),
              eq(s.stockEvents.kind, "sale"),
              gte(s.stockEvents.businessDate, windowStart),
              lte(s.stockEvents.businessDate, yesterday),
            ),
          )
          .groupBy(s.stockEvents.locationId, s.stockEvents.titleId),
        queryResponsibles(tx, orgId),
      ]);

    const storeOf = new Map(placements.map((p) => [p.machineId, p.storeName]));
    const byLocation = new Map(
      locations.filter((l) => l.machineId !== null).map((l) => [l.id, l.machineId as string]),
    );
    const locationOf = new Map(
      locations.filter((l) => l.machineId !== null).map((l) => [l.machineId as string, l]),
    );
    const machineStock = new Map<string, number>();
    // Raderna räknas mot standardlagret; webbläsaren byter till automatens valda lager.
    const home = new Map(
      Object.entries(sources.defaultPlaceId ? (sources.stock[sources.defaultPlaceId] ?? {}) : {}),
    );
    for (const l of levels) {
      const machineId = byLocation.get(l.locationId);
      if (machineId) machineStock.set(pairKey(machineId, l.titleId), Number(l.quantity));
    }
    const sold = new Map<string, number>();
    for (const r of sales) {
      const machineId = byLocation.get(r.locationId);
      if (!machineId) continue;
      const k = pairKey(machineId, r.titleId);
      sold.set(k, (sold.get(k) ?? 0) + Number(r.n));
    }
    const me = viewer.user.userId;
    const current = new Set<string>();
    for (const p of periods) {
      if (p.validFrom <= today && (p.validTo === null || p.validTo >= today)) {
        current.add(pairKey(p.machineId, p.titleId));
      }
    }

    const list = fillMachines({
      machines: machines.map((m) => {
        const loc = locationOf.get(m.id);
        return {
          id: m.id,
          code: m.code,
          name: m.name,
          storeName: storeOf.get(m.id) ?? null,
          syncedAt: loc?.syncedAt ? loc.syncedAt.toISOString() : null,
          fill: cleanFill(loc?.fill ?? null),
          mine: isMine(responsibles.get(m.id), me),
        };
      }),
      titles: new Map(titles.map((t) => [t.id, t.name])),
      machineStock,
      home,
      current,
      retired: retiredPairs(periods, today),
      sold,
      mystery: new Map(
        titles.flatMap((t) => (t.batch === null ? [] : [[t.id, Number(t.batch)] as const])),
      ),
    });
    return {
      machines: list,
      sources,
      hasWarehouse: sources.places.length > 0,
      hasOthers: list.some((m) => !m.mine),
    };
  });
}
