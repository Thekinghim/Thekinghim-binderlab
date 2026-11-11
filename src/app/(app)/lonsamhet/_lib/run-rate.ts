/**
 * "I den här takten": vinsten för hela innevarande månad om resten av månaden går som
 * dagarna hittills, eller (för de senaste 30 dagarna) takten per månad. Ren funktion; en liten egen räkning, skild från målen i analytics/goals.
 *
 * Bara för perioder som säger något om nuläget: månaden hittills eller de senaste 30
 * dagarna. En gammal eller egen period ger ingen prognos.
 */

import {
  addDays,
  daysBetween,
  monthEnd,
  monthOf,
  type IsoDate,
  type IsoMonth,
  type Period,
} from "@/domain";

/** Färre dagar med data än så här ger ingen prognos: några få dagar säger för lite. */
export const MIN_RUN_RATE_DAYS = 7;

/** Prognosen avrundas till närmaste tusenlapp (i öre). */
const THOUSAND_ORE = 100_000;

export interface RunRateInput {
  readonly period: Period;
  readonly today: IsoDate;
  /** Dagar med data i perioden (samma dagräkning som rubriken). */
  readonly days: number;
  readonly profitOre: number;
}

export interface MonthForecast {
  /** Månaden prognosen gäller: innevarande. */
  readonly month: IsoMonth;
  /** Hela månadens vinst i den här takten, avrundad till närmaste tusen kronor. */
  readonly amountOre: number;
  /**
   * Räknad på de senaste 30 dagarna, inte på månaden hittills. Då är talet takten per månad
   * (30 dagar), inte en prognos för just den här månaden: annars säger "30 dagar" och
   * "Denna månad" olika saker om samma november.
   */
  readonly rolling: boolean;
}

/** Perioden är månaden hittills (slutar i dag, i går eller vid månadens slut). */
function isCurrentMonth(period: Period, today: IsoDate): boolean {
  const month = monthOf(today);
  return (
    period.start === `${month}-01` &&
    period.end >= addDays(today, -1) &&
    period.end <= monthEnd(month)
  );
}

/** Perioden är 30 dagar som slutar i dag eller i går. */
function isRolling30(period: Period, today: IsoDate): boolean {
  return (
    daysBetween(period.start, period.end) + 1 === 30 &&
    (period.end === today || period.end === addDays(today, -1))
  );
}

export function monthForecast(input: RunRateInput): MonthForecast | null {
  const { period, today, days, profitOre } = input;
  const current = isCurrentMonth(period, today);
  if (!current && !isRolling30(period, today)) return null;
  if (!Number.isFinite(days) || days < MIN_RUN_RATE_DAYS || profitOre <= 0) return null;
  const month = monthOf(today);
  const span = current ? daysBetween(`${month}-01`, monthEnd(month)) + 1 : 30;
  const amountOre = Math.round(((profitOre / days) * span) / THOUSAND_ORE) * THOUSAND_ORE;
  return amountOre > 0 ? { month, amountOre, rolling: !current } : null;
}
