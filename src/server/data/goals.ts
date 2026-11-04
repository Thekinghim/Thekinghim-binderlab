/**
 * Mål: utfall och prognos för sparade mål (goalProgress i @/analytics/goals) med order
 * från de memoiserade laddarna. Delas av Expansion (fliken Mål) och Hem (Mål i {månad}).
 */

import "server-only";

import {
  goalProgress,
  type GoalMetric,
  type GoalProgress,
  type GoalScope,
} from "@/analytics/goals";
import {
  addDays,
  maxDate,
  minDate,
  monthEnd,
  monthStart,
  type IsoDate,
  type IsoMonth,
} from "@/domain";

import { loadDataStart, loadDomainInput } from "./core";

/** Ett sparat mål (som GoalRecord i Expansion). `month` är 'ÅÅÅÅ-MM'. */
export interface GoalRow {
  readonly id: string;
  readonly month: string;
  readonly metric: GoalMetric;
  readonly scope: GoalScope;
  readonly storeId: string | null;
  readonly machineId: string | null;
  readonly target: number;
}

type Named = readonly { id: string; name: string }[];

/**
 * Utfall och prognos per mål (laddar order för målens månader och 28 dagar bakåt, för
 * hela organisationen). Utan `stores`/`machines` tas namnen från de inlästa grunddata.
 */
export async function goalsProgress(
  goals: readonly GoalRow[],
  today: IsoDate,
  stores?: Named,
  machines?: Named,
): Promise<GoalProgress[]> {
  if (goals.length === 0) return [];
  let start: IsoDate = addDays(today, -27);
  let end: IsoDate = today;
  for (const g of goals) {
    start = minDate(start, monthStart(g.month as IsoMonth));
    end = maxDate(end, monthEnd(g.month as IsoMonth));
  }
  const [input, dataStart] = await Promise.all([
    loadDomainInput({ period: { start, end: minDate(end, today) } }),
    loadDataStart(),
  ]);
  return goalProgress({
    ...input.current,
    goals: goals.map((g) => ({
      id: g.id,
      month: g.month as IsoMonth,
      metric: g.metric,
      target: g.target,
      scope: g.scope,
      storeId: g.storeId,
      machineId: g.machineId,
    })),
    asOf: today,
    // Samma dagregel som övriga sidor: bara hela dagar med data (i dag och dagar före
    // första ordern räknas inte), se @/analytics/days.
    today,
    dataStart,
    stores: stores ?? input.stores,
    machines: machines ?? input.machines,
  });
}
