/**
 * Larmgräns per automat och titel (tabellen slot_alerts). Saldo högst gränsen ger en
 * påfyllningspunkt i Att göra (@/analytics/todos withSlotAlerts) och varningsfärg på Lager.
 *
 * Läses av alla roller (inga belopp), skrivs bara av ägare och admin (RLS och kontrollen
 * här). Ändringar loggas i audit_log av triggern. Importeras direkt, inte via ./index.
 */

import "server-only";

import { and, eq } from "drizzle-orm";

import {
  applyDismissals,
  withCapacities,
  withSlotAlerts,
  type SlotAlert,
  type SlotPeriod,
} from "@/analytics/todos";
import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import { AuthorizationError, withUserDbFor } from "@/server/access";

import type { IsoDate } from "@/domain";

import {
  businessToday,
  loadMasterDataFor,
  requireViewerRole,
  slotCapacitiesInRequest,
  stockRowsInRequest,
  type TodoState,
  type Viewer,
} from "./loaders";
import { queryTodoDismissals } from "./queries";
import { ALL_ROLES, type MasterData } from "./types";

/** Roller som får ändra larmgränsen. */
export const SLOT_ALERT_ROLES = ["owner", "admin"] as const;

/** Högsta larmgräns (samma som tabellens check). */
export const MAX_ALERT_UNITS = 10_000;

/** Alla larmgränser i organisationen, som användaren med RLS. */
export async function querySlotAlerts(tx: Tx, orgId: string): Promise<SlotAlert[]> {
  const rows = await tx
    .select({
      machineId: s.slotAlerts.machineId,
      titleId: s.slotAlerts.titleId,
      alertAtUnits: s.slotAlerts.alertAtUnits,
    })
    .from(s.slotAlerts)
    .where(eq(s.slotAlerts.organizationId, orgId));
  return rows;
}

/** Larmgränserna som användaren (alla roller). */
export function loadSlotAlertsFor(viewer: Viewer): Promise<SlotAlert[]> {
  return withUserDbFor(viewer.user, (tx) => querySlotAlerts(tx, viewer.organization.id));
}

/**
 * Sätter larmgränsen för en titel i en automat, eller tar bort den (null). Ägare och
 * admin. Returnerar den nya gränsen.
 */
export async function setSlotAlertFor(
  viewer: Viewer,
  input: { machineId: string; titleId: string; alertAtUnits: number | null },
): Promise<number | null> {
  await requireViewerRole(viewer, SLOT_ALERT_ROLES);
  const orgId = viewer.organization.id;
  const units = input.alertAtUnits;
  if (units !== null && (!Number.isSafeInteger(units) || units < 0 || units > MAX_ALERT_UNITS)) {
    throw new RangeError("Ogiltig larmgräns.");
  }
  return withUserDbFor(viewer.user, async (tx) => {
    const where = and(
      eq(s.slotAlerts.organizationId, orgId),
      eq(s.slotAlerts.machineId, input.machineId),
      eq(s.slotAlerts.titleId, input.titleId),
    );
    if (units === null) {
      await tx.delete(s.slotAlerts).where(where);
      return null;
    }
    await tx
      .insert(s.slotAlerts)
      .values({
        organizationId: orgId,
        machineId: input.machineId,
        titleId: input.titleId,
        alertAtUnits: units,
      })
      .onConflictDoUpdate({
        target: [s.slotAlerts.organizationId, s.slotAlerts.machineId, s.slotAlerts.titleId],
        set: { alertAtUnits: units },
      });
    return units;
  });
}

/** Det larmgränserna på Att göra behöver (loadSlotAlertDataFor). */
export interface SlotAlertData {
  readonly alerts: SlotAlert[];
  readonly stock: Array<{
    machineId: string;
    titleId: string;
    onHand: number;
    lastRestockedAt: string | null;
    lastRefilledAt: string | null;
    capacity?: number | null;
  }>;
  readonly machines: MasterData["machines"];
  readonly titles: MasterData["titles"];
  readonly dismissals: Awaited<ReturnType<typeof queryTodoDismissals>>;
  readonly today: IsoDate;
}

/**
 * Larmgränserna med lager, automater, titlar och avbockningar, eller null när det inte
 * finns några gränser (eller rollen är läsare). Kan läsas parallellt med Att göra.
 */
export async function loadSlotAlertDataFor(
  viewer: Viewer,
  now: Date,
): Promise<SlotAlertData | null> {
  const orgId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  // Läsaren får inga punkter alls (laddaren), och ska inte få dem härifrån heller.
  const role = await requireViewerRole(viewer, ALL_ROLES).catch((error: unknown) => {
    if (error instanceof AuthorizationError) return null;
    throw error;
  });
  if (role === null || role === "viewer") return null;
  const found = await withUserDbFor(viewer.user, async (tx) => {
    const alerts = await querySlotAlerts(tx, orgId);
    if (alerts.length === 0) return null;
    return { alerts, dismissals: await queryTodoDismissals(tx, orgId) };
  });
  if (!found) return null;
  // Stamdata och lager delas med resten av förfrågan (React cache i ./loaders).
  const [{ titles, machines }, stockRows, capacities] = await Promise.all([
    loadMasterDataFor(viewer, now),
    stockRowsInRequest(viewer),
    slotCapacitiesInRequest(viewer, now),
  ]);
  // Med kapaciteten: ett fullt fack ger ingen punkt för larmgränsen heller (som på Fyll på).
  const stock = withCapacities(
    stockRows
      .filter((r) => r.locationKind === "machine" && r.machineId !== null)
      .map((r) => ({
        machineId: r.machineId as string,
        titleId: r.titleId,
        onHand: r.onHand,
        lastRestockedAt: r.lastRestockedAt,
        lastRefilledAt: r.lastRefilledAt ?? null,
      })),
    capacities,
  );
  return { ...found, stock, machines, titles, today };
}

/** Lägger larmgränserna på punkterna. Avbockningar gäller som för andra punkter. */
export function applySlotAlerts(
  state: TodoState,
  data: SlotAlertData | null,
  periods: readonly SlotPeriod[],
): TodoState {
  if (!data) return state;
  const merged = withSlotAlerts([...state.items, ...state.dismissed], {
    alerts: data.alerts,
    stock: data.stock,
    machines: data.machines,
    titles: data.titles,
    today: data.today,
    slotPeriods: periods,
  });
  const items = applyDismissals(merged, data.dismissals);
  const shown = new Set(items.map((t) => t.key));
  return { items, dismissed: merged.filter((t) => !shown.has(t.key)) };
}

/**
 * Lägger larmgränserna på Att göra (laddaren i ./loaders räknar utan dem). Läsaren har
 * inga punkter. Avbockningar gäller som för andra punkter (nyckel och fingerprint).
 */
export async function todoStateWithSlotAlerts(
  viewer: Viewer,
  state: TodoState,
  periods: readonly SlotPeriod[],
  now: Date,
): Promise<TodoState> {
  return applySlotAlerts(state, await loadSlotAlertDataFor(viewer, now), periods);
}
