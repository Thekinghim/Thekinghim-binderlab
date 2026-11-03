import "server-only";

import type { SearchParamsInput } from "@/components/shell/period-state";
import {
  loadContext,
  loadDomainInput,
  loadPeriod,
  loadSyncInfo,
  requireRoute,
  requireViewer,
} from "@/server/data/core";
import { loadRankedTodoState } from "@/server/data/todos";
import { optionalOnboardingStatus } from "@/server/onboarding";
import { lostSalesSummaryFor } from "@/server/purchasing";

import { loadHomeWith, type HomeData } from "./data";

/**
 * Hem för den inloggade, med de memoiserade laddarna (samma frågor som layouten delas).
 * Att göra kommer prioriterad efter förlorad försäljning (som på /att-gora), nyckeltalet
 * "Slutsålt kostade …" från Prognos & inköp och checklistan från Kom igång.
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
      // Med viewern direkt: organisationen och rollen är redan lästa i förfrågan.
      lostSales: async (period, scope) => {
        const [viewer, ctx] = await Promise.all([requireViewer(), loadContext()]);
        return lostSalesSummaryFor(viewer, period, new Date(ctx.now), scope);
      },
      onboarding: optionalOnboardingStatus,
      sync: loadSyncInfo,
    },
    searchParams,
  );
}
