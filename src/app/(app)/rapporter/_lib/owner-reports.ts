/**
 * Butiksrapporter för en butiksägare i ett svep: en vanlig butiksrapport (utkast) per
 * butik som ägaren har, med samma månad eller eget datum och samma hälsning. Rapporten i
 * sig ändras inte; det här sparar bara ägaren från att skapa dem en och en. En butik som
 * inte kan få en rapport (t.ex. ingen automat under perioden) hoppas över och nämns.
 * Testas i test/db/agarrapporter.test.ts.
 */

import "server-only";

import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import * as s from "@/db/schema";
import type { IsoMonth } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { createReportFor, ReportError, type ReportRequest } from "@/server/reports/service";

export interface OwnerReportsInput {
  readonly ownerId: string;
  readonly month: IsoMonth;
  readonly period: { start: string; end: string } | null;
  readonly greeting: string | null;
  /**
   * Butikerna som visades (de som hade automat i perioden). Bara ägarens butiker bland dem
   * får en rapport; utelämnad = alla ägarens aktiva butiker.
   */
  readonly storeIds?: readonly string[];
}

export interface OwnerReportsResult {
  /** Utkasten som skapades: butiken och rapportens id. */
  readonly created: ReadonlyArray<{ storeId: string; storeName: string; reportId: string }>;
  /** Butikerna som inte fick någon rapport, och varför. */
  readonly skipped: ReadonlyArray<{ storeId: string; storeName: string; reason: string }>;
}

type CreateReport = (viewer: Viewer, req: ReportRequest) => Promise<string>;

/** Ägarens aktiva butiker (under RLS), i namnordning. */
async function ownerStores(
  viewer: Viewer,
  ownerId: string,
): Promise<Array<{ id: string; name: string }>> {
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, (tx) =>
    tx
      .select({ id: s.stores.id, name: s.stores.name })
      .from(s.stores)
      .where(
        and(
          eq(s.stores.organizationId, orgId),
          inArray(
            s.stores.id,
            sql`(select tm.store_id from public.store_terms(${orgId}::uuid) tm
                  where tm.owner_id = ${ownerId}::uuid)`,
          ),
          isNull(s.stores.archivedAt),
        ),
      )
      .orderBy(asc(s.stores.name), asc(s.stores.id)),
  );
}

/**
 * En butiksrapport per butik som ägaren har. Bara ägare och admin. Butikerna skapas en i
 * taget (samma tjänst som "Skapa utkast"), så att ett fel i en butik inte stoppar de andra.
 */
export async function createOwnerReportsFor(
  viewer: Viewer,
  input: OwnerReportsInput,
  create: CreateReport = createReportFor,
): Promise<OwnerReportsResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  const wanted = input.storeIds ? new Set(input.storeIds) : null;
  const stores = (await ownerStores(viewer, input.ownerId)).filter(
    (st) => wanted === null || wanted.has(st.id),
  );
  if (stores.length === 0) throw new ReportError("Butiksägaren har inga butiker.");
  const created: Array<{ storeId: string; storeName: string; reportId: string }> = [];
  const skipped: Array<{ storeId: string; storeName: string; reason: string }> = [];
  for (const store of stores) {
    try {
      const reportId = await create(viewer, {
        type: "butik",
        month: input.month,
        period: input.period,
        storeId: store.id,
        greeting: input.greeting,
      });
      created.push({ storeId: store.id, storeName: store.name, reportId });
    } catch (error) {
      if (!(error instanceof ReportError)) throw error;
      skipped.push({ storeId: store.id, storeName: store.name, reason: error.message });
    }
  }
  return { created, skipped };
}

/** Kvittot: "3 butiksrapporter skapade." och vilka som hoppades över. */
export function ownerReportsSummary(result: OwnerReportsResult): {
  title: string;
  description: string | undefined;
} {
  const n = result.created.length;
  const title =
    n === 0
      ? "Inga rapporter skapades"
      : n === 1
        ? "1 butiksrapport skapad"
        : `${n} butiksrapporter skapade`;
  const description =
    result.skipped.length > 0
      ? result.skipped.map((s) => `${s.storeName}: ${s.reason}`).join(" ")
      : n > 0
        ? "Granska och godkänn var och en."
        : undefined;
  return { title, description };
}
