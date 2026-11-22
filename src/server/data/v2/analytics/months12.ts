/**
 * Pengar (G4): vinst per automat och månad, i kronor per dag i tjänst, de senaste 12
 * månaderna (den pågående inräknad). Per månad räknar enhetsekonomin (compareUnitEconomics,
 * samma som Enhetsekonomi och rangordningen) vinsten och de aktiva dagarna; tabellen delar
 * dem. Hela organisationen, alla aktiva automater. Används av sidan och CSV-exporten.
 */

import "server-only";

import { compareUnitEconomics } from "@/analytics/expansion/unit-economics-compare";
import { addDays, maxDate, minDate, monthEnd, monthOf, monthStart, type IsoDate } from "@/domain";

import { loadMoneyYear, loadMoneyYearWith, type MoneyYear } from "./money-base";
import type { PageLoaders } from "@/server/data/page-loaders";
import { monthTable, type MonthSlice, type MonthTable } from "./money-model";

export async function loadMoneyMonths(): Promise<MonthTable | null> {
  const year = await loadMoneyYear();
  return year ? monthTableOf(year) : null;
}

/** Med givna laddare (testerna). */
export async function loadMoneyMonthsWith(
  loaders: Pick<PageLoaders, "context" | "period" | "domainInput">,
): Promise<MonthTable> {
  return monthTableOf(await loadMoneyYearWith(loaders));
}

/** Tabellen ur årets indata (en enhetsekonomi per månad). */
export function monthTableOf(year: MoneyYear): MonthTable {
  const { input, today, start } = year;
  const machines = input.machines
    .filter((m) => !m.archived)
    .map((m) => ({ id: m.id, code: m.code || m.name, name: m.name }));
  const machineIds = machines.map((m) => m.id);

  const slices: MonthSlice[] = [];
  let cursor: IsoDate = start;
  while (cursor <= today) {
    const month = monthOf(cursor);
    const sliceStart = maxDate(monthStart(month), start);
    const sliceEnd = minDate(monthEnd(month), today);
    const result = compareUnitEconomics(
      {
        ...input.current,
        period: { start: sliceStart, end: sliceEnd },
        investments: input.investments,
        machineIds,
      },
      machines.map((m) => ({ id: m.id, name: m.name })),
      { lastDataDay: sliceEnd },
    );
    slices.push({
      month,
      start: sliceStart,
      end: sliceEnd,
      running: sliceEnd >= today && monthEnd(month) > today,
      rows: result.rows.map((r) => ({
        machineId: r.machineId,
        profitOre: r.profitOre,
        activeDays: r.activeDays,
      })),
    });
    cursor = addDays(monthEnd(month), 1);
  }
  return monthTable(slices, machines);
}
