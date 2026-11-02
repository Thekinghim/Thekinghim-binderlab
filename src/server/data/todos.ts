/**
 * Att göra med prioritering efter förlorad försäljning, för sidorna som visar listan i
 * ordning (Att göra och Hem). Menyns räknare använder loadTodoCount (samma punkter, samma
 * antal): förlorad försäljning ändrar bara ordningen och underlaget, aldrig vilka punkter
 * som finns.
 *
 * Påfyllningar av titlar som gått ur sortimentet tas bort (./assortment.ts), som på Lager
 * och i Drifts besöksplan.
 *
 * Förlorad intäkt per titel och automat räknas av @/analytics/lost-sales via
 * lostSalesSummaryFor (Prognos & inköp), för de senaste 14 hela dagarna (påfyllningens
 * fönster). Bara roller som ser ekonomi; påfyllaren får listan som den är, utan belopp.
 */

import "server-only";

import { cache } from "react";

import { prioritizeByLostSales, TODO_DEFAULTS } from "@/analytics/todos";
import { addDays, DomainError, type Period } from "@/domain";
import { getRoleFor } from "@/server/access";
import { lostSalesSummary, lostSalesSummaryFor } from "@/server/purchasing/lost-sales-summary";
import type { LostSalesSummary } from "@/server/purchasing/types";
import { currentViewer } from "@/server/purchasing/session";
import { getActiveOrganization, withUserDb } from "@/server/session";

import { loadSlotPeriodsFor, querySlotPeriods, todoStateWithoutRetired } from "./assortment";
import { loadContext, loadTodoState } from "./core";
import { businessToday, loadTodoStateFor, type TodoState, type Viewer } from "./core/loaders";
import { canSeeEconomy } from "./core/types";

/** Fönstret för förlorad försäljning i prioriteringen (dagar t.o.m. i går). */
export const LOST_SALES_WINDOW_DAYS = TODO_DEFAULTS.refillWindowDays;

/** Förlorad försäljning för en period, eller null när den inte ska visas (ingen ekonomi). */
type LostSalesFor = (period: Period) => Promise<LostSalesSummary | null>;

/**
 * Ordnar punkterna efter förlorad försäljning (påfyllningar där slutsålt redan kostat
 * intäkt går först inom sin nivå). Kan förlorad försäljning inte räknas (ofullständig
 * data) returneras listan i vanlig ordning.
 */
async function rankTodoState(
  viewer: Viewer,
  state: TodoState,
  now: Date,
  lostFor: LostSalesFor,
): Promise<TodoState> {
  if (!state.items.some((t) => t.kind === "refill")) return state;
  const role = await getRoleFor(viewer.user, viewer.organization.id);
  if (role === null || !canSeeEconomy(role)) return state;
  const today = businessToday(now, viewer.organization.timezone);
  const period = { start: addDays(today, -LOST_SALES_WINDOW_DAYS), end: addDays(today, -1) };
  try {
    const lost = await lostFor(period);
    if (!lost) return state;
    return {
      items: prioritizeByLostSales(state.items, lost.series, LOST_SALES_WINDOW_DAYS),
      dismissed: state.dismissed,
    };
  } catch (error) {
    if (error instanceof DomainError) return state;
    throw error;
  }
}

/**
 * Punkterna i Att göra (som loadTodoStateFor), där påfyllningar med förlorad försäljning
 * går först inom sin nivå.
 */
export async function loadRankedTodoStateFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<TodoState> {
  const [raw, periods] = await Promise.all([
    loadTodoStateFor(viewer, now),
    loadSlotPeriodsFor(viewer),
  ]);
  const state = todoStateWithoutRetired(
    raw,
    periods,
    businessToday(now, viewer.organization.timezone),
  );
  return rankTodoState(viewer, state, now, (period) => lostSalesSummaryFor(viewer, period, now));
}

/**
 * Punkterna i Att göra som den inloggade, utan påfyllningar av utgångna titlar, i
 * laddarens ordning. Memoiserad per förfrågan: menyns räknare och listan delar den.
 */
export const loadVisibleTodoState = cache(async (): Promise<TodoState> => {
  if (!(await getActiveOrganization())) return { items: [], dismissed: [] };
  const ctx = await loadContext();
  const [state, periods] = await Promise.all([
    loadTodoState(),
    withUserDb((tx) => querySlotPeriods(tx, ctx.organization.id)),
  ]);
  return todoStateWithoutRetired(state, periods, ctx.today);
});

/** Antalet punkter i Att göra, för menyns räknare (samma punkter som listan). */
export async function loadTodoCount(): Promise<number> {
  return (await loadVisibleTodoState()).items.length;
}

/**
 * För serverkomponenter: Att göra prioriterad efter förlorad försäljning, som den
 * inloggade, memoiserad per förfrågan. Punkterna (loadTodoState) och förlorad försäljning
 * (lostSalesSummary) är också memoiserade, så menyns räknare, Hem och Att göra delar dem
 * inom samma sidladdning. Tom för den utan organisation.
 */
export const loadRankedTodoState = cache(async (): Promise<TodoState> => {
  if (!(await getActiveOrganization())) return { items: [], dismissed: [] };
  const ctx = await loadContext();
  return rankTodoState(
    await currentViewer(),
    await loadVisibleTodoState(),
    new Date(ctx.now),
    (period) => lostSalesSummary(period),
  );
});
