/**
 * Titlar som saknar inköpspris: titlar med order de senaste 30 dagarna (t.o.m. i dag) där
 * inget inköpspris gällde orderns dag. Sådana order räknas inte in i vinsten
 * (docs/berakningar.md, avsnitt 5), så vinsten blir ofullständig tills priset finns.
 *
 *   andel av intäkten = titelns intäkt utan pris / all intäkt i fönstret (bp)
 *   kronor i risk     = intäkt utan pris × 7 / 30 (intäkt per vecka utan vinstberäkning)
 *   nivå              = 'soon' om andelen är minst 10 %, annars 'later'
 */

import {
  addDays,
  buildLedger,
  mulDivRound,
  ratioBp,
  summarizeLedger,
  type IsoDate,
} from "@/domain";
import { evidence, links } from "./common";
import { HORIZON_DAYS, urgencyOf, type TodoContext } from "./context";
import { kr, pct, periodText, plural } from "./text";
import type { TodoItem, TodoLevel } from "./types";

/** Andel av intäkten (bp) från vilken punkten får nivån 'soon'. */
export const MISSING_PRICE_SOON_BP = 1_000;

/** Punkter för titlar utan inköpspris. */
export function missingPriceTodos(ctx: TodoContext): TodoItem[] {
  const { input, today, options } = ctx;
  const period = { start: addDays(today, -(options.unpricedWindowDays - 1)), end: today };
  const orders = input.orders.filter(
    (o) => o.businessDate >= period.start && o.businessDate <= period.end,
  );
  if (orders.length === 0) return [];
  const ledger = buildLedger({
    orders,
    period,
    prices: input.prices,
    agreements: input.agreements,
    placements: input.placements,
    settings: input.settings,
  });
  const summary = summarizeLedger(ledger, "title");
  const totalRevenue = summary.totals.revenueOre + summary.totals.unpricedRevenueOre;

  const unpricedOrders = new Map<string, { ids: string[]; dates: IsoDate[] }>();
  for (const e of ledger.entries) {
    if (e.priced) continue;
    let acc = unpricedOrders.get(e.order.titleId);
    if (!acc) {
      acc = { ids: [], dates: [] };
      unpricedOrders.set(e.order.titleId, acc);
    }
    acc.ids.push(e.order.id);
    acc.dates.push(e.order.businessDate);
  }

  return summary.unpriced.byTitle.map((t): TodoItem => {
    const shareBp = ratioBp(t.revenueOre, totalRevenue) ?? 0;
    const atStakeOre = mulDivRound(t.revenueOre, HORIZON_DAYS, options.unpricedWindowDays);
    const level: TodoLevel = shareBp >= MISSING_PRICE_SOON_BP ? "soon" : "later";
    const name = ctx.titleName(t.titleId);
    const acc = unpricedOrders.get(t.titleId);
    return {
      key: `missing-price:${t.titleId}`,
      fingerprint: t.firstDate,
      kind: "missing-price",
      level,
      urgency: urgencyOf(level, atStakeOre),
      atStakeOre,
      daysLeft: null,
      title: `Lägg in inköpspris för ${name}`,
      detail:
        `${name} står för ${pct(shareBp)} av intäkten ${periodText(period)} ` +
        `(${kr(t.revenueOre)}, ${plural(t.orders, "order", "order")}) men saknar inköpspris, ` +
        `så de orderna räknas inte in i vinsten.`,
      evidence: evidence({
        rule: `Titeln har order de senaste ${options.unpricedWindowDays} dagarna utan inköpspris på orderdagen.`,
        period,
        orderIds: acc?.ids ?? [],
        dates: acc?.dates ?? [],
        titleIds: [t.titleId],
        figures: [
          { key: "unpricedOrders", label: "Order utan pris", value: t.orders, unit: "count" },
          {
            key: "unpricedRevenueOre",
            label: "Intäkt utan pris",
            value: t.revenueOre,
            unit: "ore",
          },
          {
            key: "totalRevenueOre",
            label: "All intäkt i fönstret",
            value: totalRevenue,
            unit: "ore",
          },
          { key: "shareBp", label: "Andel av intäkten", value: shareBp, unit: "bp" },
        ],
      }),
      link: links.purchasePrices(t.titleId),
      action: { kind: "add-price", label: "Lägg in inköpspris", params: { titleId: t.titleId } },
    };
  });
}
