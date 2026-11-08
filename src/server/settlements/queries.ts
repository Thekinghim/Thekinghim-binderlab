/**
 * Obetalda månadsavräkningar för Att göra och Hem (src/server/data/core/loaders.ts). Egen
 * fil utan beroende på laddarna, så att laddarna kan använda den utan cirkulär import.
 *
 * Beloppet räknas om NU (./live.ts), samma som på Butiksportal: ett sparat belopp från
 * innan inköpspriser, testköp eller avtal ändrades visas aldrig som "Betala … kr".
 */

import "server-only";

import { and, eq, isNull } from "drizzle-orm";

import type { SettlementRef } from "@/analytics/todos";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { monthPeriod, type IsoDate, type IsoMonth } from "@/domain";
import { queryPlacements } from "@/server/data/core/queries";
import { storesPlacedIn } from "@/server/reports/sources";

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
  const live = await liveFor(tx, orgId, rows, now);
  const out: SettlementRef[] = [];
  for (const r of rows) {
    const l = live.get(r.id);
    const ref = { id: r.id, storeId: r.storeId, month: r.month as IsoDate };
    if (l && !l.ok) out.push({ ...ref, amountOre: r.amountOre, blocked: true });
    else {
      const amountOre = l?.ok ? l.computed.amountOre : r.amountOre;
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
    queryPlacements(tx, orgId),
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
