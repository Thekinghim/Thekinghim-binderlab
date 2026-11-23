/**
 * Orderlistans sortering i webbläsaren: kolumnrubrikernas klickordning och samma ordning som
 * servern (queries.ts orderBy) när alla rader redan är laddade. Rent och klientsäkert.
 */

import { DEFAULT_SORT, type OrderSort, type OrderSortKey } from "./params";
import { rankMap } from "./refs";
import type { OrderRefs, OrderRow } from "./types";

/**
 * Klick på en kolumnrubrik: första klicket sorterar (namn stigande, belopp och nummer
 * fallande), andra vänder, tredje går tillbaka till nyaste först.
 */
export function nextSortFor(cur: OrderSort, key: OrderSortKey): OrderSort {
  const first: OrderSort = { key, dir: key === "belopp" || key === "nr" ? "desc" : "asc" };
  if (cur.key !== key) return first;
  if (cur.dir === first.dir) return { key, dir: first.dir === "asc" ? "desc" : "asc" };
  return DEFAULT_SORT;
}

/** Serverns ordning för lika värden: nyaste först, sedan id fallande. */
function tieBreak(a: OrderRow, b: OrderRow): number {
  if (a.orderedAt !== b.orderedAt) return a.orderedAt < b.orderedAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/**
 * Sorterar laddade rader som servern (queries.ts orderBy): samma rangordning för namn, null
 * sist, lika värden nyaste först. Används när allt redan är laddat.
 */
export function sortRows(rows: readonly OrderRow[], sort: OrderSort, refs: OrderRefs): OrderRow[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  const ranks = {
    titel: rankMap(refs.titles),
    automat: rankMap(refs.machines),
    butik: rankMap(refs.stores),
  };
  const ranked = (m: Map<string, number>, id: string | null) =>
    id === null ? null : (m.get(id) ?? null);
  const value = (r: OrderRow): number | string | null => {
    switch (sort.key) {
      case "tid":
        return r.orderedAt;
      case "nr":
        // Kortare nummer är mindre (som serverns length + text).
        return r.externalId.padStart(32, "0");
      case "belopp":
        return r.amountOre;
      case "titel":
        return ranked(ranks.titel, r.titleId);
      case "automat":
        return ranked(ranks.automat, r.machineId);
      case "butik":
        return ranked(ranks.butik, r.storeId);
    }
  };
  return [...rows].sort((a, b) => {
    const va = value(a);
    const vb = value(b);
    if (va !== vb) {
      if (va === null) return 1;
      if (vb === null) return -1;
      return (va < vb ? -1 : 1) * sign;
    }
    if (sort.key === "tid") return (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) * sign;
    return tieBreak(a, b);
  });
}
