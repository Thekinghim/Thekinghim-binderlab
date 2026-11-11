/**
 * Loggar arbete som Binderlab gjort automatiskt (tabellen automation_log), så att sidan
 * Värde kan räkna sparad tid. Skrivs av servern (systemrollen). Ett fel här får aldrig
 * stoppa själva arbetet: loggen är en bonus, inte en del av påfyllningen.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";

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

// ---------------------------------------------------------------------------
// Sändningar till Awish som inte gick fram (runda 2, T1-3)
// ---------------------------------------------------------------------------

type OutcomeRow = { machine_id: string; kind: string; occurred_at: Date | string };

/**
 * Automater som VÄNTAR på Awish: senaste raden av 'awish_push', 'awish_push_failed' och
 * 'awish_push_cleared' är 'awish_push_failed'. Svarar automatens id → när felet uppstod.
 * Läses som systemrollen (Fyll på läser samma sak som användaren genom
 * public.awish_push_pending). `machineIds` begränsar frågan.
 */
export async function pendingAwishPushes(
  db: Db | Tx,
  organizationId: string,
  machineIds?: readonly string[],
): Promise<Map<string, Date>> {
  if (machineIds && machineIds.length === 0) return new Map();
  const only = machineIds
    ? sql`and a.machine_id in (select jsonb_array_elements_text(${JSON.stringify([...machineIds])}::jsonb)::uuid)`
    : sql``;
  const rows = Array.from(
    await db.execute(sql`
      select distinct on (a.machine_id) a.machine_id::text as machine_id, a.kind, a.occurred_at
      from public.automation_log a
      where a.organization_id = ${organizationId}::uuid
        and a.machine_id is not null
        and a.kind in ('awish_push', 'awish_push_failed', 'awish_push_cleared')
        ${only}
      order by a.machine_id, a.occurred_at desc, a.created_at desc, a.id desc`),
  ) as OutcomeRow[];
  const out = new Map<string, Date>();
  for (const r of rows) {
    if (r.kind !== "awish_push_failed") continue;
    out.set(r.machine_id, r.occurred_at instanceof Date ? r.occurred_at : new Date(r.occurred_at));
  }
  return out;
}

/**
 * Sparar utfallet per automat efter ett försök att skicka till Awish:
 * - fel ("error"): en rad 'awish_push_failed', om automaten inte redan väntar,
 * - allt annat för en automat som väntade: en rad 'awish_push_cleared' (försöket gick fram,
 *   eller det fanns inget kvar att skicka). En lyckad sändning med ändrade fack har redan
 *   fått sin 'awish_push'-rad av logAwishPushes och behöver ingen till.
 * Ett fel här stoppar aldrig pushen. Svarar automaterna som väntar efteråt.
 */
export async function logAwishPushOutcomes(
  db: Db,
  organizationId: string,
  machines: ReadonlyArray<{ machineId: string; status: string; slotsUpdated: number }>,
): Promise<string[]> {
  try {
    const ids = [...new Set(machines.map((m) => m.machineId))];
    const pending = await pendingAwishPushes(db, organizationId, ids);
    for (const m of machines) {
      const waits = pending.has(m.machineId);
      const kind =
        m.status === "error"
          ? waits
            ? null
            : "awish_push_failed"
          : waits && !(m.status === "pushed" && m.slotsUpdated > 0)
            ? "awish_push_cleared"
            : null;
      if (kind === null) continue;
      // Villkoret kontrolleras igen i samma sats: två försök samtidigt (två telefoner med
      // Fyll på öppet) ska inte ge en rad till efter att det andra redan har skrivit sin.
      const wasFailed = kind === "awish_push_cleared";
      await db.execute(
        sql`insert into public.automation_log (organization_id, kind, machine_id, units)
            select ${organizationId}::uuid, ${kind}, ${m.machineId}::uuid, 0
            where (coalesce((
                     select a.kind from public.automation_log a
                     where a.organization_id = ${organizationId}::uuid
                       and a.machine_id = ${m.machineId}::uuid
                       and a.kind in ('awish_push', 'awish_push_failed', 'awish_push_cleared')
                     order by a.occurred_at desc, a.created_at desc, a.id desc
                     limit 1), '') = 'awish_push_failed') = ${wasFailed}::boolean`,
      );
    }
    return [...(await pendingAwishPushes(db, organizationId)).keys()];
  } catch (error) {
    console.error("Kunde inte logga utfallet av Awish-push i automation_log.", error);
    return [];
  }
}
