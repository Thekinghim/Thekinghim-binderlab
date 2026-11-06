import "server-only";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { monthOf } from "@/domain";
import {
  loadContext,
  loadDomainInput,
  loadPeriod,
  loadSyncInfo,
  requireRoute,
  requireViewer,
} from "@/server/data/core";
import { goalsProgress } from "@/server/data/goals";
import { loadRankedTodoState, loadTodoExtrasFor } from "@/server/data/todos";
import { optionalOnboardingStatus } from "@/server/onboarding";
import { lostSalesSummaryFor } from "@/server/purchasing";

import { loadGoalsFor } from "../expansion/_lib/service";

import { loadHomeWith, type HomeData } from "./data";
import { homeExtraTodos } from "./extras";

/**
 * Hem för den inloggade, med de memoiserade laddarna (samma frågor som layouten delas).
 * Att göra kommer prioriterad efter förlorad försäljning (som på /att-gora), nyckeltalet
 * "Slutsålt kostade …" från Prognos & inköp, checklistan från Kom igång och månadens mål
 * från Expansion.
 * Påfyllare skickas till sin startsida (Att göra) innan något läses.
 */
export async function loadHome(searchParams: SearchParamsInput): Promise<HomeData> {
  await requireRoute("hem");
  return loadHomeWith(
    {
      context: loadContext,
      period: loadPeriod,
      domainInput: loadDomainInput,
      todos: async () => (await loadRankedTodoState()).items,
      // Samma rader som menyns räknare och Att göra (ny automat, bokföringen).
      extras: async () => homeExtraTodos(await loadTodoExtrasFor(await requireViewer())),
      // Med viewern direkt: organisationen och rollen är redan lästa i förfrågan.
      lostSales: async (period, scope) => {
        const [viewer, ctx] = await Promise.all([requireViewer(), loadContext()]);
        return lostSalesSummaryFor(viewer, period, new Date(ctx.now), scope);
      },
      onboarding: optionalOnboardingStatus,
      sync: loadSyncInfo,
      // Bara dagens månad; namnen tas från grunddata som redan är inlästa.
      goals: async (today, options) => {
        const month = monthOf(today);
        const records = (await loadGoalsFor(await requireViewer())).filter(
          (g) => g.month === month,
        );
        return records.length === 0
          ? []
          : goalsProgress(records, today, undefined, undefined, options);
      },
    },
    searchParams,
  );
}
