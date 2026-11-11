/**
 * Laddaren för inventeringssidan: de egna lagren med "Senast inventerad", och produkterna
 * med vad appen tror per lager. Samma roller, rader och ordning som Vårt lager
 * (loadVartLagerFor); bara ägare och admin får spara.
 */

import "server-only";

import { stockCountAge } from "@/analytics/todos";
import { withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { queryStockCountRefs } from "@/server/data/core/stock-counts";

import { loadVartLagerFor } from "../../_lib/data";
import type { CountPlace, CountRow } from "./model";

export interface StockCountView {
  readonly places: CountPlace[];
  readonly rows: CountRow[];
  /** Ägare och admin (och det finns ett eget lager). */
  readonly canEdit: boolean;
  readonly hasWarehouse: boolean;
}

/** "Senast inventerad" per eget lager (aktiva lager, standardlagret först). */
export async function loadCountPlacesFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<CountPlace[]> {
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);
  const refs = await withUserDbFor(viewer.user, (tx) =>
    queryStockCountRefs(tx, viewer.organization.id),
  );
  return refs.map((r) => {
    const age = stockCountAge(r, today, timeZone);
    return {
      id: r.placeId,
      name: r.name,
      lastCountedAt: r.lastCountedAt,
      daysSince: age.daysSince,
      overdue: age.overdue,
    };
  });
}

export async function loadStockCountFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<StockCountView> {
  // loadVartLagerFor kontrollerar rollen (ägare, admin, läsare) mot databasen.
  const view = await loadVartLagerFor(viewer, now);
  const counted = new Map((await loadCountPlacesFor(viewer, now)).map((p) => [p.id, p]));
  return {
    places: view.places.map(
      (p) =>
        counted.get(p.id) ?? {
          id: p.id,
          name: p.name,
          lastCountedAt: null,
          daysSince: null,
          overdue: false,
        },
    ),
    rows: view.rows.map((r) => ({ titleId: r.titleId, name: r.name, byPlace: r.byPlace })),
    canEdit: view.canEdit,
    hasWarehouse: view.hasWarehouse,
  };
}
