/**
 * Att göra med prioritering efter förlorad försäljning, för sidorna som visar listan i
 * ordning (Att göra och Hem). Menyns räknare använder loadTodos (samma punkter, samma
 * antal): förlorad försäljning ändrar bara ordningen och underlaget, aldrig vilka punkter
 * som finns.
 *
 * Förlorad intäkt per titel och automat räknas av @/analytics/lost-sales via
 * lostSalesSummaryFor (Prognos & inköp), för de senaste 14 hela dagarna (påfyllningens
 * fönster). Bara roller som ser ekonomi; påfyllaren får listan som den är, utan belopp.
 */

import "server-only";

import { cache } from "react";

import { prioritizeByLostSales, TODO_DEFAULTS } from "@/analytics/todos";
import { addDays, DomainError } from "@/domain";
import { getRoleFor } from "@/server/access";
import { lostSalesSummaryFor } from "@/server/purchasing/lost-sales-summary";
import { currentViewer } from "@/server/purchasing/session";
import { getActiveOrganization } from "@/server/session";

import { loadContext } from "./core";
import { businessToday, loadTodoStateFor, type TodoState, type Viewer } from "./core/loaders";
import { canSeeEconomy } from "./core/types";

/** Fönstret för förlorad försäljning i prioriteringen (dagar t.o.m. i går). */
export const LOST_SALES_WINDOW_DAYS = TODO_DEFAULTS.refillWindowDays;

/**
 * Punkterna i Att göra (som loadTodoStateFor), där påfyllningar med förlorad försäljning
 * går först inom sin nivå. Kan förlorad försäljning inte räknas (ofullständig data)
 * returneras listan i vanlig ordning.
 */
export async function loadRankedTodoStateFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<TodoState> {
  const state = await loadTodoStateFor(viewer, now);
  if (!state.items.some((t) => t.kind === "refill")) return state;
  const role = await getRoleFor(viewer.user, viewer.organization.id);
  if (role === null || !canSeeEconomy(role)) return state;
  const today = businessToday(now, viewer.organization.timezone);
  const period = { start: addDays(today, -LOST_SALES_WINDOW_DAYS), end: addDays(today, -1) };
  try {
    const lost = await lostSalesSummaryFor(viewer, period, now);
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
 * För serverkomponenter: Att göra prioriterad efter förlorad försäljning, som den
 * inloggade, memoiserad per förfrågan. Tom för den utan organisation.
 */
export const loadRankedTodoState = cache(async (): Promise<TodoState> => {
  if (!(await getActiveOrganization())) return { items: [], dismissed: [] };
  const ctx = await loadContext();
  return loadRankedTodoStateFor(await currentViewer(), new Date(ctx.now));
});
