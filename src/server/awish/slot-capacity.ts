/**
 * Fyllnadsgrad: kapaciteten per titel i en automat från Awish (machine_slot_capacity).
 *
 * Körs av applyMachineStock (./stock) i samma transaktion som inventeringarna:
 *
 * - Facken är redan grupperade per vara (groupProducts). Två varunamn som pekar på
 *   samma titel (alias, sammanslagna titlar) summeras: kapaciteten läggs ihop och
 *   facken slås ihop, sorterade som i groupProducts ("A2" före "A10").
 * - Varje titel med kapacitet > 0 skrivs (upsert) med tiden för läsningen.
 * - Automatens övriga rader tas bort: titlar som inte längre står i automaten, och
 *   titlar vars kapacitet summerades till 0.
 *
 * Tabellen saknar audit-trigger med flit (raderna skrivs om var femte minut).
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Tx } from "@/db/client";

import type { AwishSlotGroup } from "./stock";

/** Kapacitet och fack per titel. Ren funktion. */
export function capacityByTitle(
  groups: readonly Pick<AwishSlotGroup, "key" | "capacity" | "channels">[],
  titleIdByKey: ReadonlyMap<string, string>,
): Map<string, { capacity: number; channels: string[] }> {
  const out = new Map<string, { capacity: number; channels: string[] }>();
  for (const g of groups) {
    const titleId = titleIdByKey.get(g.key);
    if (!titleId) continue;
    const cur = out.get(titleId) ?? { capacity: 0, channels: [] };
    cur.capacity += Math.max(0, Math.trunc(g.capacity));
    cur.channels.push(...g.channels);
    out.set(titleId, cur);
  }
  for (const v of out.values()) {
    v.channels = [...new Set(v.channels)].sort((a, b) =>
      a.localeCompare(b, "sv", { numeric: true, sensitivity: "base" }),
    );
  }
  return out;
}

/** Högsta kapacitet per rad (tabellens check). */
const MAX_CAPACITY = 10_000;

/** Skriver automatens kapacitet från Awish och tar bort det som inte längre gäller. */
export async function writeSlotCapacities(
  tx: Tx,
  input: {
    org: string;
    machineId: string;
    /** Tiden för läsningen (ISO). */
    at: string;
    groups: readonly AwishSlotGroup[];
    titleIdByKey: ReadonlyMap<string, string>;
  },
): Promise<number> {
  const lines = [...capacityByTitle(input.groups, input.titleIdByKey)]
    .filter(([, v]) => v.capacity > 0)
    .map(([titleId, v]) => ({
      title_id: titleId,
      capacity: Math.min(MAX_CAPACITY, v.capacity),
      channels: v.channels.map((c) => c.slice(0, 40)).slice(0, 200),
    }));
  const keep = lines.map((l) => l.title_id);
  await tx.execute(
    sql`delete from public.machine_slot_capacity
        where organization_id = ${input.org}::uuid and machine_id = ${input.machineId}::uuid
          and not (title_id = any (array(select jsonb_array_elements_text(${JSON.stringify(keep)}::jsonb)::uuid)))`,
  );
  if (lines.length > 0) {
    await tx.execute(
      sql`insert into public.machine_slot_capacity
            (organization_id, machine_id, title_id, capacity, channels, synced_at)
          select ${input.org}::uuid, ${input.machineId}::uuid, r.title_id, r.capacity,
                 array(select jsonb_array_elements_text(r.channels)), ${input.at}::timestamptz
          from jsonb_to_recordset(${JSON.stringify(lines)}::jsonb)
            as r(title_id uuid, capacity integer, channels jsonb)
          on conflict (organization_id, machine_id, title_id) do update
            set capacity = excluded.capacity,
                channels = excluded.channels,
                synced_at = excluded.synced_at`,
    );
  }
  return lines.length;
}
