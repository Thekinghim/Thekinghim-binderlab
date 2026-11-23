/**
 * Inköpspriser som hylla (visuellt): vilka rutor som saknar pris och i vilken ordning de står.
 * Bara presentation av tabellens rader (./model.ts). Ren.
 *
 * - Saknar pris: inget pris i dag (status missing) eller order i perioden utan pris på sin
 *   dag. De står först, flest order utan pris först.
 * - Övriga: flest order först, sedan namn. Arkiverade titlar utan order står sist.
 */

import { formatInt, NBSP } from "@/lib/format";

import type { TitleRow } from "./model";

export interface PriceTileState {
  readonly missing: boolean;
  /** "41 order utan vinst" · "Egen, ny" · "Inget pris". */
  readonly note: string;
}

export function shelfPriceState(r: TitleRow): PriceTileState {
  const missing = r.status === "missing" || r.unpricedOrders > 0;
  if (!missing) return { missing, note: "" };
  if (r.unpricedOrders > 0) {
    return { missing, note: `${formatInt(r.unpricedOrders)}${NBSP}order utan vinst` };
  }
  return { missing, note: r.own ? "Egen, ny" : "Inget pris" };
}

export function shelfPriceOrder(rows: readonly TitleRow[]): TitleRow[] {
  const rank = (r: TitleRow) =>
    shelfPriceState(r).missing ? 0 : r.archived && r.orders === 0 ? 2 : 1;
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      b.unpricedOrders - a.unpricedOrders ||
      b.orders - a.orders ||
      a.name.localeCompare(b.name, "sv"),
  );
}
