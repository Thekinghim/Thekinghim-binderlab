/**
 * Obetalda månadsavräkningar för Att göra (src/server/data/core/loaders.ts). Egen fil
 * utan beroende på laddarna, så att laddarna kan använda den utan cirkulär import.
 */

import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";

import type { SettlementRef } from "@/analytics/todos";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { IsoDate } from "@/domain";

/** Obetalda avräkningar (för Att göra). */
export async function queryUnpaidSettlements(tx: Tx, orgId: string): Promise<SettlementRef[]> {
  const rows = await tx
    .select({
      id: s.storeSettlements.id,
      storeId: s.storeSettlements.storeId,
      month: s.storeSettlements.month,
      amountOre: s.storeSettlements.amountOre,
    })
    .from(s.storeSettlements)
    .where(
      and(
        eq(s.storeSettlements.organizationId, orgId),
        isNull(s.storeSettlements.paidOn),
        sql`${s.storeSettlements.amountOre} > 0`,
      ),
    );
  return rows.map((r) => ({ ...r, month: r.month as IsoDate }));
}
