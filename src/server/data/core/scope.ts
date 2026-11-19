/**
 * Filtret på butik eller butiksägare: vilka butiker det gäller. Rena funktioner, testas i
 * scope.test.ts. En vald butik gäller just den butiken; en butiksägare alla butiker med den
 * ägaren (även arkiverade, så att deras historik räknas med), med samma regler som en vald
 * butik: butikernas andel dras och bara deras avtal räknas.
 */

import type { DataScope } from "./types";

/** Butikerna i filtret, eller null när inget butiks- eller ägarfilter är valt. */
export function scopeStoreIds(scope: DataScope): readonly string[] | null {
  if (scope.storeIds !== undefined && scope.storeIds !== null) return scope.storeIds;
  if (scope.storeId) return [scope.storeId];
  // En ägare som inte lösts upp än: inga butiker (laddaren löser upp den, resolveOwnerScope).
  if (scope.ownerId) return [];
  return null;
}

/** Sant när filtret gäller en butik eller en butiksägare (ett val av butiker). */
export function storeScoped(scope: DataScope): boolean {
  return Boolean(scope.storeId || scope.ownerId);
}

/** Sant när filtret begränsar något (butik, ägare eller automat). */
export function scopeFiltered(scope: DataScope): boolean {
  return storeScoped(scope) || Boolean(scope.machineId);
}

/** Sant när butiken ingår i filtret (alltid sant utan butiks- eller ägarfilter). */
export function storeInScope(scope: DataScope, storeId: string | null | undefined): boolean {
  const ids = scopeStoreIds(scope);
  if (ids === null) return true;
  return storeId !== null && storeId !== undefined && ids.includes(storeId);
}

/**
 * Löser upp en vald butiksägare till dess butiker (`stores` med ownerId). En vald butik
 * vinner (ägaren tas bort). Utan ägare: storeIds = [storeId] eller null.
 */
export function resolveOwnerScope(
  scope: DataScope,
  stores: ReadonlyArray<{ readonly id: string; readonly ownerId?: string | null }>,
): DataScope {
  if (scope.storeId) return { ...scope, ownerId: null, storeIds: [scope.storeId] };
  if (scope.ownerId) {
    const ownerId = scope.ownerId;
    return { ...scope, storeIds: stores.filter((s) => s.ownerId === ownerId).map((s) => s.id) };
  }
  return { ...scope, ownerId: null, storeIds: null };
}
