/**
 * "Vad sålde vi?" för vald period (Hem och Pengar, främst I går eller en annan enskild dag):
 * per titel, per automat och per timme, med total. Uträkningen: @/analytics/day-sales.
 *
 * Ägare, admin och läsare: antal, intäkt och vinst ur liggaren (loadDomainInput, filtret och
 * vyknapparna följer med). Påfyllaren: bara antal ur lagret (loadSalesCounts, inga belopp);
 * order läses aldrig för rollen (RLS).
 */

import "server-only";

import { cache } from "react";

import { salesFromCounts, salesFromLedger, type DaySales, type Names } from "@/analytics/day-sales";
import {
  isSingleDay,
  periodName,
  periodNameInline,
  type SearchParamsInput,
} from "@/components/shell/period-state";
import type { Period } from "@/domain";
import { loadSalesCounts } from "@/server/data/core";
import type { SalesCountsArgs } from "@/server/data/core/loaders";
import type { MasterData, SalesCounts } from "@/server/data/core/types";
import { requestPageLoaders, type PageLoaders } from "@/server/data/page-loaders";

import { moneyKey, parseMoneyKey } from "./money-base";

export interface DaySalesView {
  readonly sales: DaySales;
  /** "I går", "14–20 nov.". */
  readonly name: string;
  /** "i går", "14–20 nov." (i löptext). */
  readonly inline: string;
  readonly period: Period;
  /** Perioden är en dag (listan heter då "Sålt i går" och har timmar). */
  readonly singleDay: boolean;
}

function namesOf(master: Pick<MasterData, "titles" | "machines">): Names {
  const titles = new Map(master.titles.map((t) => [t.id, t.name]));
  const machines = new Map(master.machines.map((m) => [m.id, m]));
  return {
    title: (id) => titles.get(id) ?? "Okänd titel",
    machine: (id) => {
      const m = machines.get(id);
      return m ? { name: m.name, code: m.code } : { name: "Okänd automat" };
    },
  };
}

/** Samma med givna laddare (sidan med förfrågans, testerna med en given användare). */
export async function loadDaySalesWith(
  loaders: Pick<PageLoaders, "context" | "period" | "domainInput" | "masterData">,
  salesCounts: (args: SalesCountsArgs) => Promise<SalesCounts>,
  sp: SearchParamsInput,
): Promise<DaySalesView> {
  const [ctx, p] = await Promise.all([loaders.context(), loaders.period(sp)]);
  let sales: DaySales;
  if (ctx.canSeeEconomy) {
    const input = await loaders.domainInput({ period: p.period, compare: null, ...p.scope });
    sales = salesFromLedger(input.current, namesOf(input), ctx.timeZone);
  } else {
    const [counts, master] = await Promise.all([
      salesCounts({ period: p.period, ...p.scope }),
      loaders.masterData(),
    ]);
    sales = salesFromCounts(counts.rows, namesOf(master));
  }
  return {
    sales,
    name: periodName(p.resolved),
    inline: periodNameInline(p.resolved),
    period: p.period,
    singleDay: isSingleDay(p.resolved),
  };
}

const loadCached = cache(async (key: string): Promise<DaySalesView> =>
  loadDaySalesWith(requestPageLoaders(), loadSalesCounts, parseMoneyKey(key)),
);

/** Försäljningen i vald period för den inloggade (alla roller; påfyllaren utan kronor). */
export function loadDaySales(sp: SearchParamsInput): Promise<DaySalesView> {
  return loadCached(moneyKey(sp));
}
