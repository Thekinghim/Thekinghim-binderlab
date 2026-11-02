/**
 * Värt att veta: 3–4 iakttagelser för en period, framräknade med regler i kod (rules.ts).
 * Varje iakttagelse har poäng för urval, en konkret text med siffror, underlag och länk.
 */

import { addDays, assertPeriod, previousPeriod, type IsoDate, type Period } from "@/domain";
import { machineNames, titleNames } from "../todos/common";
import { businessDateAt, DEFAULT_TIME_ZONE } from "../todos/time";
import { INSIGHT_RULES } from "./rules";
import type { Insight, InsightContext, InsightInput, InsightOptions } from "./types";

/** Standard: högst 4 iakttagelser. */
export const DEFAULT_MAX_INSIGHTS = 4;
/** Standard: minst 3 iakttagelser när det finns kandidater. */
export const DEFAULT_MIN_INSIGHTS = 3;

/** Perioden kortad till `lastDay`, eller `null` om den börjar efter `lastDay`. */
function clampPeriod(period: Period, lastDay: IsoDate): Period | null {
  if (period.start > lastDay) return null;
  return period.end > lastDay ? { start: period.start, end: lastDay } : period;
}

function createContext(
  input: InsightInput,
  period: Period,
  compare: Period | null | undefined,
  options: InsightOptions,
): InsightContext | null {
  assertPeriod(period);
  const requestedCompare = compare ?? previousPeriod(period);
  assertPeriod(requestedCompare);
  let effective: Period = period;
  let effectiveCompare: Period | null = requestedCompare;
  let dataEnd: IsoDate = period.end;
  if (options.now !== undefined) {
    const today = businessDateAt(options.now, options.timeZone ?? DEFAULT_TIME_ZONE);
    const lastFullDay = addDays(today, -1);
    const clamped = clampPeriod(period, lastFullDay);
    if (!clamped) return null;
    effective = clamped;
    effectiveCompare = clampPeriod(requestedCompare, lastFullDay);
    dataEnd = today;
  }
  const inRange = (p: Period | null) =>
    p ? input.orders.filter((o) => o.businessDate >= p.start && o.businessDate <= p.end) : [];
  return {
    input,
    period: effective,
    compare: effectiveCompare ?? requestedCompare,
    requestedPeriod: period,
    requestedCompare,
    dataEnd,
    orders: inRange(effective),
    compareOrders: inRange(effectiveCompare),
    titleName: titleNames(input.titles),
    machineName: machineNames(input.machines),
  };
}

const byScoreThenKey = (a: Insight, b: Insight) =>
  b.score - a.score || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * Alla kandidater från alla regler, sorterade på poäng (högst först) och sedan nyckel.
 * `compare` är jämförelseperioden; utelämnad används föregående lika långa period
 * (hel månad → föregående hela månad). Med `options.now` räknas bara hela dagar t.o.m. i går
 * (se `InsightOptions.now`).
 */
export function evaluateInsights(
  input: InsightInput,
  period: Period,
  compare?: Period | null,
  options: InsightOptions = {},
): Insight[] {
  const ctx = createContext(input, period, compare, options);
  if (!ctx) return [];
  return INSIGHT_RULES.flatMap((rule) => rule(ctx)).sort(byScoreThenKey);
}

/**
 * "Topptitel" säger samma sak som koncentration om samma titel; den visas då inte.
 */
function isRedundant(candidate: Insight, chosen: readonly Insight[]): boolean {
  if (candidate.kind !== "top-title") return false;
  const titleId = candidate.evidence.titleIds[0];
  return chosen.some((c) => c.key === `concentration:${titleId ?? ""}`);
}

/**
 * Iakttagelserna som visas, högst poäng först:
 *  1. de med högst poäng, högst en per regel (ökning och minskning räknas som olika regler,
 *     eftersom de säger olika saker om olika titlar), högst `maxCount` (standard 4);
 *  2. blir det färre än `minCount` (standard 3) fylls det på med nästa kandidat oavsett regel
 *     (t.ex. en andra stillastående automat).
 * Reglerna "intäkt i perioden" och "mest sålda titel" har låg poäng och fyller ut när få
 * andra regler slår till, så det blir 3 iakttagelser så snart perioden har försäljning av
 * minst 2 titlar och någon regel till slår till. Färre blir det bara när datan inte räcker
 * till fler sanna iakttagelser; svaga iakttagelser hittas aldrig på.
 */
export function computeInsights(
  input: InsightInput,
  period: Period,
  compare?: Period | null,
  options: InsightOptions = {},
): Insight[] {
  const max = options.maxCount ?? DEFAULT_MAX_INSIGHTS;
  const min = Math.min(options.minCount ?? DEFAULT_MIN_INSIGHTS, max);
  const candidates = evaluateInsights(input, period, compare, options);
  const seen = new Set<string>();
  const out: Insight[] = [];
  for (const insight of candidates) {
    if (out.length >= max) break;
    if (seen.has(insight.kind) || isRedundant(insight, out)) continue;
    seen.add(insight.kind);
    out.push(insight);
  }
  for (const insight of candidates) {
    if (out.length >= min) break;
    if (out.includes(insight) || isRedundant(insight, out)) continue;
    out.push(insight);
  }
  return out.sort(byScoreThenKey);
}

export {
  bestDayRule,
  compareLabel,
  concentrationRule,
  INSIGHT_RULES,
  lossTitleRule,
  periodSummaryRule,
  staleMachineRule,
  titleChangeRule,
  topTitleRule,
  weekdayPatternRule,
} from "./rules";
export type * from "./types";
