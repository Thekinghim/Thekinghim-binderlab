/**
 * Hems övre del i V2 (byggplanen 2.2): dagens rad, Kräver åtgärd, lugna raden, Dagens rutt
 * och Att göra. Allt ur de gemensamma laddarna: flottans läge (loadFleetState), dagens rutt
 * (loadDayRoute, besöksplanen), Att göra (loadRankedTodoState) och prisråden (Lönsamhet).
 *
 * Alla fyra roller. Belopp räknas och skickas bara för roller som ser ekonomi: för
 * påfyllaren saknas fälten helt (flottans läge har ingen ekonomi, prisråden läses inte, och
 * hemActions/hemTodos tar bort kronor). Påfyllaren läser aldrig order (RLS).
 */

import { emptyRouteText } from "@/server/data/v2/route-model";
import "server-only";

import { cache } from "react";

import { priceLossPerDayOre } from "@/analytics/fleet-status";
import {
  hemActions,
  hemTodos,
  type ActionPriceInput,
  type HemAction,
  type HemActionsResult,
  type HemTodo,
} from "@/analytics/home-v2";
import { addDays, PRICE_ADVICE_WINDOW_DAYS, unitMargin } from "@/domain";
import {
  cachedViewState,
  loadContext,
  loadMasterData,
  loadSalesCounts,
  requireViewer,
} from "@/server/data/core";
import { loadRankedTodoState, loadTodoExtras } from "@/server/data/todos";
import { loadFleetState } from "@/server/data/v2/fleet";
import { loadDayRoute } from "@/server/data/v2/route";

import { loadPriceAdviceFor } from "../../lonsamhet/_lib/price-advice";
import { homeExtraTodos } from "../extras";

/**
 * Prisråden som går med förlust (vinst per pack under 0), en gång per förfrågan: Hem och
 * menyns räknare delar dem. Bara ekonomiroller; vid fel inga (raden är bara ett råd).
 */
const loadLossAdvice = cache(async () => {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy || !ctx.settings) return [];
  try {
    const advice = await loadPriceAdviceFor(await requireViewer(), new Date(ctx.now));
    return advice.rows.filter((r) => r.profitOre < 0);
  } catch (error) {
    console.error("[hem] Prisråden kunde inte läsas:", error);
    return [];
  }
});

/** Antalet prisråd med förlust (menyns räknare: raderna i Kräver åtgärd utan beloppen). */
export async function loadLossAdviceCount(): Promise<number> {
  return (await loadLossAdvice()).length;
}

/** Prisråd som går med förlust, med förlorad vinst per dag (försäljningen i fönstret). */
async function loadLossPrices(): Promise<ActionPriceInput[]> {
  const ctx = await loadContext();
  const loss = await loadLossAdvice();
  if (loss.length === 0 || !ctx.settings) return [];
  try {
    const range = { start: addDays(ctx.today, -(PRICE_ADVICE_WINDOW_DAYS - 1)), end: ctx.today };
    const sales = await loadSalesCounts({ period: range });
    const units = new Map<string, number>();
    for (const r of sales.rows) units.set(r.titleId, (units.get(r.titleId) ?? 0) + r.units);
    const settings = ctx.settings;
    return loss.map((r) => {
      const perDayMilli = Math.round(
        ((units.get(r.titleId) ?? 0) * 1_000) / PRICE_ADVICE_WINDOW_DAYS,
      );
      const suggested =
        r.suggestedPriceOre !== null
          ? unitMargin(r.suggestedPriceOre, r.unitCostOre, settings).profitOre
          : 0;
      return {
        titleId: r.titleId,
        name: r.name,
        salePriceOre: r.salePriceOre,
        unitCostOre: r.unitCostOre,
        profitOre: r.profitOre,
        suggestedPriceOre: r.suggestedPriceOre,
        lossOre: priceLossPerDayOre({
          profitPerPackNowOre: r.profitOre,
          profitPerPackSuggestedOre: Math.max(suggested, 0),
          unitsPerDayMilli: perDayMilli,
        }),
      };
    });
  } catch (error) {
    console.error("[hem] Prisråden kunde inte läsas:", error);
    return [];
  }
}

/** Att göras egna rader (bokföringen, nya automater, Awish, startklar), en gång per förfrågan. */
export const loadHemExtras = cache(async (): Promise<ReturnType<typeof homeExtraTodos>> =>
  loadTodoExtras()
    .then(homeExtraTodos)
    .catch(() => []),
);

export interface HemRouteCard {
  readonly stops: number;
  readonly cities: readonly string[];
  readonly totalPacks: number;
  readonly totalKm: number | null;
  readonly fill: number;
  readonly check: number;
  readonly done: number;
  readonly load: readonly {
    readonly titleId: string;
    readonly titleName: string;
    readonly quantity: number;
  }[];
  readonly short: readonly {
    readonly titleId: string;
    readonly titleName: string;
    readonly shortBy: number;
  }[];
  /** Bara ekonomiroller: Σ förlorad vinst per dag över stoppen (öre). */
  readonly savesOre?: number;
  readonly limits: { readonly maxStops: number; readonly maxPacks: number };
  /** Första stoppet som inte är klart (Starta rutt öppnar det i Fyll på), eller null. */
  readonly nextMachineId: string | null;
  /** Raden utan stopp (samma som Rutt, emptyRouteText). */
  readonly empty: { readonly title: string; readonly body: string | null };
  /** Automater som inte ryms i veckans rutter. */
  readonly overflow: number;
}

export interface HemToday {
  readonly economy: boolean;
  readonly actions: HemActionsResult;
  readonly route: HemRouteCard;
  readonly todos: { readonly rows: HemTodo[]; readonly total: number };
  /** Automater som är uppsatta (inte startklara), för "9 av 10 automater i drift". */
  readonly installed: number;
}

/** En gång per förfrågan (dagens rad, korten och menyns räknare läser samma). */
export const loadHemToday = cache(async (): Promise<HemToday> =>
  // Beror inte på vald period: sparad mellan förfrågningar (core/cachedViewState), så att
  // ett periodbyte inte räknar om Kräver åtgärd, Dagens rutt och Att göra.
  cachedViewState("hem-today", loadHemTodayNow),
);

async function loadHemTodayNow(): Promise<HemToday> {
  const ctx = await loadContext();
  const economy = ctx.canSeeEconomy;
  const [fleet, route, prices, todoState, extras, master] = await Promise.all([
    loadFleetState(),
    loadDayRoute(),
    loadLossPrices(),
    loadRankedTodoState().catch((error: unknown) => {
      console.error("[hem] Att göra kunde inte läsas:", error);
      return { items: [], dismissed: [] };
    }),
    loadHemExtras(),
    loadMasterData(),
  ]);

  const routePacks = new Map(route.stops.map((s) => [s.machineId, s.packs]));
  const actions = hemActions({ machines: fleet.machines, prices, economy, routePacks });

  const own = new Set(master.titles.filter((t) => t.ownProduct === true).map((t) => t.id));
  const todos = hemTodos({
    items: todoState.items,
    extras,
    short: route.short.map((s) => ({ ...s, own: own.has(s.titleId) })),
    economy,
  });

  // Samma km och "räddar" som Rutt (route-model.ts): vägsträckan × 1,25 och bara stopp som
  // inte är klara.
  const saves = route.savesProfitPerDayOre;
  const routeCard: HemRouteCard = {
    stops: route.stops.length,
    cities: route.cities,
    totalPacks: route.totalPacks,
    totalKm: route.km,
    fill: route.stops.filter((s) => s.status !== "offline").length,
    check: route.stops.filter((s) => s.status === "offline").length,
    done: route.stops.filter((s) => s.done).length,
    load: route.load,
    short: route.short,
    ...(economy && saves !== null ? { savesOre: saves } : {}),
    limits: { maxStops: route.limits.maxStops, maxPacks: route.limits.maxPacks },
    nextMachineId: route.stops.find((s) => !s.done)?.machineId ?? null,
    empty: emptyRouteText(route),
    overflow: route.overflow.length,
  };
  const installed = fleet.machines.filter((m) => m.status !== "startklar").length;
  return { economy, actions, route: routeCard, todos, installed };
}

/**
 * Antal till räknaren vid Hem i menyn ur hela Hem (Kräver åtgärd + Att göra). Menyn läser
 * den lätta vägen (../menu-counts.ts, samma tal); den här finns för jämförelsen i testerna.
 */
export async function loadHemCount(): Promise<number> {
  const t = await loadHemToday();
  return t.actions.total + t.todos.total;
}

export type { HemAction };
