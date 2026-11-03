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
  withSlotAlerts,
  type SlotAlert,
  type SlotPeriod,
} from "@/analytics/todos";
import * as s from "@/db/schema";
import type { Tx } from "@/db/client";
import { getRoleFor, requireRoleFor, withUserDbFor } from "@/server/access";

import { businessToday, type TodoState, type Viewer } from "./loaders";
import {
  queryMachines,
  queryPlacements,
  queryStock,
  queryTitles,
  queryTodoDismissals,
} from "./queries";

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
  await requireRoleFor(viewer.user, viewer.organization.id, SLOT_ALERT_ROLES);
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
  const orgId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  // Läsaren får inga punkter alls (laddaren), och ska inte få dem härifrån heller.
  const role = await getRoleFor(viewer.user, orgId);
  if (role === null || role === "viewer") return state;
  return withUserDbFor(viewer.user, async (tx) => {
    const alerts = await querySlotAlerts(tx, orgId);
    if (alerts.length === 0) return state;
    const [stockRows, titles, placements, dismissals] = await Promise.all([
      queryStock(tx, orgId),
      queryTitles(tx, orgId),
      queryPlacements(tx, orgId),
      queryTodoDismissals(tx, orgId),
    ]);
    const machines = await queryMachines(tx, orgId, placements, today);
    const stock = stockRows
      .filter((r) => r.locationKind === "machine" && r.machineId !== null)
      .map((r) => ({
        machineId: r.machineId as string,
        titleId: r.titleId,
        onHand: r.onHand,
        lastRestockedAt: r.lastRestockedAt,
      }));
    const merged = withSlotAlerts([...state.items, ...state.dismissed], {
      alerts,
      stock,
      machines,
      titles,
      today,
      slotPeriods: periods,
    });
    const items = applyDismissals(merged, dismissals);
    const shown = new Set(items.map((t) => t.key));
    return { items, dismissed: merged.filter((t) => !shown.has(t.key)) };
  });
}
