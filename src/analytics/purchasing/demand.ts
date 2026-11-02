/**
 * Efterfrågan för inköpsplaneringen ur försäljningsprognosen.
 */

import { assertIsoDate, daysBetween, DomainError, type IsoDate } from "@/domain";
import type { ForecastResult } from "../forecast/types";
import type { TitleDemand } from "./types";

/**
 * Efterfrågan per titel från prognosens summa per titel (alla automater). Dag 0 är `today`
 * (standard: prognosens första dag). Ligger `today` senare hoppas de passerade dagarna över;
 * dagsvariansen är summan av seriernas varianser.
 */
export function demandFromForecast(
  forecast: ForecastResult,
  today: IsoDate = forecast.horizon.start,
): TitleDemand[] {
  assertIsoDate(today, "Dagen för planen");
  const skip = daysBetween(forecast.horizon.start, today);
  if (skip < 0) {
    throw new DomainError(
      "invalid_input",
      `Prognosen börjar ${forecast.horizon.start}, efter planens dag ${today}. Gör om prognosen.`,
    );
  }
  return forecast.byTitle.map((t) => ({
    titleId: t.key,
    dailyMilli: t.days.slice(skip).map((d) => d.unitsMilli),
    dayVarianceMilli2: t.dayVarianceMilli2,
  }));
}
