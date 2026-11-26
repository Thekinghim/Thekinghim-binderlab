/**
 * Pengar och Hem (G4): månadens mål och prisrådet.
 *
 * Mål: samma som Hem (expansionens mål + goalsProgress + homeGoals), organisationens
 * vinstmål i första hand. Prisråd: Lönsamhets prisråd (src/domain/price-advice.ts, målet
 * från organisationens target_margin_bp), sämsta marginalen först, med vinst per pack nu och
 * med det föreslagna priset (unitMargin: efter moms och kortavgift, före butikens andel, som
 * Lönsamhet).
 */

import "server-only";

import { unstable_rethrow } from "next/navigation";

import { monthOf, unitMargin } from "@/domain";
import {
  cachedViewState,
  loadContext,
  loadMasterData,
  requireViewer,
  type AppContext,
} from "@/server/data/core";
import { goalsProgress } from "@/server/data/goals";

import { loadGoalsFor } from "@/app/(app)/expansion/_lib/service";
import { homeGoals, type HomeGoal } from "@/app/(app)/_hem/goals";
import { loadPriceAdviceFor } from "@/app/(app)/lonsamhet/_lib/price-advice";

import { pickMoneyGoal } from "./money-model";

export interface MoneyGoal extends HomeGoal {
  /** "november". */
  readonly monthName: string;
  readonly daysLeft: number;
}

const MONTHS = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
];

export async function loadMoneyGoal(): Promise<MoneyGoal | null> {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  // Beror inte på vald period: sparad mellan förfrågningar (core/cachedViewState).
  return cachedViewState("money-goal", () => moneyGoalNow(ctx));
}

async function moneyGoalNow(ctx: AppContext): Promise<MoneyGoal | null> {
  const month = monthOf(ctx.today);
  const [records, master] = await Promise.all([
    loadGoalsFor(await requireViewer()),
    loadMasterData(),
  ]);
  const thisMonth = records.filter((g) => g.month === month);
  if (thisMonth.length === 0) return null;
  const progress = await goalsProgress(thisMonth, ctx.today, master.stores, master.machines, {
    storeShare: false,
  });
  const goal = pickMoneyGoal(homeGoals(progress, { month }));
  if (!goal) return null;
  const [y, m, d] = ctx.today.split("-").map(Number) as [number, number, number];
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { ...goal, monthName: MONTHS[m - 1] ?? month, daysLeft: daysInMonth - d };
}

export interface MoneyPriceAdvice {
  readonly titleId: string;
  readonly name: string;
  readonly salePriceOre: number;
  readonly unitCostOre: number;
  readonly suggestedPriceOre: number | null;
  readonly profitNowOre: number;
  readonly profitSuggestedOre: number | null;
  readonly marginBp: number;
  readonly targetBp: number;
  /** Fler produkter under målet. */
  readonly more: number;
}

/** Det första prisrådet (sämst marginal), eller null utan råd eller vid fel. */
export async function loadMoneyPriceAdvice(): Promise<MoneyPriceAdvice | null> {
  const ctx = await loadContext();
  const settings = ctx.settings;
  if (!ctx.canSeeEconomy || !settings) return null;
  try {
    const advice = await loadPriceAdviceFor(await requireViewer(), new Date(ctx.now));
    const first = advice.rows[0];
    if (!first) return null;
    return {
      titleId: first.titleId,
      name: first.name,
      salePriceOre: first.salePriceOre,
      unitCostOre: first.unitCostOre,
      suggestedPriceOre: first.suggestedPriceOre,
      profitNowOre: first.profitOre,
      profitSuggestedOre:
        first.suggestedPriceOre !== null
          ? unitMargin(first.suggestedPriceOre, first.unitCostOre, settings).profitOre
          : null,
      marginBp: first.marginBp,
      targetBp: advice.targetBp,
      more: advice.rows.length - 1,
    };
  } catch (error) {
    unstable_rethrow(error);
    console.error("[pengar] Prisråd kunde inte läsas:", error);
    return null;
  }
}
