/**
 * Veckans form per automat ur databasen (runda 2, T4-3): för sidor som bara laddar de senaste
 * dagarnas order (Lager, Automater, Mystery) men ska nämna samma slutdag som Att göra.
 *
 *   const shapes = await loadWeekShapes(tx, orgId, today);
 *   sellOut({ onHand, dailyAvg, from: addDays(today, -1), weekShare: shapes.get(machineId) })
 *   weeklyVisitPlan({ …, weekShares: shapes })
 *   refillTodos(ctx, { weekShares: shapes })
 *
 * Samma fönster och samma regler som när formen räknas ur orderna (28 dagar t.o.m. i går,
 * @/analytics/sellout/week-shape), så svaret blir detsamma som i Att göra och larmen.
 * Körs som den inloggade (RLS): bara dagar och automater läses, inga belopp.
 */

import "server-only";

import { weekShapes, weekShapeStart } from "@/analytics/sellout/week-shape";
import type { WeekShare } from "@/analytics/sellout";
import type { Tx } from "@/db/client";
import { addDays, type IsoDate } from "@/domain";

import { querySaleEventsAsOrders } from "./core/queries";

/** Formen per automat. Automater med för lite historik saknas (platt snitt). */
export async function loadWeekShapes(
  tx: Tx,
  orgId: string,
  today: IsoDate,
  machines: readonly { readonly id: string; readonly activeFrom?: IsoDate | null }[] = [],
): Promise<Map<string, WeekShare>> {
  const asOf = addDays(today, -1);
  const orders = await querySaleEventsAsOrders(tx, orgId, {
    start: weekShapeStart(asOf),
    end: asOf,
  });
  // Frågan täcker exakt fönstret: `covered` sägs uttryckligen.
  return weekShapes(orders, { asOf, machines, covered: true });
}
