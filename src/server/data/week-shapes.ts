/**
 * Veckans form per automat ur databasen (runda 2, T4-3): för sidor som bara laddar de senaste
 * dagarnas order (Lager, Automater, Mystery) men ska nämna samma slutdag som Att göra.
 *
 *   const shapes = await loadWeekShapes(tx, orgId, today);
 *   sellOut({ onHand, dailyAvg, from: addDays(today, -1), weekShare: shapes.get(machineId) })
 *   weeklyVisitPlan({ …, weekShares: shapes })
 *   refillTodos(ctx, { weekShares: shapes })
 *
 * Sidorna hämtar formerna med weekShapesInRequest(viewer, today): en läsning per förfrågan,
 * och ALLA sidor (Att göra, Hem, Lager, Drift → Besök, Automater, Mystery, assistenten) skickar
 * samma karta vidare. Därför får samma fack samma slutdag överallt (runda 2, R2-9).
 *
 * Samma fönster och samma regler som när formen räknas ur orderna (28 dagar t.o.m. i går,
 * @/analytics/sellout/week-shape), så svaret blir detsamma som i Att göra och larmen.
 * Körs som den inloggade (RLS): bara dagar och automater läses, inga belopp.
 */

import "server-only";

import { eq } from "drizzle-orm";
import { cache } from "react";

import { weekShapes, weekShapeStart } from "@/analytics/sellout/week-shape";
import type { WeekShare } from "@/analytics/sellout";
import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { addDays, type IsoDate } from "@/domain";
import { withUserDbFor } from "@/server/access";

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

/** Tom karta: ingen automat har en form, alla räknas med platt snitt. */
const NO_SHAPES: ReadonlyMap<string, WeekShare> = new Map();

const shapesInRequest = cache(
  (
    userId: string,
    email: string,
    orgId: string,
    today: IsoDate,
  ): Promise<ReadonlyMap<string, WeekShare>> =>
    withUserDbFor({ userId, email }, async (tx) => {
      // Dagen automaten togs i drift: en automat som startat inom fönstret får ingen form.
      const machines = await tx
        .select({ id: s.machines.id, activeFrom: s.machines.activeFrom })
        .from(s.machines)
        .where(eq(s.machines.organizationId, orgId));
      return loadWeekShapes(
        tx,
        orgId,
        today,
        machines.map((m) => ({ id: m.id, activeFrom: m.activeFrom as IsoDate | null })),
      );
    }).catch((error: unknown) => {
      // Formen är en förfining: går den inte att läsa räknar alla sidor med platt snitt
      // (fortfarande samma dag överallt), i stället för att sidan faller.
      console.error("[veckoform] Veckans form kunde inte läsas:", error);
      return NO_SHAPES;
    }),
);

/**
 * Veckans form per automat, en gång per förfrågan (React cache) som den inloggade. Det här är
 * den enda källan sidorna använder, så att Att göra, Hem, Lager, Besök, Automater och Mystery
 * nämner samma slutdag för samma fack. Alla roller (inga belopp). Fel ger en tom karta.
 */
export function weekShapesInRequest(
  viewer: {
    readonly user: { readonly userId: string; readonly email: string };
    readonly organization: { readonly id: string };
  },
  today: IsoDate,
): Promise<ReadonlyMap<string, WeekShare>> {
  return shapesInRequest(viewer.user.userId, viewer.user.email, viewer.organization.id, today);
}
