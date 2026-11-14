/**
 * Laddare för portalens sidor: hämtar via portal_*-funktionerna (som
 * butiksanvändaren, med RLS) och räknar med modellen (@/reports).
 */

import "server-only";

import { monthOf, type IsoMonth } from "@/domain";

import { withUserDbFor } from "../access";
import { pgErrorOf } from "../errors";

import {
  buildPortalOverview,
  firstPortalMonth,
  machinesInStoreToday,
  monthsBetween,
  portalSources,
  resolvePortalMonth,
  salesWindow,
  todayIn,
  type PortalOverview,
} from "./model";
import {
  queryPortalAgreements,
  queryPortalFaults,
  queryPortalFirstSale,
  queryPortalMachines,
  queryPortalReport,
  queryPortalReportDetails,
  queryPortalReports,
  queryPortalSales,
  type PortalFault,
  type PortalReportDetail,
  type PortalReportListItem,
} from "./queries";
import type { PortalContext } from "./session";

export interface PortalOverviewData {
  overview: PortalOverview;
  /** Valbara månader, senaste först. */
  months: IsoMonth[];
  machinesToday: { machineId: string; code: string; name: string }[];
  hasAgreement: boolean;
  /** Butikens val "Visa detaljer i rapporten": falskt = inga titlar och inget snittköp. */
  details: boolean;
}

export async function loadPortalOverview(
  ctx: PortalContext,
  requestedMonth: string | undefined,
  now: Date = new Date(),
): Promise<PortalOverviewData> {
  const { store } = ctx;
  const today = todayIn(store.timezone, now);
  return withUserDbFor(ctx.user, async (tx) => {
    const machines = await queryPortalMachines(tx, store.storeId);
    const agreements = await queryPortalAgreements(tx, store.storeId);
    const firstSale = await queryPortalFirstSale(tx, store.storeId, today);
    const first = firstPortalMonth(machines, firstSale, today);
    const current = monthOf(today);
    const month = resolvePortalMonth(requestedMonth, first, current);
    const details = await queryPortalReportDetails(tx, store.storeId);
    const sales = await queryPortalSales(tx, store.storeId, salesWindow(month, first));
    const sources = portalSources(store, sales, agreements, machines);
    return {
      details,
      overview: buildPortalOverview(sources, store.storeId, month, first, today, { details }),
      months: monthsBetween(first, current),
      machinesToday: machinesInStoreToday(machines, today),
      hasAgreement: agreements.length > 0,
    };
  });
}

export async function loadPortalReports(ctx: PortalContext): Promise<PortalReportListItem[]> {
  return withUserDbFor(ctx.user, (tx) => queryPortalReports(tx, ctx.store.storeId));
}

/** En rapport, eller null om den inte finns hos butiken (samma svar för andras). */
export async function loadPortalReport(
  ctx: PortalContext,
  reportId: string,
): Promise<PortalReportDetail | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(reportId))
    return null;
  try {
    return await withUserDbFor(ctx.user, (tx) =>
      queryPortalReport(tx, ctx.store.storeId, reportId),
    );
  } catch (error) {
    if (pgErrorOf(error)?.code === "P0002") return null;
    throw error;
  }
}

export interface PortalFaultData {
  faults: PortalFault[];
  machinesToday: { machineId: string; code: string; name: string }[];
  machineNames: Record<string, string>;
}

export async function loadPortalFaults(
  ctx: PortalContext,
  now: Date = new Date(),
): Promise<PortalFaultData> {
  const today = todayIn(ctx.store.timezone, now);
  return withUserDbFor(ctx.user, async (tx) => {
    const machines = await queryPortalMachines(tx, ctx.store.storeId);
    const faults = await queryPortalFaults(tx, ctx.store.storeId);
    const machineNames: Record<string, string> = {};
    for (const m of machines) machineNames[m.machineId] = `${m.code} ${m.name}`;
    return { faults, machinesToday: machinesInStoreToday(machines, today), machineNames };
  });
}
