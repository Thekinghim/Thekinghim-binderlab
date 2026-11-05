/**
 * "Vad Binderlab gett dig" (/varde) och månadsrapporten: allt läses som den inloggade
 * användaren med RLS, och siffrorna räknas i @/analytics/value (regler i
 * docs/berakningar.md, avsnitt 27). Bara ägare och admin.
 *
 *   const data = await loadValueFor(viewer, "2026-10");
 */

import "server-only";

import { sql } from "drizzle-orm";

import { assortmentRecommendations } from "@/server/market/model";
import { loadMarketDataFor } from "@/server/market/service";
import { lostSales } from "@/analytics/lost-sales";
import {
  bestActions,
  keptOf,
  marginAndTrend,
  minutesByMonth,
  refillValue,
  timeSaved,
  TREND_MONTHS,
  type AutomationCount,
  type AutomationKind,
  type BestAction,
  type MarginResult,
  type RefillValueResult,
  type TimeSavedResult,
} from "@/analytics/value";
import type { Tx } from "@/db/client";
import {
  addDays,
  addMonths,
  monthEnd,
  monthOf,
  monthStart,
  profitabilityViews,
  type IsoDate,
  type IsoMonth,
} from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import {
  businessToday,
  loadDataStartFor,
  loadDomainInputFor,
  type Viewer,
} from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { queryMachineStockEvents } from "@/server/purchasing/queries";
import { availableMonths, pickMonth } from "@/analytics/value/months";
import { monthName } from "@/analytics/todos/text";

/** Dagar före första månaden som läses (takten för förlorad försäljning och saldot). */
const LOOKBACK_DAYS = 60;
const KINDS: ReadonlySet<string> = new Set<AutomationKind>([
  "refill_visit",
  "awish_push",
  "settlement",
  "bookkeeping",
  "alert",
  "report",
]);

export interface ValueMonthTrend {
  readonly month: IsoMonth;
  readonly partial: boolean;
  readonly revenueOre: number;
  readonly keptOre: number;
  readonly savedRevenueOre: number;
  readonly lostRevenueOre: number;
  readonly minutesSaved: number;
}

export interface ValueNames {
  readonly titles: ReadonlyArray<{ id: string; name: string }>;
  readonly machines: ReadonlyArray<{ id: string; code: string; name: string }>;
  readonly stores: ReadonlyArray<{ id: string; name: string }>;
}

export interface ValueData {
  readonly organizationName: string;
  readonly timeZone: string;
  readonly today: IsoDate;
  /** Vald månad. */
  readonly month: IsoMonth;
  /** Perioden som räknas: månaden, till och med i går om den pågår. `null` = inga hela dagar än. */
  readonly period: { start: IsoDate; end: IsoDate } | null;
  readonly partial: boolean;
  /** Månader att välja bland, nyast först. */
  readonly months: readonly IsoMonth[];
  readonly hasData: boolean;
  readonly refill: RefillValueResult | null;
  /** Förlorad intäkt när facken var tomma, i månaden. */
  readonly lost: {
    readonly lostRevenueOre: number;
    readonly heuristicLostRevenueOre: number;
    readonly stockoutDays: number;
  };
  readonly time: TimeSavedResult;
  readonly hourlyCostOre: number | null;
  readonly margin: MarginResult | null;
  readonly trend: readonly ValueMonthTrend[];
  readonly actions: readonly BestAction[];
  readonly names: ValueNames;
}

function lastDayOf(month: IsoMonth, asOf: IsoDate): IsoDate | null {
  if (monthStart(month) > asOf) return null;
  const end = monthEnd(month);
  return end > asOf ? asOf : end;
}

async function automationCounts(
  tx: Tx,
  orgId: string,
  from: IsoDate,
  to: IsoDate,
): Promise<AutomationCount[]> {
  const result = await tx.execute(
    sql`select to_char(month, 'YYYY-MM') as month, kind, n
        from public.varde_automation_counts(${orgId}::uuid, ${from}::date, ${to}::date)`,
  );
  const list = result as unknown as Array<{ month: string; kind: string; n: number | string }>;
  return list
    .filter((r) => KINDS.has(r.kind))
    .map((r) => ({ month: r.month, kind: r.kind as AutomationKind, count: Number(r.n) }));
}

async function hourlyCost(tx: Tx, orgId: string): Promise<number | null> {
  const result = await tx.execute(
    sql`select hourly_cost_ore from public.effect_settings where organization_id = ${orgId}::uuid`,
  );
  const row = (result as unknown as Array<{ hourly_cost_ore: number | string | null }>)[0];
  return row?.hourly_cost_ore == null ? null : Number(row.hourly_cost_ore);
}

/** Sortimentsrådet just nu (bara "ändra"). Fel i sortimentet stoppar inte sidan. */
async function assortmentNow(viewer: Viewer, asOf: IsoDate, now: Date) {
  try {
    const data = await loadMarketDataFor(viewer, now);
    return assortmentRecommendations(data, { start: addDays(asOf, -27), end: asOf })
      .filter((r) => r.action === "change")
      .map((r) => ({ machineId: r.machineId, effectPerWeekOre: r.effectPerWeekOre, text: r.text }));
  } catch {
    return [];
  }
}

/**
 * Allt sidan och månadsrapporten visar för månaden `monthParam` (?manad=ÅÅÅÅ-MM; annars
 * förra månaden). Kastar AuthorizationError("forbidden") för andra roller än ägare och admin.
 */
export async function loadValueFor(
  viewer: Viewer,
  monthParam: string | null | undefined,
  now: Date = new Date(),
): Promise<ValueData> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);
  const asOf = addDays(today, -1);
  const dataStart = await loadDataStartFor(viewer);
  const months = availableMonths(dataStart, today);
  const month = pickMonth(monthParam, months, today);
  const firstMonth = months[months.length - 1] ?? month;

  const trendMonths: IsoMonth[] = [];
  for (let i = TREND_MONTHS - 1; i >= 0; i--) {
    const m = addMonths(month, -i);
    if (m >= firstMonth) trendMonths.push(m);
  }
  const lastDay = lastDayOf(month, asOf);
  const names = (input: {
    titles: ReadonlyArray<{ id: string; name: string }>;
    machines: ReadonlyArray<{ id: string; code: string; name: string }>;
    stores: ReadonlyArray<{ id: string; name: string }>;
  }): ValueNames => ({
    titles: input.titles.map((t) => ({ id: t.id, name: t.name })),
    machines: input.machines.map((m) => ({ id: m.id, code: m.code, name: m.name })),
    stores: input.stores.map((s) => ({ id: s.id, name: s.name })),
  });

  const rangeStart = monthStart(trendMonths[0]!);
  const countsTo = lastDay ?? monthEnd(month);
  const [counts, hourlyCostOre] = await withUserDbFor(
    viewer.user,
    async (tx) =>
      [
        await automationCounts(tx, orgId, rangeStart, countsTo),
        await hourlyCost(tx, orgId),
      ] as const,
  );
  const time = timeSaved(counts, { months: [month], hourlyCostOre });

  const base = {
    organizationName: viewer.organization.name,
    timeZone,
    today,
    month,
    partial: lastDay === null || lastDay < monthEnd(month),
    months,
    time,
    hourlyCostOre,
  };

  if (lastDay === null || dataStart === null) {
    return {
      ...base,
      period: null,
      hasData: false,
      refill: null,
      lost: { lostRevenueOre: 0, heuristicLostRevenueOre: 0, stockoutDays: 0 },
      margin: null,
      trend: [],
      actions: [],
      names: { titles: [], machines: [], stores: [] },
    };
  }

  const loadFrom = addDays(rangeStart, -LOOKBACK_DAYS);
  const [input, events, assortment] = await Promise.all([
    loadDomainInputFor(viewer, { period: { start: loadFrom, end: lastDay } }, now),
    withUserDbFor(viewer.user, (tx) => queryMachineStockEvents(tx, orgId, loadFrom, lastDay)),
    assortmentNow(viewer, asOf, now),
  ]);
  const range = { start: rangeStart, end: lastDay };
  const period = { start: monthStart(month), end: lastDay };

  const margin = marginAndTrend(input.current, trendMonths, lastDay);
  const refillAll = refillValue({
    stockEvents: events,
    orders: input.current.orders,
    period: range,
    settings: input.settings,
    prices: input.sources.prices,
  });
  const refill = refillValue({
    stockEvents: events,
    orders: input.current.orders,
    period,
    settings: input.settings,
    prices: input.sources.prices,
  });
  const lost = lostSales({
    orders: input.current.orders,
    stockEvents: events,
    period: range,
    settings: input.settings,
    prices: input.sources.prices,
    titles: input.titles,
    machines: input.machines,
  });
  const lostMonth = lost.months.find((m) => m.month === month);
  const minutes = new Map(minutesByMonth(counts, trendMonths).map((m) => [m.month, m.minutes]));

  const trend: ValueMonthTrend[] = margin.months.map((m) => ({
    month: m.month,
    partial: m.partial,
    revenueOre: m.revenueOre,
    keptOre: m.keptOre,
    savedRevenueOre: refillAll.byMonth.find((r) => r.month === m.month)?.savedRevenueOre ?? 0,
    lostRevenueOre: lost.months.find((r) => r.month === m.month)?.lostRevenueOre ?? 0,
    minutesSaved: minutes.get(m.month) ?? 0,
  }));

  // Bästa åtgärder: förlorad försäljning per automat och titel i månaden, titlar med
  // förlust och utan inköpspris i månaden, och sortimentsrådet just nu.
  const lostBySeries = new Map<
    string,
    { machineId: string; titleId: string; lostRevenueOre: number }
  >();
  for (const p of lost.periods) {
    const inMonth = p.byMonth.find((b) => b.month === month)?.lostRevenueOre ?? 0;
    if (inMonth <= 0) continue;
    const key = `${p.machineId}:${p.titleId}`;
    const cur = lostBySeries.get(key);
    if (cur) cur.lostRevenueOre += inMonth;
    else
      lostBySeries.set(key, {
        machineId: p.machineId,
        titleId: p.titleId,
        lostRevenueOre: inMonth,
      });
  }
  const titleView = profitabilityViews({ ...input.current, period }, ["title"]).title;
  const titleName = new Map(input.titles.map((t) => [t.id, t.name]));
  const machineById = new Map(input.machines.map((m) => [m.id, m]));
  const machineName = (id: string) => {
    const m = machineById.get(id);
    return m ? m.code || m.name : "automaten";
  };
  const machineHref = (id: string) => {
    const m = machineById.get(id);
    return m?.code ? `/automater/${encodeURIComponent(m.code.toLowerCase())}` : "/automater";
  };
  const actions = bestActions({
    lost: [...lostBySeries.values()],
    titles: titleView.rows
      .filter((r) => r.kind === "item")
      .map((r) => ({ titleId: r.key, pricedOrders: r.pricedOrders, keptOre: keptOf(r) })),
    unpriced: titleView.unpriced.byTitle.map((u) => ({
      titleId: u.titleId,
      orders: u.orders,
      revenueOre: u.revenueOre,
    })),
    assortment,
    titleName: (id) => titleName.get(id) ?? "titeln",
    machineName,
    monthLabel: monthName(month),
    hrefs: {
      lost: (machineId) => machineHref(machineId),
      price: (titleId) => `/inkopspriser?titel=${encodeURIComponent(titleId)}`,
      assortment: () => "/marknad#sortiment",
    },
  });

  return {
    ...base,
    period,
    hasData: true,
    refill,
    lost: {
      lostRevenueOre: lostMonth?.lostRevenueOre ?? 0,
      heuristicLostRevenueOre: lostMonth?.heuristicLostRevenueOre ?? 0,
      stockoutDays: Math.round((lostMonth?.stockoutDayWeightBp ?? 0) / 10_000),
    },
    margin,
    trend,
    actions,
    names: names(input),
  };
}

/**
 * Hem: sparad tid den här månaden hittills (bara antal × minuter, inga tunga beräkningar).
 * `null` för andra roller än ägare och admin.
 */
export async function loadValueTeaserFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<{ month: IsoMonth; minutes: number; tasks: number } | null> {
  const orgId = viewer.organization.id;
  if (!(OPERATOR_ROLES as readonly string[]).includes(viewer.organization.role)) return null;
  const today = businessToday(now, viewer.organization.timezone);
  const month = monthOf(today);
  const counts = await withUserDbFor(viewer.user, (tx) =>
    automationCounts(tx, orgId, monthStart(month), today),
  );
  const t = timeSaved(counts, { months: [month] });
  return { month, minutes: t.minutes, tasks: t.tasks };
}
