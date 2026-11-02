/**
 * Värt att veta: 3–4 iakttagelser för en period, framräknade med regler i kod (rules.ts).
 * Varje iakttagelse har poäng för urval, en konkret text med siffror, underlag och länk.
 */

import { assertPeriod, previousPeriod, type Period } from "@/domain";
import { machineNames, titleNames } from "../todos/common";
import { INSIGHT_RULES } from "./rules";
import type { Insight, InsightContext, InsightInput, InsightOptions } from "./types";

/** Standard: högst 4 iakttagelser. */
export const DEFAULT_MAX_INSIGHTS = 4;

function createContext(
  input: InsightInput,
  period: Period,
  compare: Period | null | undefined,
): InsightContext {
  assertPeriod(period);
  const cmp = compare ?? previousPeriod(period);
  assertPeriod(cmp);
  const inRange = (p: Period) =>
    input.orders.filter((o) => o.businessDate >= p.start && o.businessDate <= p.end);
  return {
    input,
    period,
    compare: cmp,
    orders: inRange(period),
    compareOrders: inRange(cmp),
    titleName: titleNames(input.titles),
    machineName: machineNames(input.machines),
  };
}

/**
 * Alla kandidater från alla regler, sorterade på poäng (högst först) och sedan nyckel.
 * `compare` är jämförelseperioden; utelämnad används föregående lika långa period
 * (hel månad → föregående hela månad).
 */
export function evaluateInsights(
  input: InsightInput,
  period: Period,
  compare?: Period | null,
): Insight[] {
  const ctx = createContext(input, period, compare);
  return INSIGHT_RULES.flatMap((rule) => rule(ctx)).sort(
    (a, b) => b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/**
 * Iakttagelserna som visas: de med högst poäng, högst en per regel (ökning och minskning
 * räknas som olika regler), högst `maxCount` (standard 4). Blir färre om färre regler slår till.
 */
export function computeInsights(
  input: InsightInput,
  period: Period,
  compare?: Period | null,
  options: InsightOptions = {},
): Insight[] {
  const max = options.maxCount ?? DEFAULT_MAX_INSIGHTS;
  const seen = new Set<string>();
  const out: Insight[] = [];
  for (const insight of evaluateInsights(input, period, compare)) {
    if (out.length >= max) break;
    if (seen.has(insight.kind)) continue;
    seen.add(insight.kind);
    out.push(insight);
  }
  return out;
}

export {
  bestDayRule,
  compareLabel,
  concentrationRule,
  INSIGHT_RULES,
  lossTitleRule,
  staleMachineRule,
  titleChangeRule,
  weekdayPatternRule,
} from "./rules";
export type * from "./types";
