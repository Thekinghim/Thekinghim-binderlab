/**
 * Butiksägarna som kan få en rapport per butik i ett svep: aktiva ägare med minst två
 * butiker bland periodens butiker (de som hade en automat). Ren funktion, testas i
 * owner-choices.test.ts.
 */

import { ownerChoices } from "@/components/shell/owner-filter";

import type { OwnerReportChoice } from "../_components/owner-reports";

export function ownerReportChoices(
  owners: ReadonlyArray<{ id: string; name: string; archived: boolean }>,
  stores: ReadonlyArray<{ id: string; ownerId?: string | null; archived: boolean }>,
  periodStores: ReadonlyArray<{ id: string; name: string }>,
): OwnerReportChoice[] {
  const inPeriod = new Map(periodStores.map((s) => [s.id, s.name]));
  return ownerChoices(owners, stores)
    .map((o) => ({
      id: o.id,
      name: o.name,
      stores: o.storeIds.flatMap((id) => {
        const name = inPeriod.get(id);
        return name === undefined ? [] : [{ id, name }];
      }),
    }))
    .filter((o) => o.stores.length > 1);
}
