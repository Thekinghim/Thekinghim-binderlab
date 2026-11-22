/**
 * Senaste köp på Hem (V2): de nyaste riktiga orderna (samma lista och fråga som /order,
 * nyast först, testköp med men märkta). Awish skickar köp ungefär var 5:e minut och skalet
 * laddar om sidan (use-auto-refresh). Bara ekonomiroller (påfyllaren läser inte order, RLS).
 */

import "server-only";

import { addDays } from "@/domain";
import { loadContext, requireViewer } from "@/server/data/core";

import { parseOrderParams } from "@/app/(app)/order/_lib/params";
import { loadOrderListFor } from "@/app/(app)/order/_lib/service";

/** Så många köp visas. */
export const LIVE_LIMIT = 8;
/** Så många dagar bakåt letas det (en tom lista betyder inga köp på två dygn). */
export const LIVE_DAYS = 2;

export interface LiveOrder {
  readonly id: string;
  readonly orderedAt: string;
  readonly titleName: string;
  readonly machineCode: string | null;
  readonly storeName: string | null;
  readonly amountOre: number;
  readonly testPurchase: boolean;
}

export async function loadLiveOrders(): Promise<LiveOrder[] | null> {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  const viewer = await requireViewer();
  const list = await loadOrderListFor(
    viewer,
    {
      period: { start: addDays(ctx.today, -(LIVE_DAYS - 1)), end: ctx.today },
      compare: null,
      scope: { storeId: null, machineId: null },
      params: parseOrderParams({}),
    },
    new Date(ctx.now),
    LIVE_LIMIT,
  );
  const title = new Map(list.refs.titles.map((t) => [t.id, t.name]));
  const machine = new Map(list.refs.machines.map((m) => [m.id, m.code]));
  const store = new Map(list.refs.stores.map((s) => [s.id, s.name]));
  return list.rows.slice(0, LIVE_LIMIT).map((r) => ({
    id: r.id,
    orderedAt: r.orderedAt,
    titleName: (r.titleId ? title.get(r.titleId) : null) ?? r.rawTitle ?? "Okänd titel",
    machineCode: r.machineId ? (machine.get(r.machineId) ?? null) : null,
    storeName: r.storeId ? (store.get(r.storeId) ?? null) : null,
    amountOre: r.amountOre,
    testPurchase: r.testPurchase,
  }));
}
