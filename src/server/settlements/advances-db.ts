/**
 * Betalningar för en egen period (store_payments) i databasen: läsa förskotten och markera
 * en avräkning som betald när förskotten täcker den. Egen fil utan beroende på tjänsten
 * (./service.ts använder den när avräkningar skapas och räknas om). Regeln står i
 * ./advance.ts.
 */

import "server-only";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { IsoDate, IsoMonth } from "@/domain";

import {
  advancePartsOf,
  advancesFor,
  advanceTotal,
  coverage,
  coveredPaidOn,
  parseParts,
  type AdvancePart,
  type StorePaymentRecord,
} from "./advance";
import { liveFor, sameComputed } from "./live";

/** Organisationens betalningar (en butik, eller alla), äldst först. */
export async function queryStorePayments(
  tx: Tx,
  orgId: string,
  storeId: string | null = null,
): Promise<StorePaymentRecord[]> {
  const rows = await tx
    .select({
      id: s.storePayments.id,
      storeId: s.storePayments.storeId,
      paidOn: s.storePayments.paidOn,
      amountOre: s.storePayments.amountOre,
      periodStart: s.storePayments.periodStart,
      periodEnd: s.storePayments.periodEnd,
      note: s.storePayments.note,
      parts: s.storePayments.parts,
    })
    .from(s.storePayments)
    .where(
      storeId
        ? and(eq(s.storePayments.organizationId, orgId), eq(s.storePayments.storeId, storeId))
        : eq(s.storePayments.organizationId, orgId),
    )
    .orderBy(s.storePayments.periodStart, s.storePayments.paidOn, s.storePayments.id);
  return rows.map((r) => ({
    id: r.id,
    storeId: r.storeId,
    paidOn: r.paidOn as IsoDate,
    amountOre: r.amountOre,
    periodStart: r.periodStart as IsoDate,
    periodEnd: r.periodEnd as IsoDate,
    note: r.note,
    parts: parseParts(r.parts),
  }));
}

/** Alla förskott (delar av betalningar) i organisationen. */
export async function queryAdvanceParts(
  tx: Tx,
  orgId: string,
  storeId: string | null = null,
): Promise<AdvancePart[]> {
  return advancePartsOf(await queryStorePayments(tx, orgId, storeId));
}

/**
 * Markerar obetalda avräkningar (av `ids`) som betalda när förskotten täcker dem: beloppet
 * räknas nu, och är förskotten minst så mycket blir avräkningen betald med betalningarna
 * (paid_from_payments). Betalt belopp = förskotten (null när de är exakt beloppet), dagen =
 * den senaste betalningens dag (coveredPaidOn). En avräkning som inte går att räkna lämnas.
 * Ger de som blev betalda, med månad.
 *
 * Stänger aldrig någon månad: den som anropar avgör det (registreringen gör det, jobbet inte).
 */
export async function settleCoveredTx(
  tx: Tx,
  orgId: string,
  ids: readonly string[],
  now: Date,
): Promise<{ id: string; storeId: string; month: IsoMonth }[]> {
  if (ids.length === 0) return [];
  const parts = await queryAdvanceParts(tx, orgId);
  if (parts.length === 0) return [];
  const rows = (
    await tx
      .select({
        id: s.storeSettlements.id,
        storeId: s.storeSettlements.storeId,
        month: s.storeSettlements.month,
        amountOre: s.storeSettlements.amountOre,
        statement: s.storeSettlements.statement,
      })
      .from(s.storeSettlements)
      .where(
        and(
          eq(s.storeSettlements.organizationId, orgId),
          inArray(s.storeSettlements.id, [...ids]),
          isNull(s.storeSettlements.paidOn),
        ),
      )
      .for("update")
  ).filter((r) => advancesFor(parts, r.storeId, r.month.slice(0, 7) as IsoMonth).length > 0);
  if (rows.length === 0) return [];
  const live = await liveFor(tx, orgId, rows, now);
  const out: { id: string; storeId: string; month: IsoMonth }[] = [];
  for (const r of rows) {
    const l = live.get(r.id);
    if (!l || !l.ok) continue;
    const month = r.month.slice(0, 7) as IsoMonth;
    const adv = advancesFor(parts, r.storeId, month);
    const total = advanceTotal(adv);
    const c = l.computed;
    if (!coverage(c.amountOre, total).covered) continue;
    const where = and(
      eq(s.storeSettlements.organizationId, orgId),
      eq(s.storeSettlements.id, r.id),
      isNull(s.storeSettlements.paidOn),
    );
    // Beloppet sparas som det är nu innan avräkningen låses som betald.
    if (!sameComputed(r, c)) {
      await tx
        .update(s.storeSettlements)
        .set({
          amountOre: c.amountOre,
          statement: c.statement as unknown as Record<string, unknown>,
          calcVersion: c.calcVersion,
          computedAt: now,
        })
        .where(where);
    }
    const done = await tx
      .update(s.storeSettlements)
      .set({
        paidOn: coveredPaidOn(adv, month),
        paidAmountOre: total === c.amountOre ? null : total,
        paidFromPayments: true,
        liveAmountOre: c.amountOre,
        liveCheckedAt: now,
      })
      .where(where)
      .returning({ id: s.storeSettlements.id });
    if (done.length > 0) out.push({ id: r.id, storeId: r.storeId, month });
  }
  return out;
}

/** Obetalda avräkningar som har förskott (för det nattliga jobbet och efter en borttagning). */
export async function unpaidWithAdvancesTx(tx: Tx, orgId: string): Promise<string[]> {
  const rows = Array.from(
    await tx.execute(sql`
      select distinct ss.id
      from public.store_settlements ss
      join public.store_payments p
        on p.organization_id = ss.organization_id and p.store_id = ss.store_id
      cross join lateral jsonb_array_elements(p.parts) part
      where ss.organization_id = ${orgId}::uuid and ss.paid_on is null
        and part ->> 'month' = to_char(ss.month, 'YYYY-MM')
        and (part ->> 'amountOre')::bigint > 0`),
  ) as { id: string }[];
  return rows.map((r) => String(r.id));
}
