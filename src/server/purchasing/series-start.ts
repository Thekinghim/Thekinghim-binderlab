/**
 * Seriernas första dag i automaten ur lagerhändelserna, som indata till prognosen
 * (`seriesStarts` i @/analytics/forecast). Ren funktion: väljer bara indata, räknar inga
 * belopp. Saldot dag för dag kommer från `replayStockDaily` i @/analytics/lost-sales.
 *
 * Regel: serien börjar första dagen då titeln bevisligen fanns i automaten, dvs. känt
 * saldo över 0 vid dagens början eller slut, eller ett inflöde (påfyllning, inventering
 * som höjde saldot). Före det är saldot okänt eller 0 och dagen räknas inte.
 *
 * `dataStart` är första dagen med orderdata (t.ex. första importerade ordern). En start
 * före den flyttas fram dit: dagar utan orderdata får inte räknas som försäljning 0.
 */

import { replayStockDaily, type StockEventRef } from "@/analytics/lost-sales";
import { assortmentKey, retiredPairs, type SlotPeriod } from "@/analytics/todos/assortment";
import type { SeriesStart } from "@/analytics/forecast/types";
import type { IsoDate } from "@/domain";

export function seriesStartsFromStock(
  events: readonly StockEventRef[],
  end: IsoDate,
  dataStart: IsoDate | null = null,
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
    if (!first) continue;
    const date = dataStart !== null && first.date < dataStart ? dataStart : first.date;
    out.push({ machineId: series.machineId, titleId: series.titleId, date });
  }
  return out;
}

/**
 * Par (automat, titel) som gått ur sortimentet i dag (samma regel som Lager, `retiredPairs`),
 * som indata till prognosen (`excludeSeries`): de får ingen prognos och köps inte in.
 */
export function retiredSeries(
  periods: readonly SlotPeriod[],
  today: IsoDate,
): { machineId: string; titleId: string }[] {
  const retired = retiredPairs(periods, today);
  const out = new Map<string, { machineId: string; titleId: string }>();
  for (const p of periods) {
    const k = assortmentKey(p.machineId, p.titleId);
    if (retired.has(k)) out.set(k, { machineId: p.machineId, titleId: p.titleId });
  }
  return [...out.values()];
}
