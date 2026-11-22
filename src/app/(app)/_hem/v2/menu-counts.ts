/**
 * Menyns räknare vid Hem och Rutt (byggplanen 2.1), den lätta vägen: samma tal som Hem
 * (Kräver åtgärd + Att göra) och Rutt (stopp kvar i dag), men utan det som bara behövs för
 * att visa raderna. Läses i layouten vid varje sidbyte.
 *
 * Det som hoppas över (ändrar inte antalet, bara ordningen eller beloppen):
 * - flottans ekonomi (rangordningen över 30 dagar): status och fyllnad är desamma utan den
 *   (loadFleetStatus, loadDayRouteStatus);
 * - förlorad försäljning för Att göras ordning (loadVisibleTodoState i stället för den
 *   rangordnade listan, samma punkter);
 * - försäljningen bakom prisrådens förlust per dag (bara antalet prisråd med förlust räknas).
 *
 * Allt annat är samma laddare som Hem och Rutt, memoiserade per förfrågan (React cache), så
 * på Hem och Rutt läses databasen en gång för både sidan och räknaren. Inget sparas mellan
 * förfrågningar. test/db/hem-menyraknare.test.ts jämför talen med hela Hem och Rutt.
 */

import "server-only";

import { cache } from "react";

import { hemActions, hemTodos } from "@/analytics/home-v2";
import { loadContext, loadMasterData } from "@/server/data/core";
import { loadVisibleTodoState } from "@/server/data/todos";
import { loadFleetStatus } from "@/server/data/v2/fleet";
import { loadDayRouteStatus } from "@/server/data/v2/route";

import { loadHemExtras, loadLossAdviceCount } from "./today-data";

/** Räknaren vid Hem: Kräver åtgärd + Att göra, som hela Hem räknar dem (loadHemCount). */
export const loadHemMenuCount = cache(async (): Promise<number> => {
  const ctx = await loadContext();
  const economy = ctx.canSeeEconomy;
  const [fleet, route, lossPrices, todoState, extras, master] = await Promise.all([
    loadFleetStatus(),
    loadDayRouteStatus(),
    loadLossAdviceCount(),
    loadVisibleTodoState().catch((error: unknown) => {
      console.error("[meny] Att göra kunde inte läsas:", error);
      return { items: [], dismissed: [] };
    }),
    loadHemExtras(),
    loadMasterData(),
  ]);
  // Samma funktioner som Hem: bara antalet rader används.
  const actions = hemActions({ machines: fleet.machines, prices: [], economy: false });
  const own = new Set(master.titles.filter((t) => t.ownProduct === true).map((t) => t.id));
  const todos = hemTodos({
    items: todoState.items,
    extras,
    short: route.short.map((s) => ({ ...s, own: own.has(s.titleId) })),
    economy,
  });
  return actions.total + (economy ? lossPrices : 0) + todos.total;
});

/** Räknaren vid Rutt: dagens stopp som inte är klara (samma stopp som loadDayRoute). */
export const loadRouteMenuCount = cache(async (): Promise<number> => {
  const route = await loadDayRouteStatus();
  return route.stops.filter((s) => !s.done).length;
});
