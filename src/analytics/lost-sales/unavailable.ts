/**
 * Kopplingen mellan förlorad försäljning och prognosen: vilka dagar i prognosens historik
 * titeln var slutsåld i automaten, så att de inte räknas som efterfrågan 0.
 */

import type { IsoDate, OrderLine, Settings } from "@/domain";
import { forecastHistoryPeriod } from "../forecast/forecast";
import type { ForecastOptions } from "../forecast/types";
import type { MachineRef } from "../todos/types";
import { lostSales } from "./lost-sales";
import type { StockEventRef } from "./stock";
import type { LostSalesOptions, StockoutDay } from "./types";

/** Indata till `stockoutUnavailableDays`. */
export interface StockoutUnavailableInput {
  readonly orders: readonly OrderLine[];
  readonly stockEvents: readonly StockEventRef[];
  /** Prognosens utgångsdag (samma som `ForecastInput.asOf`). */
  readonly asOf: IsoDate;
  readonly settings: Settings;
  readonly machines?: readonly MachineRef[];
  /** Samma inställningar som prognosen körs med (bestämmer hur lång historiken är). */
  readonly forecastOptions?: ForecastOptions;
  /** Inställningar för hur slutsålda dagar bedöms. */
  readonly options?: LostSalesOptions;
}

/**
 * Slutsålda dagar (enligt lagret, påfyllningsdagar och troligen slutsålda enligt heuristiken)
 * för hela den historik prognosen läser (`forecastHistoryPeriod`, 98 dagar med standardvärdena).
 * Resultatet skickas som `ForecastInput.unavailable`.
 *
 * Regel: `lostSales` körs med analysperioden = prognosens historik, så att varje dag i
 * historiken bedöms (den bedömer dessutom dagarna före, för takten). Dagar utanför historiken
 * tas bort. Påfyllningsdagar tas med: titeln fanns bara en del av dagen, och dagens försäljning
 * säger därför inte vad efterfrågan var. Sorterat efter automat, titel och datum.
 */
export function stockoutUnavailableDays(input: StockoutUnavailableInput): StockoutDay[] {
  const history = forecastHistoryPeriod(input.asOf, input.forecastOptions);
  const r = lostSales({
    orders: input.orders,
    stockEvents: input.stockEvents,
    period: history,
    settings: input.settings,
    ...(input.machines ? { machines: input.machines } : {}),
    ...(input.options ? { options: input.options } : {}),
  });
  return r.stockoutDays.filter((d) => d.date >= history.start && d.date <= history.end);
}
