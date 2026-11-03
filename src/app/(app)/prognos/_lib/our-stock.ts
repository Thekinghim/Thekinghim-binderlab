/**
 * Vårt lager (alla egna lager tillsammans) under Prognos & inköp: rubriktexten. Ren och klientsäker.
 * Raderna räknas av Lagers vymodell (lager/_lib/model.ts, warehouse).
 */

import { formatInt } from "@/lib/format";

import { packs, plural } from "../../lager/_lib/display";
import { WAREHOUSE_LOW_DAYS, type WarehouseRow } from "../../lager/_lib/types";

/** "84 pack hemma." (ett lager) · "84 pack i lager." (alla egna lager tillsammans). */
export function ourStockTitle(rows: readonly WarehouseRow[], places = 1): string {
  const n = packs(rows.reduce((s, r) => s + Math.max(0, r.onHand), 0));
  return places > 1 ? `${n} i lager.` : `${n} hemma.`;
}

/** Andra rubrikdelen: bara det som kräver något, annars att det räcker. */
export function ourStockAside(rows: readonly WarehouseRow[]): string {
  const short = rows.filter((r) => r.shortBy > 0).length;
  const low = rows.filter((r) => r.status !== "ok").length - short;
  if (short > 0) {
    return `${plural(short, "titel räcker", "titlar räcker")} inte till veckans besök.`;
  }
  if (low > 0) {
    return `${plural(low, "titel räcker", "titlar räcker")} kortare än ${formatInt(WAREHOUSE_LOW_DAYS)} dagar.`;
  }
  return "Räcker till veckans besök.";
}
