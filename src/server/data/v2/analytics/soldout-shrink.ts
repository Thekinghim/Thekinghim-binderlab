/**
 * Slutsålt och svinn på Hem (V2): förlorad försäljning för vald period (Prognos & inköp,
 * lostSalesSummaryFor via Hems modell, samma tal som gamla Hem) och svinnkontrollen för de
 * senaste 14 dagarna (samma som raden på gamla Hem och /automater/svinn). Bara ekonomiroller.
 */

import "server-only";

import { buildShrinkage } from "@/analytics/shrinkage";
import { addDays, type Period } from "@/domain";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { loadContext, loadMasterData, loadPeriod, requireViewer } from "@/server/data/core";
import { loadShrinkageFor } from "@/server/data/shrinkage";

import { hemKey, loadHemLostSales } from "./hem-base";

/** Dagar bakåt (t.o.m. i dag) för svinnet, samma som gamla Hem. */
export const SHRINK_DAYS = 14;

export interface SoldoutShrinkCard {
  readonly lost: {
    readonly revenueOre: number;
    readonly perDayOre: number;
    readonly ongoing: number;
    readonly text: string;
    readonly href: string;
  } | null;
  readonly days: number;
  readonly shrink: {
    readonly period: Period;
    readonly missing: number;
    readonly valueOre: number | null;
    readonly machines: readonly {
      readonly machineId: string;
      readonly code: string;
      readonly name: string;
      readonly storeName: string | null;
      readonly missing: number;
      readonly valueOre: number | null;
    }[];
    readonly href: string;
  } | null;
}

export async function loadSoldoutShrink(sp: SearchParamsInput): Promise<SoldoutShrinkCard | null> {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  const [lost, p] = await Promise.all([loadHemLostSales(hemKey(sp)), loadPeriod(sp)]);
  const period = { start: addDays(ctx.today, -(SHRINK_DAYS - 1)), end: ctx.today };
  let shrink: SoldoutShrinkCard["shrink"] = null;
  try {
    const [viewer, master] = await Promise.all([requireViewer(), loadMasterData()]);
    const report = buildShrinkage(await loadShrinkageFor(viewer, period), master);
    shrink = {
      period,
      missing: report.missing,
      valueOre: report.valueOre,
      machines: report.flagged.map((m) => ({
        machineId: m.machineId,
        code: m.code,
        name: m.name,
        storeName: m.storeName,
        missing: m.missing,
        valueOre: m.valueOre,
      })),
      href: `/automater/svinn?period=eget&from=${period.start}&to=${period.end}`,
    };
  } catch (error) {
    console.error("[hem] Svinnkontrollen kunde inte läsas:", error);
  }
  const days = Math.max(1, p.days);
  return {
    lost: lost
      ? {
          revenueOre: lost.lostRevenueOre,
          perDayOre: Math.round(lost.lostRevenueOre / days),
          ongoing: lost.ongoing,
          text: lost.text,
          href: lost.href,
        }
      : null,
    days,
    shrink,
  };
}
