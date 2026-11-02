/**
 * Förlorad försäljning: när en titel varit slutsåld i en automat och vad det kostade.
 * Lagersaldot räknas ur lagerhändelserna (stock.ts); när saldot är okänt används en
 * heuristik på försäljningen (lost-sales.ts).
 */

export { lostSales, LOST_SALES_DEFAULTS } from "./lost-sales";
export { stockoutUnavailableDays, type StockoutUnavailableInput } from "./unavailable";
export {
  compareStockEvents,
  replayStockDaily,
  stockKey,
  stockLevels,
  type DailyStock,
  type StockEventKind,
  type StockEventRef,
  type StockLevel,
  type StockSeries,
} from "./stock";
export type * from "./types";
