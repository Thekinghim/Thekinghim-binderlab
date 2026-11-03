/**
 * Placeringar som beräkningarna och butiksfiltret använder. Ren funktion, utan databas.
 */

import type { IsoDate } from "@/domain";

import type { PlacementRecord } from "./types";

/**
 * Placeringarna som beräkningarna använder: en automats första placering gäller också
 * dagarna före den, tillbaka till automatens första order i `orders`.
 *
 * Automaten läggs ofta upp och placeras samma dag som den kopplas till Binderlab, medan
 * försäljningen som importeras går längre tillbaka. Utan det här hörde den
 * försäljningen inte till någon butik: butiksfiltret visade ingenting, och butiken fick
 * ingen provision på den. Samma regel som placedInStore i ./queries.ts.
 */
export function effectivePlacements(
  placements: readonly PlacementRecord[],
  orders: readonly { readonly machineId: string | null; readonly businessDate: IsoDate }[],
): PlacementRecord[] {
  const firstSale = new Map<string, IsoDate>();
  for (const o of orders) {
    if (o.machineId === null) continue;
    const seen = firstSale.get(o.machineId);
    if (seen === undefined || o.businessDate < seen) firstSale.set(o.machineId, o.businessDate);
  }
  const first = new Map<string, PlacementRecord>();
  for (const p of placements) {
    const seen = first.get(p.machineId);
    if (seen === undefined || p.from < seen.from) first.set(p.machineId, p);
  }
  return placements.map((p) => {
    const sale = firstSale.get(p.machineId);
    return first.get(p.machineId) === p && sale !== undefined && sale < p.from
      ? { ...p, from: sale }
      : p;
  });
}
