/**
 * Seriernas första dag i automaten ur lagerhändelserna, som indata till prognosen
 * (`seriesStarts` i @/analytics/forecast). Ren funktion: väljer bara indata, räknar inga
 * belopp. Saldot dag för dag kommer från `replayStockDaily` i @/analytics/lost-sales.
 *
 * Regel: serien börjar första dagen då titeln bevisligen fanns i automaten, dvs. känt
 * saldo över 0 vid dagens början eller slut, eller ett inflöde (påfyllning, inventering
 * som höjde saldot). Före det är saldot okänt eller 0 och dagen räknas inte.
 */

import { replayStockDaily, type StockEventRef } from "@/analytics/lost-sales";
import type { SeriesStart } from "@/analytics/forecast/types";
import type { IsoDate } from "@/domain";

export function seriesStartsFromStock(
  events: readonly StockEventRef[],
  end: IsoDate,
): SeriesStart[] {
  const out: SeriesStart[] = [];
  for (const series of replayStockDaily(events, end)) {
    if (series.machineId === null) continue;
    const first = series.days.find(
      (d) =>
        d.inflow > 0 ||
        (d.opening !== null && d.opening > 0) ||
        (d.closing !== null && d.closing > 0),
    );
    if (first) out.push({ machineId: series.machineId, titleId: series.titleId, date: first.date });
  }
  return out;
}
