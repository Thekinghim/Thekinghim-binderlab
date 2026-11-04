/**
 * Dagar att räkna takt på ("per dag", prognoser, "per månad"), samma regel på alla sidor:
 *
 * - bara dagar med data: från första dagen med data (första ordern), aldrig dagar innan
 *   automaten fanns;
 * - aldrig i dag: dagen pågår och dess order kommer in under dagen, så den skulle dra ner
 *   snittet (en tom eller halv dag räknad som en hel).
 *
 * Både beloppet och antalet dagar ska räknas på samma dagar: summera försäljningen för
 * `measuredPeriod` och dela med `measuredDays`.
 */

import { addDays, maxDate, minDate, periodDays, type IsoDate, type Period } from "@/domain";

export interface MeasuredDaysOptions {
  /** Första dagen med data. `null` när det inte finns någon data alls. */
  readonly dataStart: IsoDate | null;
  /** Dagens affärsdatum. Räknas aldrig (dagen är inte klar). */
  readonly today: IsoDate;
}

/** Sista hela dagen: i går. */
export function lastCompleteDay(today: IsoDate): IsoDate {
  return addDays(today, -1);
}

/**
 * Hela dagar med data i perioden: från max(periodens start, första dagen med data) till
 * min(periodens slut, i går). `null` när inga sådana dagar finns.
 */
export function measuredPeriod(period: Period, options: MeasuredDaysOptions): Period | null {
  if (options.dataStart === null) return null;
  const start = maxDate(period.start, options.dataStart);
  const end = minDate(period.end, lastCompleteDay(options.today));
  return start <= end ? { start, end } : null;
}

/** Antal hela dagar med data i perioden (se measuredPeriod); 0 utan sådana dagar. */
export function measuredDays(period: Period, options: MeasuredDaysOptions): number {
  const p = measuredPeriod(period, options);
  return p ? periodDays(p) : 0;
}
