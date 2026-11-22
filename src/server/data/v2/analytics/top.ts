/**
 * Pengar (G4): Bästsäljare. Vinst per titel ur Lönsamhets rader för perioden, förra
 * perioden med samma beräkning, andel av vinsten och sålda pack per vecka (8 veckor) ur
 * årets order.
 */

import "server-only";

import { profitability } from "@/domain";
import type { SearchParamsInput } from "@/components/shell/period-state";

import { loadMoneyProfit, loadMoneyYear, moneyKey } from "./money-base";
import { topTitles, weeklyUnits, type TopTitle } from "./money-model";

export async function loadMoneyTop(sp: SearchParamsInput, limit = 5): Promise<TopTitle[] | null> {
  const [data, year] = await Promise.all([loadMoneyProfit(moneyKey(sp)), loadMoneyYear()]);
  if (!data) return null;
  let previous: Map<string, number> | null = null;
  if (data.p.key !== "idag" && data.input.previous && data.input.previous.orders.length > 0) {
    previous = new Map();
    for (const r of profitability(data.input.previous, "title").rows) {
      if (r.kind === "item") previous.set(r.key, r.profitOre);
    }
  }
  const weekly = year ? weeklyUnits(year.input.current.orders, year.today) : new Map();
  return topTitles(
    data.model.views.title
      .filter((l) => l.kind === "item")
      .map((l) => ({
        titleId: l.key,
        name: l.name,
        orders: l.orders,
        revenueOre: l.revenueOre,
        profitOre: l.profitOre,
      })),
    previous,
    weekly,
    limit,
  );
}
