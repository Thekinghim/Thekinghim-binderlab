/**
 * Obetalda månadsavräkningar för Att göra och Hem (src/server/data/core/loaders.ts). Egen
 * fil utan beroende på laddarna, så att laddarna kan använda den utan cirkulär import.
 *
 * Beloppet räknas om NU (./live.ts), samma som på Butiksportal: ett sparat belopp från
 * innan inköpspriser, testköp eller avtal ändrades visas aldrig som "Betala … kr".
 * Betalningar i förskott för månaden (store_payments) dras av: punkten säger det som är kvar.
 */

import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { PaidDriftRef, SettlementRef } from "@/analytics/todos";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { monthPeriod, PlacementIndex, type IsoDate, type IsoMonth } from "@/domain";
import { queryEffectivePlacements } from "@/server/data/core/queries";
import { storesPlacedIn } from "@/server/reports/sources";

import { advancesFor, advanceTotal } from "./advance";
import { queryAdvanceParts } from "./advances-db";
import { liveFor } from "./live";

/** Obetalda avräkningar med beloppet räknat nu (för Att göra). */
export async function queryUnpaidSettlements(
  tx: Tx,
  orgId: string,
  now: Date = new Date(),
): Promise<SettlementRef[]> {
  const rows = await tx
    .select({
      id: s.storeSettlements.id,
      storeId: s.storeSettlements.storeId,
      month: s.storeSettlements.month,
      amountOre: s.storeSettlements.amountOre,
    })
    .from(s.storeSettlements)
    .where(and(eq(s.storeSettlements.organizationId, orgId), isNull(s.storeSettlements.paidOn)));
  if (rows.length === 0) return [];
  const [live, advances] = await Promise.all([
    liveFor(tx, orgId, rows, now),
    queryAdvanceParts(tx, orgId),
  ]);
  const out: SettlementRef[] = [];
  for (const r of rows) {
    const l = live.get(r.id);
    const ref = { id: r.id, storeId: r.storeId, month: r.month as IsoDate };
    // Betalningar i förskott för månaden dras av: det som återstår att betala (./advance.ts).
    const advanceOre = advanceTotal(
      advancesFor(advances, r.storeId, r.month.slice(0, 7) as IsoMonth),
    );
    if (l && !l.ok) out.push({ ...ref, amountOre: r.amountOre - advanceOre, blocked: true });
    else {
      const amountOre = (l?.ok ? l.computed.amountOre : r.amountOre) - advanceOre;
      if (amountOre > 0) out.push({ ...ref, amountOre });
    }
  }
  return out;
}

/**
 * Butikerna som hade en automat under månaden men saknar avräkning för den (samma urval
 * som "Skapa avräkningarna" på Utbetalning, src/server/settlements/service.ts). För punkten
 * "Skapa oktober-avräkningarna" i Att göra och på Hem.
 */
export async function queryMissingSettlements(
  tx: Tx,
  orgId: string,
  month: IsoMonth,
): Promise<{ month: IsoMonth; storeIds: string[] }> {
  const [placements, existing] = await Promise.all([
    queryEffectivePlacements(tx, orgId),
    tx
      .select({ storeId: s.storeSettlements.storeId })
      .from(s.storeSettlements)
      .where(
        and(
          eq(s.storeSettlements.organizationId, orgId),
          eq(s.storeSettlements.month, `${month}-01`),
        ),
      ),
  ]);
  const have = new Set(existing.map((r) => r.storeId));
  const storeIds = storesPlacedIn(placements, monthPeriod(month)).filter((id) => !have.has(id));
  return { month, storeIds };
}

/**
 * Äldre avslutade månader (före `beforeMonth`) där en butik hade försäljning men saknar
 * avräkning, äldst först. Butiken för en order är den automaten stod i orderns dag (samma
 * placeringar som avräkningen räknar med).
 *
 * Stängda månader räknas också: en månad kan stängas av att bokföringen skickas (eller för
 * hand) medan en butik fortfarande saknar avräkning, och butiken ska ha sina pengar ändå.
 * Avräkningen ändrar inget i månaden, den räknas på det som redan står där.
 *
 * Utan det här föll en butik bort för gott när månaden inte kunde räknas i tid (saknat
 * inköpspris under vinstdelning) eller när automaten kopplades i efterhand: bara förra
 * månaden skapades och listades.
 *
 * Bara månader från och med organisationens FÖRSTA avräkningsmånad räknas: det som såldes
 * innan appen började avräkna har betalats utanför appen och ska inte dyka upp som obetalt.
 * En organisation utan någon avräkning har alltså inga äldre månader (bara förra månaden).
 */
export async function queryOlderMissingSettlements(
  tx: Tx,
  orgId: string,
  beforeMonth: IsoMonth,
): Promise<{ month: IsoMonth; storeIds: string[] }[]> {
  const [placements, days, existing] = await Promise.all([
    queryEffectivePlacements(tx, orgId),
    tx.execute(sql`
      select distinct o.machine_id, o.business_date::text as day
      from public.orders o
      where o.organization_id = ${orgId}::uuid and o.machine_id is not null
        and o.test_purchase_at is null and o.amount_ore > 0
        and o.business_date < ${`${beforeMonth}-01`}::date`),
    tx.execute(sql`
      select store_id, to_char(month, 'YYYY-MM') as month
      from public.store_settlements where organization_id = ${orgId}::uuid`),
  ]);
  const existingRows = Array.from(existing) as { store_id: string; month: string }[];
  const have = new Set(existingRows.map((r) => `${r.store_id}|${r.month}`));
  const firstMonth = existingRows.map((r) => r.month).sort()[0];
  if (firstMonth === undefined) return [];
  const index = new PlacementIndex(placements);
  const byMonth = new Map<string, Set<string>>();
  for (const r of Array.from(days) as { machine_id: string; day: string }[]) {
    const day = r.day.slice(0, 10) as IsoDate;
    const month = day.slice(0, 7);
    if (month < firstMonth) continue;
    const storeId = index.storeOn(String(r.machine_id), day);
    if (storeId === null || have.has(`${storeId}|${month}`)) continue;
    const set = byMonth.get(month);
    if (set) set.add(storeId);
    else byMonth.set(month, new Set([storeId]));
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, ids]) => ({ month: month as IsoMonth, storeIds: [...ids].sort() }));
}

/**
 * Betalda avräkningar där dagens uträkning (sparad av det nattliga jobbet, live_amount_ore)
 * skiljer sig från det som betalades och skillnaden inte är lagd som rättelse. För punkten
 * "Betald avräkning skiljer sig från dagens uträkning" i Att göra.
 */
export async function queryPaidDrift(tx: Tx, orgId: string): Promise<PaidDriftRef[]> {
  const rows = Array.from(
    await tx.execute(sql`
      select id, store_id, to_char(month, 'YYYY-MM-DD') as month,
             coalesce(paid_amount_ore, amount_ore) as paid_ore, live_amount_ore as live_ore,
             corrected_ore
      from public.store_settlements
      where organization_id = ${orgId}::uuid and paid_on is not null
        and live_amount_ore is not null
        and live_amount_ore - coalesce(paid_amount_ore, amount_ore) - corrected_ore <> 0
      order by month, id`),
  ) as {
    id: string;
    store_id: string;
    month: string;
    paid_ore: number | string;
    live_ore: number | string;
    corrected_ore: number | string;
  }[];
  return rows.map((r) => ({
    id: String(r.id),
    storeId: String(r.store_id),
    month: r.month as IsoDate,
    paidOre: Number(r.paid_ore),
    liveOre: Number(r.live_ore),
    differenceOre: Number(r.live_ore) - Number(r.paid_ore) - Number(r.corrected_ore),
  }));
}
