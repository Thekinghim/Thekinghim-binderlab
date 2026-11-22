/**
 * "När säljer vi mest" på Hem (V2): köp per veckodag och tvåtimmarsblock för vald period, ur
 * samma order som resten av Hem (loadDomainInput, filtret följer med). Bara ekonomiroller
 * (påfyllaren läser inte order). Uträkningen: @/analytics/home-v2 whenGrid.
 */

import "server-only";

import { whenGrid, type WhenGrid } from "@/analytics/home-v2";
import { addDays } from "@/domain";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { loadContext, loadDomainInput, loadPeriod } from "@/server/data/core";

/** Dagar som mönstret läses över när perioden är kortare än en vecka. */
export const PATTERN_DAYS = 30;

export interface WhenCard {
  readonly grid: WhenGrid;
  readonly days: number;
  /** Perioden var för kort: mönstret gäller de senaste 30 dagarna. */
  readonly pattern: boolean;
}

export async function loadWhen(sp: SearchParamsInput): Promise<WhenCard | null> {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  const p = await loadPeriod(sp);
  // I dag ger för få köp för ett mönster: då läses de senaste 30 dagarna (som prototypen).
  const pattern = p.days < 7;
  const period = pattern
    ? { start: addDays(ctx.today, -(PATTERN_DAYS - 1)), end: ctx.today }
    : p.period;
  const input = await loadDomainInput(
    pattern ? { period, compare: null, ...p.scope } : { period, compare: p.compare, ...p.scope },
  );
  const days = pattern ? PATTERN_DAYS : Math.max(p.days, 1);
  return { grid: whenGrid(input.current.orders, ctx.timeZone, days), days, pattern };
}
