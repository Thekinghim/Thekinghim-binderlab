/**
 * Laddarna för Automat-ranking (Automater, raden på Hem) och Bästa sortiment (automatens
 * sida). Allt går via sidladdarna (PageLoaders): rollen kontrolleras mot databasen och
 * allt läses under RLS som användaren. Bara ägare, admin och läsare (ekonomi).
 *
 * Antalet frågor är detsamma oavsett hur många automater som finns: order, lagerhändelser
 * och sortiment läses en gång för hela organisationen och delas upp i minnet.
 */

import "server-only";

import { compareUnitEconomics } from "@/analytics/expansion/unit-economics-compare";
import { lostSales, type LostSalesResult } from "@/analytics/lost-sales";
import {
  bestAssortment,
  type AssortmentSale,
  type BestAssortment,
} from "@/analytics/ranking/assortment";
import { fleetRanking, type FleetMachineInput, type FleetRanking } from "@/analytics/ranking/fleet";
import type { SearchParamsInput } from "@/components/shell/period-state";
import {
  addDays,
  buildLedger,
  entryProfitOre,
  minDate,
  storeShareDeducted,
  type IsoDate,
  type Period,
} from "@/domain";
import { AuthorizationError, withUserDbFor } from "@/server/access";
import { loadSlotPeriodsFor } from "@/server/data/assortment";
import type { AppContext, DomainInput } from "@/server/data/core/types";
import { requestPageLoaders, type PageLoaders } from "@/server/data/page-loaders";
import { queryMachineStockEvents } from "@/server/purchasing/queries";

import { completeDataPeriod } from "../../expansion/_lib/model";

/** Dagar före perioden som takten före en slutsåld dag räknas på (som Prognos). */
const LOST_LOOKBACK_DAYS = 60;

export interface RankedMachine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
}

export interface FleetRankingData {
  readonly ranking: FleetRanking;
  /** Hela dagar med data som talen räknas på. */
  readonly period: Period;
  readonly days: number;
  /** Perioden innan (lika lång), när den ligger inom datan. */
  readonly previous: Period | null;
  readonly machines: ReadonlyMap<string, RankedMachine>;
  /** Vinsten är efter butikernas andel (vyknappen eller vald butik). */
  readonly storeShareDeducted: boolean;
  /** Förlorad försäljning gick att räkna (annars visas den inte). */
  readonly lostKnown: boolean;
}

export interface BestAssortmentData {
  readonly assortment: BestAssortment;
  readonly storeShareDeducted: boolean;
}

function requireEconomy(ctx: AppContext): void {
  if (!ctx.canSeeEconomy) throw new AuthorizationError("forbidden");
}

/**
 * Slutsålda perioder och dagar för hela organisationen i perioden (högst t.o.m. i går).
 * null när det inte går att räkna: sidan visas då utan slutsålt.
 */
async function loadStockouts(
  loaders: PageLoaders,
  ctx: AppContext,
  period: Period,
): Promise<LostSalesResult | null> {
  try {
    const end = minDate(period.end, addDays(ctx.today, -1));
    const lostPeriod: Period = { start: minDate(period.start, end), end };
    const from = addDays(lostPeriod.start, -LOST_LOOKBACK_DAYS);
    const viewer = await loaders.viewer();
    const [input, events] = await Promise.all([
      loaders.domainInput({ period: { start: from, end } }),
      withUserDbFor(viewer.user, (tx) =>
        queryMachineStockEvents(tx, viewer.organization.id, from, end),
      ),
    ]);
    return lostSales({
      orders: input.current.orders,
      stockEvents: events,
      period: lostPeriod,
      settings: input.settings,
      prices: input.sources.prices,
      titles: input.titles,
      machines: input.machines,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    console.error("[automater] Slutsålt kunde inte räknas:", error);
    return null;
  }
}

function unitRows(
  part: DomainInput["current"],
  input: DomainInput,
  machineIds: readonly string[],
  lastDataDay: IsoDate,
): FleetMachineInput[] {
  return compareUnitEconomics(
    { ...part, investments: input.investments, machineIds: [...machineIds] },
    input.machines.map((m) => ({ id: m.id, name: m.name })),
    { lastDataDay },
  ).rows.map((r) => ({
    machineId: r.machineId,
    activeDays: r.activeDays,
    orders: r.orders,
    revenuePerDayOre: r.revenuePerDayOre,
    profitPerDayOre: r.profitPerDayOre,
  }));
}

/**
 * Rangordningen för perioden och filtret i adressen. Samma tal som Enhetsekonomi (hela
 * dagar med data, samma aktiva dagar). `withLost: false` hoppar över slutsålt (Hem).
 */
export async function loadFleetRankingWith(
  loaders: PageLoaders,
  searchParams: SearchParamsInput,
  options: { readonly withLost?: boolean } = {},
): Promise<FleetRankingData> {
  const ctx = await loaders.context();
  requireEconomy(ctx);
  const p = await loaders.period(searchParams);
  const dp = completeDataPeriod(p.period, p.dataStart, ctx.today);
  const before: Period = {
    start: addDays(dp.period.start, -dp.days),
    end: addDays(dp.period.start, -1),
  };
  // Perioden innan jämförs bara när den ligger helt inom datan.
  const previous = p.dataStart !== null && before.start >= p.dataStart ? before : null;
  const [input, lost] = await Promise.all([
    loaders.domainInput({ period: dp.period, compare: previous, ...p.scope }),
    options.withLost === false ? null : loadStockouts(loaders, ctx, dp.period),
  ]);

  const inScope = new Set<string>(input.current.placements.map((pl) => pl.machineId));
  if (p.scope.machineId) inScope.add(p.scope.machineId);
  if (!p.scope.storeId && !p.scope.machineId) {
    for (const m of input.machines) if (!m.archived) inScope.add(m.id);
  }
  const machines = new Map<string, RankedMachine>(
    input.machines
      .filter((m) => !m.archived && inScope.has(m.id))
      .map((m) => [m.id, { id: m.id, code: m.code, name: m.name }]),
  );
  const machineIds = [...machines.keys()].sort();

  const lostBy = new Map<string, { revenue: number; bp: number }>();
  for (const s of lost?.periods ?? []) {
    const cur = lostBy.get(s.machineId) ?? { revenue: 0, bp: 0 };
    cur.revenue += s.lostRevenueOre;
    cur.bp += s.lostDayWeightBp;
    lostBy.set(s.machineId, cur);
  }
  // Enhetsekonomin tar med varje automat som har order, även arkiverade. De visas inte i
  // rangordningen och ska därför inte heller räknas i medianen eller omdömena.
  const shown = (r: FleetMachineInput) => machines.has(r.machineId);
  const current = unitRows(input.current, input, machineIds, dp.period.end)
    .filter(shown)
    .map((r) => {
      const l = lostBy.get(r.machineId);
      return {
        ...r,
        lostRevenueOre: lost ? (l?.revenue ?? 0) : null,
        stockoutDayTenths: lost ? Math.round((l?.bp ?? 0) / 1_000) : null,
      };
    });
  const earlier =
    previous && input.previous
      ? unitRows(input.previous, input, machineIds, previous.end).filter(shown)
      : [];

  return {
    ranking: fleetRanking(current, earlier),
    period: dp.period,
    days: dp.days,
    previous,
    machines,
    storeShareDeducted: storeShareDeducted(input.current.settings),
    lostKnown: lost !== null,
  };
}

export function loadFleetRanking(
  searchParams: SearchParamsInput,
  options?: { readonly withLost?: boolean },
): Promise<FleetRankingData> {
  return loadFleetRankingWith(requestPageLoaders(), searchParams, options);
}

/**
 * Bästa sortiment för en automat i perioden (hela dagar med data). Läser hela
 * organisationens order en gång: förslagen bygger på vad som säljer i andra automater.
 */
export async function loadBestAssortmentWith(
  loaders: PageLoaders,
  machineId: string,
  searchParams: SearchParamsInput,
): Promise<BestAssortmentData> {
  const ctx = await loaders.context();
  requireEconomy(ctx);
  const p = await loaders.period(searchParams);
  const dp = completeDataPeriod(p.period, p.dataStart, ctx.today);
  const viewer = await loaders.viewer();
  const [input, slotPeriods, lost] = await Promise.all([
    loaders.domainInput({ period: dp.period }),
    loadSlotPeriodsFor(viewer),
    loadStockouts(loaders, ctx, dp.period),
  ]);
  const ledger = buildLedger(input.current);
  const deduct = storeShareDeducted(ledger.settings);
  const sales: AssortmentSale[] = [];
  for (const e of ledger.entries) {
    if (e.order.machineId === null) continue;
    sales.push({
      machineId: e.order.machineId,
      titleId: e.order.titleId,
      date: e.order.businessDate,
      profitOre: e.priced ? entryProfitOre(e, deduct) : null,
    });
  }
  return {
    assortment: bestAssortment({
      machineId,
      period: dp.period,
      today: ctx.today,
      sales,
      slotPeriods,
      stockoutDays: lost?.stockoutDays ?? [],
      titles: input.titles,
    }),
    storeShareDeducted: deduct,
  };
}

export function loadBestAssortment(
  machineId: string,
  searchParams: SearchParamsInput,
): Promise<BestAssortmentData> {
  return loadBestAssortmentWith(requestPageLoaders(), machineId, searchParams);
}
