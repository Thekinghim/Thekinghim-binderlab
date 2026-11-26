/**
 * Pengar (G4): "Vem pengarna är till" för periodens dagar (src/server/payouts/
 * period-split.ts). Bara ägare och admin: partnerns rad visar vårt inköp, precis som
 * Utbetalningar. Läsare och påfyllare får null (och laddaren kontrollerar rollen igen mot
 * databasen). Hela organisationen: ett filter på butik eller automat gäller inte här.
 */

import "server-only";

import { cache } from "react";

import { toIsoDate, type SearchParamsInput } from "@/components/shell/period-state";
import { settlementDue } from "@/analytics/todos";
import { daysBetween, monthOf, type IsoDate, type IsoMonth } from "@/domain";
import { cachedViewState, loadContext, loadPeriod, requireViewer } from "@/server/data/core";
import { loadPeriodSplitFor } from "@/server/payouts/period-split";

import { moneyKey, parseMoneyKey } from "./money-base";
import type { SplitView } from "./split-model";

/** Längre perioder än så räknas inte här (en laddning av avräkningen per månad). */
export const SPLIT_MAX_DAYS = 400;

export type MoneySplit =
  | {
      readonly state: "ok";
      readonly view: SplitView;
      /** Sidan har ett filter på butik, ägare eller automat (fördelningen gäller alla). */
      readonly filtered: boolean;
      /** Månaden som butikerna får betalt för härnäst (i dag) och sista dagen (den 15:e efter). */
      readonly storePay: { readonly month: IsoMonth; readonly due: IsoDate };
    }
  | { readonly state: "too_long" }
  | { readonly state: "error" };

const loadCached = cache(async (key: string): Promise<MoneySplit | null> => {
  const ctx = await loadContext();
  if (!ctx.canEdit) return null;
  const [p, viewer] = await Promise.all([loadPeriod(parseMoneyKey(key)), requireViewer()]);
  if (daysBetween(p.period.start, p.period.end) > SPLIT_MAX_DAYS) return { state: "too_long" };
  try {
    const payMonth = monthOf(toIsoDate(p.resolved.today));
    // Sparad mellan förfrågningar per period och filter (cachedViewState; ändringar och
    // Awish-synken rensar den): tillbaka till en period man nyss såg räknas inte om.
    const view = await cachedViewState(`money-split:${p.period.start}:${p.period.end}:${key}`, () =>
      loadPeriodSplitFor(viewer, p.period, new Date(ctx.now)),
    );
    return {
      state: "ok",
      view,
      filtered: Boolean(p.scope.storeId || p.scope.machineId || p.scope.ownerId),
      storePay: { month: payMonth, due: settlementDue(payMonth) },
    };
  } catch (error) {
    console.error("[pengar] fördelning", error instanceof Error ? error.message : error);
    return { state: "error" };
  }
});

export function loadMoneySplit(sp: SearchParamsInput): Promise<MoneySplit | null> {
  return loadCached(moneyKey(sp));
}
