/**
 * Förlorad försäljning som nyckeltal för andra sidor: Hem ("Slutsålt kostade ca 3 200 kr
 * i oktober") och prioriteringen i Att göra (vilken påfyllning som kostar mest).
 *
 *   import { lostSalesSummary } from "@/server/purchasing";
 *   const lost = await lostSalesSummary(p.period, p.scope); // i en serverkomponent
 *   lost.text;                                               // rubrik/nyckeltal
 *   lost.series.find((s) => s.key === todo.key);             // 'refill:<automat>:<titel>'
 *
 * Siffrorna kommer från @/analytics/lost-sales; här väljs bara indata och perioden.
 * Bara ägare, admin och läsare (ekonomi). För påfyllare, butiksanvändare och den som saknar
 * organisation returnerar `lostSalesSummary` null. Med butik/automat (`scope`) räknas bara
 * den butikens eller automatens order och lager, som på sidan.
 */

import "server-only";

import { cache } from "react";

import { lostSales } from "@/analytics/lost-sales";
import { addDays, type IsoDate, type Period } from "@/domain";
import { getRoleFor, requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";
import { canSeeEconomy, ECONOMY_ROLES, type DataScope } from "@/server/data/core/types";
import { getActiveOrganization } from "@/server/session";

import { lostPeriodOf, machinesInScope } from "./load";
import { queryMachineStockEvents } from "./queries";
import { currentViewer } from "./session";
import type { LostSalesSummary } from "./types";

const LOOKBACK_DAYS = 60;

const NO_SCOPE: DataScope = { storeId: null, machineId: null };

/** Adressen till underlaget: sektionen Förlorad försäljning med samma period och filter. */
export function lostSalesHref(period: Period, scope: DataScope = NO_SCOPE): string {
  const q = new URLSearchParams({ from: period.start, to: period.end });
  if (scope.storeId) q.set("butik", scope.storeId);
  if (scope.machineId) q.set("automat", scope.machineId);
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
  scope: DataScope = NO_SCOPE,
): Promise<LostSalesSummary> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const asOf: IsoDate = addDays(businessToday(now, viewer.organization.timezone), -1);
  const lostPeriod = lostPeriodOf(period, asOf);
  const from = addDays(lostPeriod.start, -LOOKBACK_DAYS);

  const range = { start: from, end: lostPeriod.end };
  const scoped = Boolean(scope.storeId || scope.machineId);
  const input = await loadDomainInputFor(viewer, { period: range }, now);
  const inScope = scoped
    ? await loadDomainInputFor(viewer, { period: range, ...scope }, now)
    : input;
  const allEvents = await withUserDbFor(viewer.user, (tx) =>
    queryMachineStockEvents(tx, orgId, from, lostPeriod.end),
  );
  const machines = machinesInScope(input, scope);
  const events = machines
    ? allEvents.filter((e) => e.machineId !== null && machines.has(e.machineId))
    : allEvents;
  const result = lostSales({
    orders: inScope.current.orders,
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
    scope,
    href: lostSalesHref(lostPeriod, scope),
  };
}

const lostSalesSummaryCached = cache(
  async (
    start: IsoDate,
    end: IsoDate,
    storeId: string | null,
    machineId: string | null,
  ): Promise<LostSalesSummary | null> => {
    // Butiksanvändare och den utan organisation har ingen ekonomi att visa.
    if (!(await getActiveOrganization())) return null;
    const viewer = await currentViewer();
    const role = await getRoleFor(viewer.user, viewer.organization.id);
    if (role === null || !canSeeEconomy(role)) return null;
    return lostSalesSummaryFor(viewer, { start, end }, new Date(), { storeId, machineId });
  },
);

/**
 * För serverkomponenter (Hem, Att göra): förlorad försäljning för perioden (och butiken
 * eller automaten i filtret, om det finns) som den inloggade användaren, memoiserad per
 * förfrågan. null för påfyllare, butiksanvändare och den utan organisation (ingen ekonomi).
 */
export function lostSalesSummary(
  period: Period,
  scope?: Partial<DataScope> | null,
): Promise<LostSalesSummary | null> {
  return lostSalesSummaryCached(
    period.start,
    period.end,
    scope?.storeId ?? null,
    scope?.machineId ?? null,
  );
}
