/**
 * Mål i {månad} på Hem: månadens mål (goalProgress) urvalda efter skalets filter och
 * omgjorda till serialiserbara kort. Ren funktion, utan Next.
 */

import type { GoalMetric, GoalProgress, GoalScope, GoalStatus } from "@/analytics/goals";

/** Högst så många mål på Hem; resten finns i Expansion. */
export const HOME_GOALS_MAX = 3;

const METRIC_ORDER: Record<GoalMetric, number> = { revenue: 0, profit: 1, active_machines: 2 };
const SCOPE_ORDER: Record<GoalScope, number> = { organization: 0, store: 1, machine: 2 };

export const GOAL_METRIC_LABEL: Record<GoalMetric, string> = {
  revenue: "Intäkt",
  profit: "Vinst",
  active_machines: "Automater i drift",
};

export interface HomeGoal {
  readonly id: string;
  readonly metric: GoalMetric;
  readonly label: string;
  /** Butikens eller automatens namn, null för organisationen. */
  readonly scopeName: string | null;
  readonly unit: "ore" | "count";
  readonly actual: number;
  readonly target: number;
  readonly forecast: number;
  /** Utfall / mål i bp, klämt till 0–10 000 (mål ≤ 0: 10 000 när det är nått, annars 0). */
  readonly barBp: number;
  /** Prognos / mål i bp, klämt till 0–10 000, eller null (prognosmarkering visas inte). */
  readonly forecastBp: number | null;
  readonly status: GoalStatus;
  /** Behov per återstående dag (öre), eller null när det inte ska visas. */
  readonly requiredPerDay: number | null;
}

/** Skalets filter för Hem. `machineStoreId` = butiken automaten i filtret står i. */
export interface HomeGoalScope {
  readonly month: string;
  readonly storeId?: string | null;
  readonly machineId?: string | null;
  readonly machineStoreId?: string | null;
}

type Named = readonly { id: string; name: string }[];

function clampBp(value: number, target: number): number {
  // Mål ≤ 0 (t.ex. vinst ≥ 0): fullt när det är nått, annars tomt.
  if (target <= 0) return value >= target ? 10_000 : 0;
  return Math.max(0, Math.min(10_000, Math.round((value * 10_000) / target)));
}

function inScope(g: GoalProgress, scope: HomeGoalScope): boolean {
  if (g.scope === "organization") return true;
  if (scope.machineId) {
    if (g.scope === "machine") return g.scopeId === scope.machineId;
    return Boolean(scope.machineStoreId) && g.scopeId === scope.machineStoreId;
  }
  if (scope.storeId) return g.scope === "store" && g.scopeId === scope.storeId;
  return true;
}

/**
 * Månadens mål för Hem: bara målen för `scope.month`, i filtret (butik: organisationen och
 * butiken; automat: organisationen, automaten och dess butik), organisationens först och
 * sedan efter mått (intäkt, vinst, automater i drift). Högst tre.
 */
export function homeGoals(
  progress: readonly GoalProgress[],
  scope: HomeGoalScope,
  names: { stores?: Named; machines?: Named } = {},
): HomeGoal[] {
  const storeName = new Map((names.stores ?? []).map((s) => [s.id, s.name]));
  const machineName = new Map((names.machines ?? []).map((m) => [m.id, m.name]));
  return progress
    .filter((g) => g.month === scope.month && inScope(g, scope))
    .sort(
      (a, b) =>
        SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] ||
        METRIC_ORDER[a.metric] - METRIC_ORDER[b.metric] ||
        a.goalId.localeCompare(b.goalId),
    )
    .slice(0, HOME_GOALS_MAX)
    .map((g) => {
      const money = g.metric !== "active_machines";
      const scopeName =
        g.scope === "store"
          ? (storeName.get(g.scopeId ?? "") ?? "Okänd butik")
          : g.scope === "machine"
            ? (machineName.get(g.scopeId ?? "") ?? "Okänd automat")
            : null;
      const done = g.status === "met" || g.status === "missed";
      return {
        id: g.goalId,
        metric: g.metric,
        label: GOAL_METRIC_LABEL[g.metric],
        scopeName,
        unit: money ? "ore" : "count",
        actual: g.actual,
        target: g.target,
        forecast: g.forecast,
        barBp: clampBp(g.actual, g.target),
        forecastBp: done || g.target <= 0 ? null : clampBp(g.forecast, g.target),
        status: g.status,
        requiredPerDay:
          money && !done && g.requiredPerDay !== null && g.requiredPerDay > 0
            ? g.requiredPerDay
            : null,
      } satisfies HomeGoal;
    });
}
