/**
 * Förlorad försäljning som nyckeltal för andra sidor: Hem ("Slutsålt kostade ca 3 200 kr
 * i oktober") och prioriteringen i Att göra (vilken påfyllning som kostar mest).
 *
 *   import { lostSalesSummary } from "@/server/purchasing";
 *   const lost = await lostSalesSummary(p.period);          // i en serverkomponent
 *   lost.text;                                               // rubrik/nyckeltal
 *   lost.series.find((s) => s.key === todo.key);             // 'refill:<automat>:<titel>'
 *
 * Siffrorna kommer från @/analytics/lost-sales; här väljs bara indata och perioden.
 * Bara ägare, admin och läsare (ekonomi). För påfyllare returnerar `lostSalesSummary` null.
 */

import "server-only";

import { cache } from "react";

import { lostSales } from "@/analytics/lost-sales";
import { addDays, type IsoDate, type Period } from "@/domain";
import { getRoleFor, requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";
import { canSeeEconomy, ECONOMY_ROLES } from "@/server/data/core/types";

import { lostPeriodOf } from "./load";
import { queryMachineStockEvents } from "./queries";
import { currentViewer } from "./session";
import type { LostSalesSummary } from "./types";

const LOOKBACK_DAYS = 60;

/** Adressen till underlaget: sektionen Förlorad försäljning med samma period. */
export function lostSalesHref(period: Period): string {
  const q = new URLSearchParams({ from: period.start, to: period.end });
  return `/prognos?${q.toString()}#forlorad-forsaljning`;
}

/**
 * Förlorad försäljning för perioden (högst t.o.m. i går: i dag är inte slut). Kastar
 * AuthorizationError("forbidden") för påfyllare.
 */
export async function lostSalesSummaryFor(
  viewer: Viewer,
  period: Period,
  now: Date = new Date(),
): Promise<LostSalesSummary> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const asOf: IsoDate = addDays(businessToday(now, viewer.organization.timezone), -1);
  const lostPeriod = lostPeriodOf(period, asOf);
  const from = addDays(lostPeriod.start, -LOOKBACK_DAYS);

  const input = await loadDomainInputFor(
    viewer,
    { period: { start: from, end: lostPeriod.end } },
    now,
  );
  const events = await withUserDbFor(viewer.user, (tx) =>
    queryMachineStockEvents(tx, orgId, from, lostPeriod.end),
  );
  const result = lostSales({
    orders: input.current.orders,
    stockEvents: events,
    period: lostPeriod,
    settings: input.settings,
    prices: input.sources.prices,
    titles: input.titles,
    machines: input.machines,
  });

  // Per titel × automat (summan av dess perioder), största först.
  const bySeries = new Map<
    string,
    {
      key: string;
      machineId: string;
      titleId: string;
      lostRevenueOre: number;
      lostUnitsMilli: number;
      ongoing: boolean;
      since: IsoDate;
    }
  >();
  for (const p of result.periods) {
    const key = `refill:${p.machineId}:${p.titleId}`;
    const cur = bySeries.get(key);
    if (cur) {
      cur.lostRevenueOre += p.lostRevenueOre;
      cur.lostUnitsMilli += p.lostUnitsMilli;
      cur.ongoing = cur.ongoing || p.ongoing;
      if (p.start > cur.since) cur.since = p.start;
    } else {
      bySeries.set(key, {
        key,
        machineId: p.machineId,
        titleId: p.titleId,
        lostRevenueOre: p.lostRevenueOre,
        lostUnitsMilli: p.lostUnitsMilli,
        ongoing: p.ongoing,
        since: p.start,
      });
    }
  }
  const series = [...bySeries.values()].sort(
    (a, b) => b.lostRevenueOre - a.lostRevenueOre || (a.key < b.key ? -1 : 1),
  );

  // En hel månad: månadens text ("… i oktober"). Annars periodens.
  const only = result.months.length === 1 ? result.months[0] : undefined;
  const text = only && !only.partial ? only.text : result.total.text;

  return {
    period: lostPeriod,
    lostRevenueOre: result.total.lostRevenueOre,
    lostGrossProfitOre: result.total.lostGrossProfitOre,
    lostUnitsMilli: result.total.lostUnitsMilli,
    stockoutDayWeightBp: result.total.stockoutDayWeightBp,
    text,
    months: result.months.map((m) => ({
      month: m.month,
      lostRevenueOre: m.lostRevenueOre,
      partial: m.partial,
      text: m.text,
    })),
    series,
    href: lostSalesHref(lostPeriod),
  };
}

const lostSalesSummaryCached = cache(
  async (start: IsoDate, end: IsoDate): Promise<LostSalesSummary | null> => {
    const viewer = await currentViewer();
    const role = await getRoleFor(viewer.user, viewer.organization.id);
    if (role === null || !canSeeEconomy(role)) return null;
    return lostSalesSummaryFor(viewer, { start, end });
  },
);

/**
 * För serverkomponenter (Hem, Att göra): förlorad försäljning för perioden som den
 * inloggade användaren, memoiserad per förfrågan. null för påfyllare (ingen ekonomi).
 */
export function lostSalesSummary(period: Period): Promise<LostSalesSummary | null> {
  return lostSalesSummaryCached(period.start, period.end);
}
