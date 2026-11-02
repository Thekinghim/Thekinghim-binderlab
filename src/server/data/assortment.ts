/**
 * Sortimentets perioder per automat och titel, för regeln om utgångna titlar
 * (@/analytics/todos/assortment). Lager, Drift och Att göra läser alla härifrån, så att
 * de är överens om vad som ska fyllas på.
 *
 * Läses via RPC:n `lager_slot_periods` (security definer, alla roller): `machine_slots`
 * får påfyllaren inte läsa direkt, men alla roller behöver veta vilka titlar som gått ur
 * sortimentet. Bara automat, titel och datum. Som användaren med RLS.
 */

import "server-only";

import { sql } from "drizzle-orm";

import {
  retiredPairs,
  withoutRetiredRefills,
  type SlotPeriod,
  type TodoItem,
} from "@/analytics/todos";
import type { Tx } from "@/db/client";
import type { IsoDate } from "@/domain";
import { withUserDbFor } from "@/server/access";

import type { TodoState, Viewer } from "./core/loaders";

export type { SlotPeriod };

/** Sortimentets perioder för organisationen, i en transaktion som användaren. */
export async function querySlotPeriods(tx: Tx, orgId: string): Promise<SlotPeriod[]> {
  const result = await tx.execute(
    sql`select machine_id::text as machine_id, title_id::text as title_id,
               valid_from::text as valid_from, valid_to::text as valid_to
        from public.lager_slot_periods(${orgId}::uuid)`,
  );
  return (
    Array.from(result) as {
      machine_id: string;
      title_id: string;
      valid_from: string;
      valid_to: string | null;
    }[]
  ).map((r) => ({
    machineId: r.machine_id,
    titleId: r.title_id,
    validFrom: r.valid_from as IsoDate,
    validTo: (r.valid_to ?? null) as IsoDate | null,
  }));
}

/** Sortimentets perioder som användaren (alla roller). */
export function loadSlotPeriodsFor(viewer: Viewer): Promise<SlotPeriod[]> {
  return withUserDbFor(viewer.user, (tx) => querySlotPeriods(tx, viewer.organization.id));
}

/**
 * Att göra utan påfyllningar av utgångna titlar, för listan, Hem och menyns räknare.
 *
 * Regeln finns också i @/analytics/todos (refillTodos hoppar över utgångna par när
 * `TodoInput.slotPeriods` är satt). Här tillämpas den på punkterna från laddaren, så att
 * Att göra är överens med Lager och Drift även innan laddaren skickar med sortimentet.
 */
export function withoutRetired<T extends TodoItem>(
  items: readonly T[],
  periods: readonly SlotPeriod[],
  today: IsoDate,
): T[] {
  return withoutRetiredRefills(items, retiredPairs(periods, today));
}

/** Som `withoutRetired`, för både punkterna och de avbockade. */
export function todoStateWithoutRetired(
  state: TodoState,
  periods: readonly SlotPeriod[],
  today: IsoDate,
): TodoState {
  const retired = retiredPairs(periods, today);
  if (retired.size === 0) return state;
  return {
    items: withoutRetiredRefills(state.items, retired),
    dismissed: withoutRetiredRefills(state.dismissed, retired),
  };
}
