/**
 * Filtret i adressen (?butik, ?agare, ?automat) för punkterna i Att göra, gemensamt för Att göra
 * och Hem så att de alltid visar samma punkter:
 *
 *   punkter med automater    → visas om någon av automaterna matchar (automaten, och/eller
 *                              står i butiken enligt `machines`)
 *   punkter om en butik      → (avtal, rapport till en butik) följer butiken; med bara
 *                              automatfilter gäller automatens butik
 *   övriga                   → (inköpspris, dubbletter, rapporter till revisor) gäller hela
 *                              organisationen och visas alltid
 */

import type { TodoItem } from "./types";

export interface TodoScope {
  readonly storeId: string | null;
  readonly machineId: string | null;
  /**
   * Butikerna i filtret när en butiksägare är vald (alla ägarens butiker). Utelämnad eller
   * null: bara `storeId`.
   */
  readonly storeIds?: readonly string[] | null;
}

/** Automaten och butiken den står i nu (null = inte placerad). */
export interface ScopeMachine {
  readonly id: string;
  readonly storeId: string | null;
}

export function todoInScope(
  item: Pick<TodoItem, "evidence">,
  scope: TodoScope,
  machines: readonly ScopeMachine[],
): boolean {
  const { machineId } = scope;
  const stores = scope.storeIds ?? (scope.storeId ? [scope.storeId] : null);
  if (!stores && !machineId) return true;
  const storeOf = (id: string) => machines.find((m) => m.id === id)?.storeId ?? null;
  const inStores = (store: string | null) => store !== null && (stores ?? []).includes(store);
  const ids = item.evidence.machineIds;
  if (ids.length > 0) {
    return ids.some((id) => (!machineId || id === machineId) && (!stores || inStores(storeOf(id))));
  }
  if (item.evidence.storeIds.length > 0) {
    if (stores) return item.evidence.storeIds.some((st) => stores.includes(st));
    const store = machineId ? storeOf(machineId) : null;
    return store !== null && item.evidence.storeIds.includes(store);
  }
  return true;
}
