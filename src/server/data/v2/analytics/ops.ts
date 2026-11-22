/**
 * Driftstatus på Hem (V2): online nu (flottans läge: allt utom offline), ström av enligt
 * butikernas tider och senaste lyckade synk från Awish. Alla roller (inga belopp).
 *
 * Drifttid i % över 30 dagar visas inte: maskinhälsan sparar inga offline-perioder bakåt
 * (lucka i byggplanen avsnitt 7).
 */

import "server-only";

import { loadSyncInfo } from "@/server/data/core";

import { loadFleetState } from "../fleet";

export interface OpsCard {
  readonly total: number;
  readonly online: number;
  readonly offline: readonly {
    readonly id: string;
    readonly name: string;
    readonly code: string;
    readonly since: string | null;
  }[];
  readonly powerOff: number;
  /** "21:00–08:00" för den första som är av nu, annars null. */
  readonly powerWindow: string | null;
  readonly syncedAt: string | null;
  readonly syncState: "ok" | "stale" | "failed" | "no-orders" | null;
}

export async function loadOps(): Promise<OpsCard> {
  const [fleet, sync] = await Promise.all([loadFleetState(), loadSyncInfo().catch(() => null)]);
  const offline = fleet.machines.filter((m) => m.status === "offline");
  const off = fleet.machines.filter((m) => m.powerOffNow);
  const firstPower = off.map((m) => m.store?.power).find((p) => p) ?? null;
  return {
    total: fleet.machines.length,
    online: fleet.machines.length - offline.length,
    offline: offline.map((m) => ({ id: m.id, name: m.name, code: m.code, since: m.offlineSince })),
    powerOff: off.length,
    powerWindow: firstPower ? `${firstPower.off}–${firstPower.on}` : null,
    syncedAt: sync?.syncedAt ?? null,
    syncState: sync?.state ?? null,
  };
}
