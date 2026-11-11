/**
 * Att göra med prioritering efter förlorad försäljning, för sidorna som visar listan i
 * ordning (Att göra och Hem). Menyns räknare använder loadTodoCount (samma punkter, samma
 * antal): förlorad försäljning ändrar bara ordningen och underlaget, aldrig vilka punkter
 * som finns.
 *
 * Påfyllningar av titlar som gått ur sortimentet tas bort (./assortment.ts), som på Lager
 * och i Drifts besöksplan. Larmgränserna (./core/slot-alerts.ts) läggs till sist.
 *
 * Förlorad intäkt per titel och automat räknas av @/analytics/lost-sales via
 * lostSalesSummaryFor (Prognos & inköp), för de senaste 14 hela dagarna (påfyllningens
 * fönster). Bara roller som ser ekonomi; påfyllaren får listan som den är, utan belopp.
 */

import "server-only";

import { cache } from "react";

import { countWithVisits, prioritizeByLostSales, TODO_DEFAULTS } from "@/analytics/todos";
import type { VisitPlan } from "@/analytics/visits";
import { addDays, DomainError, type Period } from "@/domain";
import { AuthorizationError, withUserDbFor } from "@/server/access";
import { healthOf, loadHealthData } from "@/server/alerts/inputs";
import type { AwishExpiryNotice } from "@/server/awish/expiry";
import { loadAwishExpiryFor } from "@/server/awish/expiry-notice";
import { readyPackageFor } from "@/server/bokforing/stored";
import { loadNewMachinesFor } from "@/server/machines/new-machines";
import { lostSalesSummaryFor } from "@/server/purchasing/lost-sales-summary";
import type { LostSalesSummary } from "@/server/purchasing/types";
import { withUserDb } from "@/server/session";

import { loadSlotPeriodsFor, querySlotPeriods, todoStateWithoutRetired } from "./assortment";
import { cachedForViewer, loadOptionalContext, loadTodoState, requireViewer } from "./core";
import { applySlotAlerts, loadSlotAlertDataFor, todoStateWithSlotAlerts } from "./core/slot-alerts";
import {
  businessToday,
  loadTodoStateFor,
  requireViewerRole,
  slotCapacitiesInRequest,
  stockRowsInRequest,
  type TodoState,
  type Viewer,
} from "./core/loaders";
import { ownStockTotals } from "./core/own-stock";
import { ALL_ROLES, canSeeEconomy } from "./core/types";
import { queryStorePlaces, type StorePlace } from "./team";
import { weeklyVisitPlan } from "./visit-plan";
import { weekShapesInRequest } from "./week-shapes";

/** Fönstret för förlorad försäljning i prioriteringen (dagar t.o.m. i går). */
export const LOST_SALES_WINDOW_DAYS = TODO_DEFAULTS.refillWindowDays;

/** Förlorad försäljning för en period, eller null när den inte ska visas (ingen ekonomi). */
type LostSalesFor = (period: Period) => Promise<LostSalesSummary | null>;

/** De senaste LOST_SALES_WINDOW_DAYS hela dagarna (t.o.m. i går). */
function lostSalesWindow(viewer: Viewer, now: Date): Period {
  const today = businessToday(now, viewer.organization.timezone);
  return { start: addDays(today, -LOST_SALES_WINDOW_DAYS), end: addDays(today, -1) };
}

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
  // Rollen läses högst en gång per förfrågan (requireViewerRole).
  const role = await requireViewerRole(viewer, ALL_ROLES).catch((error: unknown) => {
    if (error instanceof AuthorizationError) return null;
    throw error;
  });
  if (role === null || !canSeeEconomy(role)) return state;
  try {
    const lost = await lostFor(lostSalesWindow(viewer, now));
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
  const state = await todoStateWithSlotAlerts(
    viewer,
    todoStateWithoutRetired(raw, periods, businessToday(now, viewer.organization.timezone)),
    periods,
    now,
  );
  return rankTodoState(viewer, state, now, (period) => lostSalesSummaryFor(viewer, period, now));
}

/**
 * Punkterna i Att göra som den inloggade, utan påfyllningar av utgångna titlar, i
 * laddarens ordning. Memoiserad per förfrågan: menyns räknare och listan delar den.
 */
export const loadVisibleTodoState = cache(async (): Promise<TodoState> => {
  const ctx = await loadOptionalContext();
  if (!ctx) return { items: [], dismissed: [] };
  const viewer = await requireViewer();
  // Punkterna, sortimentet och larmgränserna läses parallellt.
  const [state, periods, alerts] = await Promise.all([
    loadTodoState(),
    withUserDb((tx) => querySlotPeriods(tx, ctx.organization.id)),
    loadSlotAlertDataFor(viewer, new Date(ctx.now)),
  ]);
  return applySlotAlerts(todoStateWithoutRetired(state, periods, ctx.today), alerts, periods);
});

/**
 * Raderna i Att göra som inte kommer ur reglerna: månaden vars bokföring är klar att ladda
 * ner (bara ägare och admin), antalet nya automater att koppla och Awish-kontot som går ut. En källa för menyns
 * räknare, Att göra och Hem, så att de räknar samma rader. Fel ger "inga" (raden är bara
 * en påminnelse).
 */
export async function loadTodoExtrasFor(viewer: Viewer): Promise<{
  bokforingMonth: string | null;
  newMachines: number;
  awishExpiry: AwishExpiryNotice | null;
}> {
  const [ready, found, awishExpiry] = await Promise.all([
    readyPackageFor(viewer).catch(() => null),
    loadNewMachinesFor(viewer).catch(() => null),
    loadAwishExpiryFor(viewer).catch(() => null),
  ]);
  return {
    bokforingMonth: ready?.month ?? null,
    newMachines: found?.machines.length ?? 0,
    awishExpiry,
  };
}

/** Sekunder som menyns räknare får vara gammal (den räknas annars vid varje sidladdning). */
const TODO_COUNT_SECONDS = 60;

/**
 * Antalet punkter i Att göra, för menyns räknare (samma punkter som listan). Sparas en
 * minut per användare och organisation (cachedForViewer), så att räknaren, som läser
 * order, lager och larm, inte tar databasanslutningar från sidan vid varje sidladdning.
 * Ändringar i appen (revalidateAppData) rensar den direkt.
 */
export async function loadTodoCount(): Promise<number> {
  return cachedForViewer("todo-count", TODO_COUNT_SECONDS, async () => {
    const viewer = await requireViewer();
    // Som rubriken på Att göra: punkterna plus raderna "Ny automat hittad", bokföringen
    // att ladda ner och Awish-kontot (bara ägare och admin; noll för andra roller).
    const [state, extras] = await Promise.all([loadVisibleTodoState(), loadTodoExtrasFor(viewer)]);
    // Ett besök (automatens alla påfyllningar) räknas som en sak, som på Att göra och Hem.
    return (
      countWithVisits(state.items) +
      (extras.bokforingMonth ? 1 : 0) +
      (extras.newMachines > 0 ? 1 : 0) +
      (extras.awishExpiry ? 1 : 0)
    );
  });
}

/**
 * Antalet punkter i Att göra för en given användare (samma punkter och rader som
 * loadTodoCount), utan förfrågans minne: för jobb utan inloggad användare
 * (veckosammanfattningen). Läsaren har ingen lista (0).
 */
export async function loadTodoCountFor(viewer: Viewer, now: Date = new Date()): Promise<number> {
  const [raw, periods, alerts, extras] = await Promise.all([
    loadTodoStateFor(viewer, now),
    loadSlotPeriodsFor(viewer),
    loadSlotAlertDataFor(viewer, now),
    loadTodoExtrasFor(viewer),
  ]);
  const state = applySlotAlerts(
    todoStateWithoutRetired(raw, periods, businessToday(now, viewer.organization.timezone)),
    alerts,
    periods,
  );
  return (
    countWithVisits(state.items) +
    (extras.bokforingMonth ? 1 : 0) +
    (extras.newMachines > 0 ? 1 : 0) +
    (extras.awishExpiry ? 1 : 0)
  );
}

/** Besöksplanen och butikernas plats, som Att göra och Hem behöver dem. */
export interface TodoVisitPlan {
  readonly plan: VisitPlan;
  /** Butikernas adress och plats (butikens id), för "Öppna i Google Maps". */
  readonly places: Map<string, StorePlace>;
}

/**
 * Veckans besöksplan för Att göra och Hem: samma funktion (weeklyVisitPlan) och samma indata
 * som Drift > Besök (försäljningen ur lagerhändelserna, lagret i automaterna, vårt lager,
 * maskinhälsan, sortimentet och fackens kapacitet), så att sidorna säger samma dag för
 * samma automat. Bara läsning, inga belopp: alla roller som har Att göra.
 */
export async function loadTodoVisitPlanFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<TodoVisitPlan> {
  const orgId = viewer.organization.id;
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);
  const stockP = stockRowsInRequest(viewer);
  const capacityP = slotCapacitiesInRequest(viewer, now);
  const shapesP = weekShapesInRequest(viewer, today);
  stockP.catch(() => {});
  capacityP.catch(() => {});
  return withUserDbFor(viewer.user, async (tx) => {
    const data = await loadHealthData(tx, orgId, today, now);
    const [slotPeriods, places, stockRows, capacities] = await Promise.all([
      querySlotPeriods(tx, orgId),
      queryStorePlaces(tx, orgId),
      stockP,
      capacityP,
    ]);
    const warehouse = ownStockTotals(stockRows);
    const plan = weeklyVisitPlan({
      orders: data.orders,
      machines: data.machines.filter((m) => !m.archived).map((m) => ({ ...m, location: null })),
      titles: data.titles,
      stock: data.stock,
      warehouseStock: warehouse.length > 0 ? warehouse : null,
      health: healthOf(data, timeZone, now),
      slotPeriods,
      capacities,
      weekShares: await shapesP,
      today,
      timeZone,
      now,
    });
    return { plan, places };
  });
}

/**
 * Besöksplanen för den inloggade, en gång per förfrågan. null när den inte går att räkna:
 * besöken står då kvar i listan, utan dag ("Åk till BL-003 snart").
 */
export const loadTodoVisitPlan = cache(async (): Promise<TodoVisitPlan | null> => {
  const ctx = await loadOptionalContext();
  if (!ctx) return null;
  try {
    return await loadTodoVisitPlanFor(await requireViewer(), new Date(ctx.now));
  } catch (error) {
    if (error instanceof AuthorizationError) throw error;
    console.error("[att-gora] Besöksplanen kunde inte läsas:", error);
    return null;
  }
});

/**
 * För serverkomponenter: Att göra prioriterad efter förlorad försäljning, som den
 * inloggade, memoiserad per förfrågan. Punkterna (loadTodoState) är också memoiserade, så
 * menyns räknare, Hem och Att göra delar dem inom samma sidladdning; förlorad försäljning
 * räknas parallellt med dem. Tom för den utan organisation.
 */
export const loadRankedTodoState = cache(async (): Promise<TodoState> => {
  const ctx = await loadOptionalContext();
  if (!ctx) return { items: [], dismissed: [] };
  const viewer = await requireViewer();
  const now = new Date(ctx.now);
  // Förlorad försäljning räknas parallellt med punkterna (inte efter), när rollen ser
  // ekonomi; den används bara om det finns påfyllningar att ordna.
  // Med viewern direkt (lostSalesSummaryFor) läses varken organisationen eller rollen en
  // gång till.
  const lost = ctx.canSeeEconomy
    ? lostSalesSummaryFor(viewer, lostSalesWindow(viewer, now), now)
    : null;
  lost?.catch(() => {});
  return rankTodoState(
    viewer,
    await loadVisibleTodoState(),
    now,
    (period) => lost ?? lostSalesSummaryFor(viewer, period, now),
  );
});
