/**
 * Loggar arbete som Binderlab gjort automatiskt (tabellen automation_log), så att sidan
 * Värde kan räkna sparad tid. Skrivs av servern (systemrollen). Ett fel här får aldrig
 * stoppa själva arbetet: loggen är en bonus, inte en del av påfyllningen.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";

/** Automater som Binderlab satte i Awish (bara de där minst ett fack ändrades). */
export async function logAwishPushes(
  db: Db,
  organizationId: string,
  machines: ReadonlyArray<{ machineId: string; status: string; slotsUpdated: number }>,
): Promise<number> {
  const pushed = machines.filter((m) => m.status === "pushed" && m.slotsUpdated > 0);
  if (pushed.length === 0) return 0;
  try {
    for (const m of pushed) {
      await db.execute(
        sql`insert into public.automation_log (organization_id, kind, machine_id, units)
            values (${organizationId}::uuid, 'awish_push', ${m.machineId}::uuid,
                    ${Math.min(m.slotsUpdated, 10_000)})`,
      );
    }
    return pushed.length;
  } catch (error) {
    console.error("Kunde inte logga Awish-push i automation_log.", error);
    return 0;
  }
}
