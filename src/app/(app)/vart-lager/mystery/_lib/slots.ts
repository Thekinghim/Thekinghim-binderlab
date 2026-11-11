/**
 * Mystery-facken i automaterna: underlaget till "Packa 1 omgång före fredag".
 *
 * Ett fack = en automat som har titeln i sortimentet i dag (fackperiod), står med i den
 * senaste läsningen från Awish, har pack av den kvar eller har sålt den de senaste 14 dagarna
 * (samma regel som raderna i Fyll på, så att "0 färdiga, fyll på en omgång" där och "Packa 1
 * omgång nu" här gäller samma fack). En titel som gått ur automatens sortiment och står på 0
 * är inget fack. För varje fack läses saldot nu, sålda pack de senaste 14 hela dagarna (takten)
 * och om automaten någonsin har sålt något alls (ny automat utan historik; en gammal automat
 * som får ett nytt mystery pack är inte "ny"). Bara antal: alla
 * roller i appen får läsa det (påfyllaren läser försäljningshändelserna, inte orderna).
 */

import "server-only";

import { and, eq, gte, inArray, isNotNull, lte, sql } from "drizzle-orm";

import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import { retiredPairs } from "@/analytics/todos";
import { addDays, type IsoDate } from "@/domain";
import { querySlotPeriods } from "@/server/data/assortment";

import { SLOT_WINDOW_DAYS, type SlotFacts } from "./model";

/** Det laddaren behöver om lagret och automaterna (läses redan av sidan). */
export interface SlotSources {
  readonly machines: ReadonlyArray<{
    id: string;
    code: string;
    archived: boolean;
    activeFrom?: IsoDate | null;
  }>;
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
  const [periods, fills, sales, active] = await Promise.all([
    querySlotPeriods(tx, orgId),
    // Senaste läsningen från Awish per automat (vilka titlar som står i facken).
    tx
      .select({ machineId: s.stockLocations.machineId, fill: s.stockLocations.awishFill })
      .from(s.stockLocations)
      .where(
        and(
          eq(s.stockLocations.organizationId, orgId),
          isNotNull(s.stockLocations.machineId),
          isNotNull(s.stockLocations.awishFill),
        ),
      ),
    tx
      .select({
        locationId: s.stockEvents.locationId,
        titleId: s.stockEvents.titleId,
        recent: sql<number>`count(*)::int`,
      })
      .from(s.stockEvents)
      .where(
        and(
          eq(s.stockEvents.organizationId, orgId),
          eq(s.stockEvents.kind, "sale"),
          inArray(s.stockEvents.titleId, [...titleIds]),
          gte(s.stockEvents.businessDate, windowStart),
          lte(s.stockEvents.businessDate, yesterday),
        ),
      )
      .groupBy(s.stockEvents.locationId, s.stockEvents.titleId),
    // Automater som har sålt något alls (vilken titel som helst): de är inte nya.
    tx
      .select({ machineId: s.stockLocations.machineId })
      .from(s.stockLocations)
      .where(
        and(
          eq(s.stockLocations.organizationId, orgId),
          isNotNull(s.stockLocations.machineId),
          sql`exists (select 1 from public.stock_events e
                      where e.organization_id = ${s.stockLocations.organizationId}
                        and e.location_id = ${s.stockLocations.id}
                        and e.kind = 'sale')`,
        ),
      ),
  ]);
  const hasSold = new Set(active.map((r) => r.machineId));

  const wanted = new Set(titleIds);
  const live = sources.machines.filter((m) => !m.archived);
  const machines = new Map(live.map((m) => [m.id, m.code]));
  const activeFrom = new Map(live.map((m) => [m.id, m.activeFrom ?? null]));
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
  const sold = new Map<string, number>();
  for (const r of sales) {
    const machineId = machineOfLocation.get(r.locationId);
    if (!machineId) continue;
    sold.set(key(machineId, r.titleId), Number(r.recent));
  }
  const pairs = new Set<string>();
  for (const p of periods) {
    if (!wanted.has(p.titleId)) continue;
    if (p.validFrom <= today && (p.validTo === null || p.validTo >= today)) {
      pairs.add(key(p.machineId, p.titleId));
    }
  }
  for (const [k, n] of onHand) if (n !== null && n > 0) pairs.add(k);
  // I automatens fack enligt Awish senaste läsning.
  const inFill = new Set<string>();
  for (const row of fills) {
    if (!row.machineId || !Array.isArray(row.fill)) continue;
    for (const e of row.fill as unknown[]) {
      const titleId =
        typeof e === "object" && e !== null ? (e as { title_id?: unknown }).title_id : null;
      if (typeof titleId === "string" && wanted.has(titleId)) {
        inFill.add(key(row.machineId, titleId));
      }
    }
  }
  for (const k of inFill) pairs.add(k);
  // Såld de senaste 14 dagarna: facket finns, även om det är tomt nu och saknar fackperiod.
  for (const [k, n] of sold) if (n > 0) pairs.add(k);
  // Utgången titel (hade en fackperiod, ingen gäller längre) som står på 0: inget fack.
  const retired = retiredPairs(periods, today);
  for (const k of [...pairs]) {
    if (retired.has(k) && !inFill.has(k) && (onHand.get(k) ?? 0) <= 0) pairs.delete(k);
  }

  for (const k of pairs) {
    const [machineId, titleId] = k.split("\u0000") as [string, string];
    const code = machines.get(machineId);
    if (code === undefined) continue;
    out.get(titleId)?.push({
      machineId,
      label: code,
      onHand: onHand.get(k) ?? null,
      sold: sold.get(k) ?? 0,
      everSold: hasSold.has(machineId),
      activeFrom: activeFrom.get(machineId) ?? null,
    });
  }
  for (const list of out.values()) {
    list.sort((a, b) => a.label.localeCompare(b.label, "sv", { numeric: true }));
  }
  return out;
}
