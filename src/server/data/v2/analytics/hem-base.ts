/**
 * Gemensamma laddare för Hem i V2 (G1). Korten på Hem strömmar var för sig (Suspense), men
 * läser samma memoiserade underlag en gång per förfrågan: Hems modell (_hem/load.ts, samma som
 * gamla Hem), Lönsamhets modell (samma tal som /lonsamhet) och Vårt lagers lista. React
 * `cache` jämför argumenten med ===, så sökparametrarna skickas som en sträng.
 *
 * Bara roller som ser ekonomi (ägare, admin, läsare). Påfyllaren får null från varje laddare
 * och läser aldrig order (RLS), se byggplanen avsnitt 6.
 */

import "server-only";

import { cache } from "react";

import { loadContext, requireViewer } from "@/server/data/core";

import { loadMoneyProfit, moneyKey, parseMoneyKey } from "./money-base";

import { loadHome } from "@/app/(app)/_hem/load";
import type { HomeData } from "@/app/(app)/_hem/data";
import { loadVartLagerFor, type VartLagerView } from "@/app/(app)/vart-lager/_lib/data";

/**
 * Sökparametrarna som en nyckel för `cache`: samma nyckel som Pengar (period och filter), så
 * att Hem och Pengar läser Lönsamhets modell ur samma minne.
 */
export const hemKey = moneyKey;

const parse = parseMoneyKey;

/** Hems modell (nyckeltal, takt i dag, mål, utbetalningar), eller null utan ekonomi. */
export const loadHemCore = cache(async (key: string): Promise<HomeData | null> => {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  return loadHome(parse(key));
});

/** Lönsamhets modell för samma period (vecka/dag, per automat och titel), eller null. */
export const loadHemProfit = loadMoneyProfit;

/** Vårt lager (hemma, i automaterna, värde, räcker), eller null utan ekonomi eller vid fel. */
export const loadHemStock = cache(async (): Promise<VartLagerView | null> => {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  try {
    return await loadVartLagerFor(await requireViewer(), new Date(ctx.now));
  } catch (error) {
    console.error("[hem] Vårt lager kunde inte läsas:", error);
    return null;
  }
});
