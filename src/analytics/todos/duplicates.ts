/**
 * Datakvalitet: titlar som troligen är samma produkt och kan slås ihop (felstavning,
 * versaler, mellanslag, ordföljd). Reglerna för likhet finns i similarity.ts.
 *
 * Bara aktiva titlar jämförs. Förslaget är att slå ihop titeln med färre order (alla
 * tider) in i den med fler; vid lika antal behålls den med lägst id. Punkten har nivån
 * 'later' och kronor i risk = den mindre titelns intäkt de senaste 30 dagarna × 7 / 30
 * (intäkt per vecka som hamnar på fel titel).
 */

import { addDays, mulDivRound, revenue } from "@/domain";
import { evidence, links } from "./common";
import { HORIZON_DAYS, urgencyOf, type TodoContext } from "./context";
import { compareTitles, type DuplicateReason } from "./similarity";
import { plural } from "./text";
import type { AnalyticsOrder, TitleRef, TodoItem } from "./types";

const REASON_TEXT: Record<DuplicateReason, string> = {
  same: "Namnen skiljer sig bara i versaler, accenter eller skiljetecken.",
  spacing: "Namnen skiljer sig bara i mellanslag.",
  "word-order": "Namnen har samma ord i annan ordning.",
  typo: "Namnen skiljer sig med en eller två bokstäver.",
};

/** Punkter för titlar som kan slås ihop. */
export function duplicateTitleTodos(ctx: TodoContext): TodoItem[] {
  const { input, today, options } = ctx;
  const titles = input.titles
    .filter((t) => !t.archived)
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ordersByTitle = new Map<string, AnalyticsOrder[]>();
  for (const o of input.orders) {
    const list = ordersByTitle.get(o.titleId);
    if (list) list.push(o);
    else ordersByTitle.set(o.titleId, [o]);
  }
  const windowStart = addDays(today, -(options.unpricedWindowDays - 1));

  const out: TodoItem[] = [];
  for (let i = 0; i < titles.length; i++) {
    for (let j = i + 1; j < titles.length; j++) {
      const a = titles[i] as TitleRef;
      const b = titles[j] as TitleRef;
      const cmp = compareTitles(a.name, b.name);
      if (!cmp.duplicate || cmp.reason === null) continue;
      const ordersA = ordersByTitle.get(a.id) ?? [];
      const ordersB = ordersByTitle.get(b.id) ?? [];
      // Slå ihop den mindre in i den större.
      const [from, into, fromOrders, intoOrders] =
        ordersA.length < ordersB.length ? [a, b, ordersA, ordersB] : [b, a, ordersB, ordersA];
      const recent = fromOrders.filter(
        (o) => o.businessDate >= windowStart && o.businessDate <= today,
      );
      const atStakeOre = mulDivRound(
        revenue(recent, input.settings),
        HORIZON_DAYS,
        options.unpricedWindowDays,
      );
      const allOrders = [...fromOrders, ...intoOrders];
      out.push({
        key: `duplicate-title:${a.id}:${b.id}`,
        fingerprint: `${a.name}|${b.name}`,
        kind: "duplicate-title",
        level: "later",
        urgency: urgencyOf("later", atStakeOre),
        atStakeOre,
        daysLeft: null,
        title: `Slå ihop "${from.name}" med "${into.name}"`,
        detail:
          `${REASON_TEXT[cmp.reason]} "${from.name}" har ${plural(fromOrders.length, "order", "order")}, ` +
          `"${into.name}" har ${plural(intoOrders.length, "order", "order")}.`,
        evidence: evidence({
          rule: "Titelnamnen är lika efter normalisering eller skiljer sig med högst två bokstäver i samma antal ord.",
          orderIds: allOrders.map((o) => o.id),
          dates: allOrders.map((o) => o.businessDate),
          titleIds: [a.id, b.id],
          figures: [
            { key: "distance", label: "Avstånd (tecken)", value: cmp.distance, unit: "count" },
            { key: "similarityBp", label: "Likhet", value: cmp.similarityBp, unit: "bp" },
            {
              key: "fromOrders",
              label: `Order "${from.name}"`,
              value: fromOrders.length,
              unit: "count",
            },
            {
              key: "intoOrders",
              label: `Order "${into.name}"`,
              value: intoOrders.length,
              unit: "count",
            },
          ],
        }),
        link: links.mergeTitles(from.id, into.id),
        action: {
          kind: "merge-titles",
          label: "Slå ihop titlarna",
          params: { fromTitleId: from.id, intoTitleId: into.id },
        },
      });
    }
  }
  return out;
}
