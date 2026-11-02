/**
 * Prioritering efter förlorad försäljning: en påfyllning där slutsålt redan kostat intäkt
 * går före en där lagret bara håller på att ta slut, inom samma nivå.
 *
 * Förlorad intäkt per titel och automat räknas i @/analytics/lost-sales (servern skickar in
 * den för de senaste 14 dagarna, samma fönster som påfyllningen). Här läggs beloppet bara
 * till punktens underlag och brådskevärde:
 *
 *   brådska = nivå × 10¹² + kronor i risk de närmaste 7 dagarna + förlorat i fönstret (öre)
 *
 * Nivån ändras inte (den följer lagret), och "kronor i risk" (`atStakeOre`) är fortfarande
 * bara framåt, så att summorna på sidan inte räknar samma intäkt två gånger.
 */

import { sortTodos, urgencyOf } from "./context";
import type { LostSalesRef, TodoItem } from "./types";

/** Underlagets nyckel för förlorad intäkt. */
export const LOST_REVENUE_FIGURE = "lostRevenueOre";

/** Punkterna med förlorad försäljning i underlaget och brådskan, sorterade igen. */
export function prioritizeByLostSales(
  todos: readonly TodoItem[],
  lost: readonly LostSalesRef[],
  windowDays = 14,
): TodoItem[] {
  const byKey = new Map<string, number>();
  for (const l of lost) {
    if (!Number.isSafeInteger(l.lostRevenueOre) || l.lostRevenueOre <= 0) continue;
    byKey.set(l.key, (byKey.get(l.key) ?? 0) + l.lostRevenueOre);
  }
  if (byKey.size === 0) return [...todos];
  return sortTodos(
    todos.map((t) => {
      if (t.kind !== "refill") return t;
      const lostOre = byKey.get(t.key);
      if (lostOre === undefined) return t;
      return {
        ...t,
        urgency: urgencyOf(t.level, Math.max(t.atStakeOre ?? 0, 0) + lostOre),
        evidence: {
          ...t.evidence,
          rule: `${t.evidence.rule} Förlorad intäkt när titeln var slut de senaste ${windowDays} dagarna går först inom samma nivå.`,
          figures: [
            ...t.evidence.figures.filter((f) => f.key !== LOST_REVENUE_FIGURE),
            {
              key: LOST_REVENUE_FIGURE,
              label: `Förlorat när slut, ${windowDays} d`,
              value: lostOre,
              unit: "ore" as const,
            },
          ],
        },
      };
    }),
  );
}
