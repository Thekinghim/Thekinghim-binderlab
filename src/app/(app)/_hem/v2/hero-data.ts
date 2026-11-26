/**
 * Hems hjältekort (mockarna i "visuellt/02"): periodens vinst med dagsserie, pallen med de
 * tre mest sålda titlarna och månadens mål som ring, plus resten av KPI-bandet kompakt under.
 *
 * Bara läsning ur befintliga laddare: KPI-bandet (loadKpiBand), Hems nyckeltal (vinstens
 * jämförelse), Lönsamhets dagsserie (samma som Resultat och Pengar), Mest sålda
 * (loadTopCard) och månadens mål (loadMoneyGoal). Förra periodens vinst per dag räknas med
 * samma profitability() som bandets "Vinst i dag", dag för dag på jämförelsens order.
 *
 * Bara ekonomiroller: påfyllaren får null (laddarna ger inget belopp till den rollen).
 */

import "server-only";

import {
  compareText,
  periodNameInline,
  type SearchParamsInput,
} from "@/components/shell/period-state";
import { middleOut } from "@/components/v2/empty";
import { profitability } from "@/domain";
import { loadContext, loadPeriod } from "@/server/data/core";
import { hemKey, loadHemCore, loadHemProfit } from "@/server/data/v2/analytics/hem-base";
import { loadMoneyGoal } from "@/server/data/v2/analytics/goal";
import { loadKpiBand, type KpiBandTile } from "@/server/data/v2/analytics/kpi-band";

import { loadTopCard } from "./cards-data";
import {
  aheadText,
  axisLabels,
  goalPace,
  monthDay,
  revenueBasisNote,
  splitKpis,
} from "./hero-model";

export interface HeroProfit {
  readonly label: string;
  readonly value: number;
  readonly deltaBp: number | null;
  /** Skillnaden i kronor mot jämförelsen (öre), eller null. */
  readonly deltaOre: number | null;
  /** "mot förra 30 dagarna", "mot i går". */
  readonly compareText: string | null;
  readonly href: string;
}

export interface HeroSpark {
  readonly current: number[];
  readonly previous: number[] | null;
  /** Första, mittersta och sista dagens etikett ("25 okt"). */
  readonly axis: string[];
  /** "Vinst per dag" / "Vinst hittills i dag". */
  readonly name: string;
}

export interface HeroGoal {
  readonly id: string;
  readonly monthName: string;
  /** "vinst", "intäkt". */
  readonly label: string;
  readonly unit: "ore" | "count";
  readonly actual: number;
  readonly target: number;
  readonly forecast: number;
  readonly pace: number | null;
  readonly behind: number;
  readonly requiredPerDay: number | null;
  readonly daysLeft: number;
  readonly reached: boolean;
  /** Månadens sista dag, "30 nov" (prognosen gäller den). */
  readonly endText: string;
  /** "2026-11". */
  readonly month: string;
}

export interface HemHeroData {
  readonly periodName: string;
  readonly profit: HeroProfit | null;
  readonly spark: HeroSpark | null;
  readonly top: readonly { readonly name: string; readonly orders: number }[];
  readonly topHref: string;
  readonly goal: HeroGoal | null;
  readonly kpis: readonly KpiBandTile[];
  /** Fotnot under nyckeltalen (intäktens grund), eller null. */
  readonly kpiNote: string | null;
}

/**
 * Förra periodens vinst per dag (öre), räknad som den nuvarande linjen: en enda
 * dagsuppdelning för hela perioden (fasta kostnader och hyra fördelas på samma sätt).
 */
function previousDaily(prev: Parameters<typeof profitability>[0] | null): number[] | null {
  if (!prev) return null;
  const rows = profitability(prev, "day")
    .rows.filter((r) => r.kind === "time")
    .map((r) => ({ start: r.range?.start ?? r.key, profitOre: r.profitOre }))
    .sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  if (rows.length < 2 || rows.length > 62) return null;
  return rows.map((r) => r.profitOre);
}

export async function loadHemHero(sp: SearchParamsInput): Promise<HemHeroData | null> {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  const key = hemKey(sp);
  const [tiles, home, money, p, top, goal] = await Promise.all([
    loadKpiBand(sp),
    loadHemCore(key),
    loadHemProfit(key),
    loadPeriod(sp),
    loadTopCard(sp).catch((error: unknown) => {
      console.error("[hem] Mest sålda kunde inte läsas:", error);
      return null;
    }),
    loadMoneyGoal().catch((error: unknown) => {
      console.error("[hem] Månadens mål kunde inte läsas:", error);
      return null;
    }),
  ]);
  if (!tiles) return null;
  const { hero, rest } = splitKpis(tiles);
  const isToday = p.key === "idag";

  // Vinsten: bandets första ruta (perioden, eller i dag med "I dag").
  const profitKpi = home?.model.kpis.find((k) => k.id === "profit");
  const deltaOre =
    !isToday && profitKpi?.value != null && profitKpi.previous != null
      ? profitKpi.value - profitKpi.previous
      : null;
  const profit: HeroProfit | null = hero
    ? {
        label: hero.label,
        value: hero.value ?? 0,
        deltaBp: hero.deltaBp,
        deltaOre,
        compareText: isToday ? hero.compare : (compareText(p.resolved) ?? hero.compare),
        href: hero.href,
      }
    : null;

  // Dagsserien: Lönsamhets dagar (samma som Resultat); med "I dag" vinsten hittills per timme.
  let spark: HeroSpark | null = null;
  const days = money?.model.trend.day.buckets ?? [];
  if (isToday) {
    const hourly = hero?.trend ?? [];
    if (hourly.length >= 2) {
      spark = {
        current: [...hourly],
        previous: null,
        axis: ["00", "", String(hourly.length - 1).padStart(2, "0")],
        name: "Vinst hittills i dag",
      };
    }
  } else if (days.length >= 2 && days.length <= 62) {
    spark = {
      current: days.map((b) => b.profitOre),
      previous: previousDaily(money?.input.previous ?? null),
      axis: axisLabels(days.map((b) => b.axis)),
      name: "Vinst per dag",
    };
  }

  // Månadens mål (organisationens vinst- eller intäktsmål).
  let heroGoal: HeroGoal | null = null;
  if (goal) {
    const { day, daysInMonth } = monthDay(ctx.today);
    const { pace, behind } = goalPace(goal.actual, goal.target, day, daysInMonth);
    heroGoal = {
      id: goal.id,
      monthName: goal.monthName,
      label: goal.label.toLowerCase(),
      unit: goal.unit,
      actual: goal.actual,
      target: goal.target,
      forecast: goal.forecast,
      pace,
      behind,
      requiredPerDay: goal.requiredPerDay,
      daysLeft: goal.daysLeft,
      reached: goal.status === "met" || (goal.target > 0 && goal.actual >= goal.target),
      endText: `${daysInMonth} ${goal.monthName.slice(0, 3)}`,
      month: ctx.today.slice(0, 7),
    };
  }

  return {
    periodName: periodNameInline(p.resolved),
    profit,
    spark,
    top: (top ?? []).slice(0, 3).map((t) => ({ name: t.name, orders: t.orders })),
    topHref: "/lonsamhet?vy=titel",
    goal: heroGoal,
    kpis: rest,
    // Intäkten i nyckeltalen är Lönsamhets (order med inköpspris); resten räknar alla order.
    kpiNote: revenueBasisNote(money?.model.bridge.unpricedRevenueOre ?? 0),
  };
}

/**
 * Underlaget för firandet när månadens mål är nått: de mest sålda titlarna i månaden (för
 * solfjädern och "X drog mest") och texten om hur tidigt det gick. Bara för ägaren.
 */
export async function loadGoalCelebration(
  goal: HeroGoal,
): Promise<{ titles: string[]; top: string | null; ahead: string } | null> {
  const ctx = await loadContext();
  if (ctx.role !== "owner" || !goal.reached) return null;
  const month = await loadTopCard({ period: "manad" }).catch(() => null);
  const ranked = (month ?? []).slice(0, 5).map((t) => t.name);
  return {
    // Solfjäderns ordning: mest såld i mitten (som i tomma lägen).
    titles: middleOut(ranked),
    top: ranked[0] ?? null,
    ahead: aheadText(goal.daysLeft),
  };
}
