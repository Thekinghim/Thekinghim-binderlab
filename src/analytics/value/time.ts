/**
 * Tid sparad: antal uppgifter som Binderlab gjort (räknade i databasen) × minuter per
 * uppgift (TASK_ASSUMPTIONS). Ren funktion.
 *
 * - Minuter per rad = antal × minuter per gång.
 * - Totalt = summan av raderna.
 * - Kronor bara med en timkostnad (Effekt → timkostnad): round(minuter × timkostnad / 60).
 *   Utan timkostnad visas bara tiden.
 */

import { mulDivRound, type IsoMonth } from "@/domain";
import { TASK_ASSUMPTIONS, type AutomationKind } from "./assumptions";

/** Antal gånger en uppgift gjorts en månad (från databasen). */
export interface AutomationCount {
  readonly month: IsoMonth;
  readonly kind: AutomationKind;
  readonly count: number;
}

export interface TimeSavedLine {
  readonly kind: AutomationKind;
  readonly label: string;
  readonly count: number;
  readonly minutesEach: number;
  readonly minutes: number;
  readonly instead: string;
  readonly unit: string;
}

export interface TimeSavedResult {
  /** En rad per uppgift i antagandenas ordning (även de med 0). */
  readonly lines: readonly TimeSavedLine[];
  readonly tasks: number;
  readonly minutes: number;
  /** Tiden i kronor, eller `null` utan timkostnad. */
  readonly valueOre: number | null;
}

/**
 * Sparad tid för de månader som räknas (`months`; alla om utelämnad).
 * `hourlyCostOre`: timkostnad i öre, eller null.
 */
export function timeSaved(
  counts: readonly AutomationCount[],
  options: { readonly months?: readonly IsoMonth[]; readonly hourlyCostOre?: number | null } = {},
): TimeSavedResult {
  const wanted = options.months ? new Set(options.months) : null;
  const byKind = new Map<AutomationKind, number>();
  for (const c of counts) {
    if (wanted && !wanted.has(c.month)) continue;
    if (!Number.isSafeInteger(c.count) || c.count < 0) {
      throw new Error(`Ogiltigt antal för ${c.kind}: ${String(c.count)}.`);
    }
    byKind.set(c.kind, (byKind.get(c.kind) ?? 0) + c.count);
  }
  const lines = TASK_ASSUMPTIONS.map((t) => {
    const count = byKind.get(t.kind) ?? 0;
    return {
      kind: t.kind,
      label: t.label,
      count,
      minutesEach: t.minutes,
      minutes: count * t.minutes,
      instead: t.instead,
      unit: t.unit,
    };
  });
  const minutes = lines.reduce((s, l) => s + l.minutes, 0);
  const tasks = lines.reduce((s, l) => s + l.count, 0);
  const hourly = options.hourlyCostOre ?? null;
  return {
    lines,
    tasks,
    minutes,
    valueOre: hourly === null || hourly <= 0 ? null : mulDivRound(minutes, hourly, 60),
  };
}

/** Sparad tid per månad (minuter), för utvecklingen. */
export function minutesByMonth(
  counts: readonly AutomationCount[],
  months: readonly IsoMonth[],
): { month: IsoMonth; minutes: number }[] {
  return months.map((month) => ({
    month,
    minutes: timeSaved(counts, { months: [month] }).minutes,
  }));
}
