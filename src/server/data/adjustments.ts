/**
 * Det som dras från vinsten efter profitability(): återbetalningar till kunder (kundärenden
 * med återbetalt belopp, @/domain/refunds), gratis-pack (koder i Awish, inköpspris × antal)
 * och fasta kostnader (fixed_costs, @/analytics/cashflow). Läses som användaren (RLS) efter rollkontroll mot databasen:
 * bara ägare, admin och läsare. Påfyllaren ser aldrig belopp.
 */

import "server-only";

import { cache } from "react";
import { and, asc, eq, gte, isNull, lte, sql } from "drizzle-orm";

import type { FixedCost } from "@/analytics/cashflow";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import type { IsoDate, Period } from "@/domain";
import type { Refund } from "@/domain/refunds";
import type { FreePackCost } from "@/app/(app)/lonsamhet/_lib/result";
import { withUserDbFor } from "@/server/access";

import { requireViewer } from "./core";
import { requireViewerRole, type Viewer } from "./core/loaders";
import { ECONOMY_ROLES } from "./core/types";

export interface ProfitAdjustments {
  /** Återbetalningar med återbetalningsdag i perioden. */
  readonly refunds: Refund[];
  /** Fasta kostnader som inte är arkiverade (periodiseras av @/analytics/cashflow). */
  readonly fixedCosts: FixedCost[];
  /** Gratis-pack (koder i Awish) med inköpspris, skapade i perioden. */
  readonly freePacks: FreePackCost[];
}

/** Gratis-pack som kostnad: skapade koder med inköpspris, på skapelsedagen. */
export async function queryPeriodFreePacks(
  tx: Tx,
  orgId: string,
  period: Period,
): Promise<FreePackCost[]> {
  const rows = await tx
    .select({
      id: s.freePackBatches.id,
      machineId: s.freePackBatches.machineId,
      titleId: s.freePackBatches.titleId,
      day: s.freePackBatches.businessDate,
      costOre: s.freePackBatches.costOre,
      packs: s.freePackBatches.quantity,
    })
    .from(s.freePackBatches)
    .where(
      and(
        eq(s.freePackBatches.organizationId, orgId),
        eq(s.freePackBatches.status, "created"),
        gte(s.freePackBatches.businessDate, period.start),
        lte(s.freePackBatches.businessDate, period.end),
        sql`${s.freePackBatches.costOre} is not null`,
      ),
    )
    .orderBy(asc(s.freePackBatches.businessDate), asc(s.freePackBatches.id));
  return rows.map((r) => ({
    id: r.id,
    machineId: r.machineId,
    titleId: r.titleId,
    day: r.day as IsoDate,
    costOre: r.costOre ?? 0,
    packs: r.packs,
  }));
}

export async function queryPeriodRefunds(tx: Tx, orgId: string, period: Period): Promise<Refund[]> {
  const rows = await tx
    .select({
      id: s.incidents.id,
      machineId: s.incidents.machineId,
      titleId: s.incidents.titleId,
      refundedOn: s.incidents.refundedOn,
      amountOre: s.incidents.refundedOre,
    })
    .from(s.incidents)
    .where(
      and(
        eq(s.incidents.organizationId, orgId),
        gte(s.incidents.refundedOn, period.start),
        lte(s.incidents.refundedOn, period.end),
        sql`${s.incidents.refundedOre} > 0`,
      ),
    )
    .orderBy(asc(s.incidents.refundedOn), asc(s.incidents.id));
  return rows.flatMap((r) =>
    r.refundedOn === null
      ? []
      : [
          {
            id: r.id,
            machineId: r.machineId,
            titleId: r.titleId,
            refundedOn: r.refundedOn as IsoDate,
            amountOre: r.amountOre,
          },
        ],
  );
}

export async function queryActiveFixedCosts(tx: Tx, orgId: string): Promise<FixedCost[]> {
  const rows = await tx
    .select()
    .from(s.fixedCosts)
    .where(and(eq(s.fixedCosts.organizationId, orgId), isNull(s.fixedCosts.archivedAt)))
    .orderBy(asc(s.fixedCosts.name), asc(s.fixedCosts.id));
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    amountOre: r.amountOre,
    interval: r.interval,
    start: r.startsOn,
    end: r.endsOn,
    machineId: r.machineId,
  }));
}

/** Återbetalningar och fasta kostnader för perioden. Ägare, admin och läsare. */
export async function loadProfitAdjustmentsFor(
  viewer: Viewer,
  period: Period,
): Promise<ProfitAdjustments> {
  const orgId = viewer.organization.id;
  await requireViewerRole(viewer, ECONOMY_ROLES);
  return withUserDbFor(viewer.user, async (tx) => {
    const [refunds, fixedCosts, freePacks] = await Promise.all([
      queryPeriodRefunds(tx, orgId, period),
      queryActiveFixedCosts(tx, orgId),
      queryPeriodFreePacks(tx, orgId, period),
    ]);
    return { refunds, fixedCosts, freePacks };
  });
}

const cached = cache(async (start: IsoDate, end: IsoDate): Promise<ProfitAdjustments> =>
  loadProfitAdjustmentsFor(await requireViewer(), { start, end }),
);

/** För serverkomponenter: som loadProfitAdjustmentsFor, som den inloggade, memoiserad. */
export function loadProfitAdjustments(period: Period): Promise<ProfitAdjustments> {
  return cached(period.start, period.end);
}
