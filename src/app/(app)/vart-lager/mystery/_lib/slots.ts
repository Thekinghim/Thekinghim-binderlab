/**
 * Mystery-facken i automaterna: underlaget till "Packa 1 omgång före fredag".
 *
 * Ett fack = en automat som har titeln i sortimentet i dag (fackperiod) eller har pack av
 * den kvar. För varje fack läses saldot nu, sålda pack de senaste 14 hela dagarna (takten)
 * och om automaten någonsin har sålt titeln (ny automat utan historik). Bara antal: alla
 * roller i appen får läsa det (påfyllaren läser försäljningshändelserna, inte orderna).
 */

import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import { addDays, type IsoDate } from "@/domain";
import { querySlotPeriods } from "@/server/data/assortment";

import { SLOT_WINDOW_DAYS, type SlotFacts } from "./model";

/** Det laddaren behöver om lagret och automaterna (läses redan av sidan). */
export interface SlotSources {
  readonly machines: ReadonlyArray<{ id: string; code: string; archived: boolean }>;
  /** Saldoraderna i automaterna. */
  readonly stock: ReadonlyArray<{
    locationId: string;
    locationKind: "warehouse" | "machine";
    machineId: string | null;
    titleId: string;
    onHand: number;
    lastCountedAt: string | null;
    lastRestockedAt: string | null;
  }>;
}

/** Fackens fakta per mystery-titel (titelns id → ett fack per automat, ordnade efter kod). */
export async function queryMysterySlotFacts(
  tx: Tx,
  orgId: string,
  today: IsoDate,
  titleIds: readonly string[],
  sources: SlotSources,
): Promise<Map<string, SlotFacts[]>> {
  const out = new Map<string, SlotFacts[]>(titleIds.map((id) => [id, []]));
  if (titleIds.length === 0) return out;
  const yesterday = addDays(today, -1);
  const windowStart = addDays(yesterday, -(SLOT_WINDOW_DAYS - 1));
  const [periods, sales] = await Promise.all([
    querySlotPeriods(tx, orgId),
    tx
      .select({
        locationId: s.stockEvents.locationId,
        titleId: s.stockEvents.titleId,
        recent: sql<number>`count(*) filter (where ${s.stockEvents.businessDate} >= ${windowStart}::date
                              and ${s.stockEvents.businessDate} <= ${yesterday}::date)::int`,
        ever: sql<number>`count(*)::int`,
      })
      .from(s.stockEvents)
      .where(
        and(
          eq(s.stockEvents.organizationId, orgId),
          eq(s.stockEvents.kind, "sale"),
          inArray(s.stockEvents.titleId, [...titleIds]),
        ),
      )
      .groupBy(s.stockEvents.locationId, s.stockEvents.titleId),
  ]);

  const wanted = new Set(titleIds);
  const machines = new Map(sources.machines.filter((m) => !m.archived).map((m) => [m.id, m.code]));
  const key = (machineId: string, titleId: string) => `${machineId}\u0000${titleId}`;
  const machineOfLocation = new Map<string, string>();
  const onHand = new Map<string, number | null>();
  for (const r of sources.stock) {
    if (r.locationKind !== "machine" || !r.machineId) continue;
    machineOfLocation.set(r.locationId, r.machineId);
    if (!wanted.has(r.titleId)) continue;
    const known = r.lastCountedAt !== null || r.lastRestockedAt !== null;
    onHand.set(key(r.machineId, r.titleId), known ? r.onHand : null);
  }
  const sold = new Map<string, { recent: number; ever: number }>();
  for (const r of sales) {
    const machineId = machineOfLocation.get(r.locationId);
    if (!machineId) continue;
    sold.set(key(machineId, r.titleId), { recent: Number(r.recent), ever: Number(r.ever) });
  }
  const pairs = new Set<string>();
  for (const p of periods) {
    if (!wanted.has(p.titleId)) continue;
    if (p.validFrom <= today && (p.validTo === null || p.validTo >= today)) {
      pairs.add(key(p.machineId, p.titleId));
    }
  }
  for (const [k, n] of onHand) if (n !== null && n > 0) pairs.add(k);

  for (const k of pairs) {
    const [machineId, titleId] = k.split("\u0000") as [string, string];
    const code = machines.get(machineId);
    if (code === undefined) continue;
    const s14 = sold.get(k);
    out.get(titleId)?.push({
      machineId,
      label: code,
      onHand: onHand.get(k) ?? null,
      sold: s14?.recent ?? 0,
      everSold: (s14?.ever ?? 0) > 0,
    });
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label, "sv", { numeric: true }));
  }
  return out;
}
