import "server-only";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { monthOf } from "@/domain";
import {
  cachedViewState,
  loadContext,
  loadDomainInput,
  loadPeriod,
  loadSyncInfo,
  requireRoute,
  requireViewer,
} from "@/server/data/core";
import { loadRankedTodoState, loadTodoExtras, loadTodoVisitPlan } from "@/server/data/todos";
import { goalsProgress } from "@/server/data/goals";
import { optionalOnboardingStatus } from "@/server/onboarding";
import { lostSalesSummaryFor } from "@/server/purchasing";

import { loadGoalsFor } from "../expansion/_lib/service";

import { loadHomeLostSalesWith, loadHomeWith, type HomeData, type HomeLoaders } from "./data";
import { homeExtraTodos } from "./extras";
import type { HomeLostSales } from "./model";

/** De memoiserade laddarna (samma frågor som layouten delas). */
const loaders = {
  context: loadContext,
  period: loadPeriod,
  domainInput: loadDomainInput,
  todos: async () => (await loadRankedTodoState()).items,
  // Samma rader som menyns räknare och Att göra (ny automat, bokföringen).
  extras: async () => homeExtraTodos(await loadTodoExtras()),
  visitPlan: async () => (await loadTodoVisitPlan())?.plan ?? null,
  // Med viewern direkt: organisationen och rollen är redan lästa i förfrågan.
  lostSales: async (period, scope) => {
    const [viewer, ctx] = await Promise.all([requireViewer(), loadContext()]);
    return lostSalesSummaryFor(viewer, period, new Date(ctx.now), scope);
  },
  // Kom igång och månadens mål beror inte på vald period: sparade mellan förfrågningar.
  onboarding: (orgId) => cachedViewState("home-onboarding", () => optionalOnboardingStatus(orgId)),
  sync: loadSyncInfo,
  // Bara dagens månad; namnen tas från grunddata som redan är inlästa.
  goals: (today, options) =>
    cachedViewState(`home-goals:${today}:${options.storeShare ? "andel" : "-"}`, async () => {
      const month = monthOf(today);
      const records = (await loadGoalsFor(await requireViewer())).filter((g) => g.month === month);
      return records.length === 0
        ? []
        : goalsProgress(records, today, undefined, undefined, options);
    }),
} satisfies HomeLoaders;

/**
 * Hem för den inloggade: Att göra prioriterad efter förlorad försäljning (som på /att-gora),
 * checklistan från Kom igång och månadens mål från Expansion.
 *
 * Utan "Slutsålt kostade …" (loadHomeLostSales; bara kortet Slutsålt och svinn läser den), så
 * att hjältekortets nyckeltal inte väntar på den.
 * Påfyllare skickas till sin startsida (Att göra) innan något läses.
 */
export async function loadHome(searchParams: SearchParamsInput): Promise<HomeData> {
  await requireRoute("hem");
  return loadHomeWith({ ...loaders, lostSales: undefined }, searchParams);
}

/**
 * "Slutsålt kostade …" för Hem: samma tal som HomeData.lostSales i loadHomeWith. `spanText`
 * är modellens (HomeModel.spanText).
 */
export async function loadHomeLostSales(
  searchParams: SearchParamsInput,
  spanText: string | null,
): Promise<HomeLostSales | null> {
  await requireRoute("hem");
  return loadHomeLostSalesWith(loaders, searchParams, spanText);
}
