/**
 * Kapacitet per automat och titel från Awish (tabellen machine_slot_capacity), för
 * besöksplanen ("fyll till kapacitet") och fyllnadsgraden på Drift.
 *
 * Läses av alla roller (inga belopp) med RLS. Skrivs bara av Awish-synken
 * (@/server/awish/slot-capacity). Rader äldre än CAPACITY_MAX_AGE_DAYS räknas inte:
 * då har automaten inte lästs på länge och kapaciteten kan vara fel.
 * Importeras direkt, inte via ./index.
 */

import "server-only";

import { and, eq, gte } from "drizzle-orm";

import type { MachineCapacity } from "@/analytics/visits";
import * as s from "@/db/schema";
import type { Tx } from "@/db/client";

/** Kapacitet som är äldre än så här många dagar ignoreras. */
export const CAPACITY_MAX_AGE_DAYS = 7;

export interface SlotCapacityRow extends MachineCapacity {
  readonly channels: readonly string[];
  /** ISO-tid för läsningen från Awish. */
  readonly syncedAt: string;
}

/** Kapaciteten i organisationen (färska rader), som användaren med RLS. */
export async function querySlotCapacities(
  tx: Tx,
  orgId: string,
  now: Date = new Date(),
): Promise<SlotCapacityRow[]> {
  const since = new Date(now.getTime() - CAPACITY_MAX_AGE_DAYS * 86_400_000);
  const rows = await tx
    .select({
      machineId: s.machineSlotCapacity.machineId,
      titleId: s.machineSlotCapacity.titleId,
      capacity: s.machineSlotCapacity.capacity,
      channels: s.machineSlotCapacity.channels,
      syncedAt: s.machineSlotCapacity.syncedAt,
    })
    .from(s.machineSlotCapacity)
    .where(
      and(
        eq(s.machineSlotCapacity.organizationId, orgId),
        gte(s.machineSlotCapacity.syncedAt, since),
      ),
    );
  return rows.map((r) => ({
    machineId: r.machineId,
    titleId: r.titleId,
    capacity: r.capacity,
    channels: r.channels ?? [],
    syncedAt: new Date(r.syncedAt).toISOString(),
  }));
}
