/**
 * Prisråd: EN punkt när produkter tjänar för lite ("2 produkter tjänar för lite").
 *
 * En produkt tjänar för lite när marginalen FÖRE butikernas andel, med priset i automaten
 * (senaste köpet de senaste 30 dagarna) och dagens inköpspris, är under organisationens mål
 * (standard 25 %, `options.targetMarginBp`). Se @/domain price-advice.
 *
 *   nivå        = 'later' (ett råd, inget som brinner)
 *   fingerprint = målet + varje produkt med pris och inköpspris (en ny produkt, ett nytt pris
 *                 eller ett nytt mål tar upp en avbockad punkt igen)
 *
 * Bara ett råd: appen kan inte ändra priset i automaten. Punkten leder till Lönsamhet.
 */

import {
  addDays,
  currentSalePrices,
  PRICE_ADVICE_WINDOW_DAYS,
  priceAdvice,
  PriceIndex,
  type PriceAdvice,
} from "@/domain";

import { evidence } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import { pct, plural } from "./text";
import type { TodoInput, TodoItem } from "./types";

/** Avsnittet Prisråd på Lönsamhet. */
export const PRICE_ADVICE_LINK = "/lonsamhet#prisrad";

/** Produkterna under målet (samma lista som Lönsamhet visar), sämst marginal först. */
export function priceAdviceFor(
  input: Pick<TodoInput, "orders" | "titles" | "prices" | "settings">,
  today: string,
  targetBp: number,
): PriceAdvice[] {
  const since = addDays(today, -(PRICE_ADVICE_WINDOW_DAYS - 1));
  const index = new PriceIndex(input.prices);
  return priceAdvice({
    titleIds: input.titles.filter((t) => !t.archived).map((t) => t.id),
    salePrices: currentSalePrices(input.orders, since),
    costOf: (id) => index.priceOn(id, today)?.unitCostOre ?? null,
    settings: input.settings,
    targetBp,
  });
}

export function priceAdviceTodos(ctx: TodoContext): TodoItem[] {
  const targetBp = ctx.options.targetMarginBp;
  const rows = priceAdviceFor(ctx.input, ctx.today, targetBp);
  if (rows.length === 0) return [];
  const names = rows.slice(0, 3).map((r) => ctx.titleName(r.titleId));
  const more = rows.length - names.length;
  return [
    {
      key: "price-advice:all",
      fingerprint: [
        targetBp,
        ...rows.map((r) => `${r.titleId}:${r.salePriceOre}:${r.unitCostOre}`).sort(),
      ].join("|"),
      kind: "price-advice",
      level: "later",
      urgency: urgencyOf("later", 0),
      atStakeOre: null,
      daysLeft: null,
      title: `${plural(rows.length, "produkt", "produkter")} tjänar för lite`,
      detail:
        `Under ${pct(targetBp)} marginal: ${names.join(", ")}${more > 0 ? ` och ${more} till` : ""}. ` +
        "Priset ändras i automatens system.",
      evidence: evidence({
        rule: `Marginalen före butikernas andel är under målet ${pct(targetBp)} med priset i automaten och dagens inköpspris.`,
        titleIds: rows.map((r) => r.titleId),
        figures: [
          { key: "targetMarginBp", label: "Mål", value: targetBp, unit: "bp" },
          { key: "products", label: "Produkter under målet", value: rows.length, unit: "count" },
        ],
      }),
      link: PRICE_ADVICE_LINK,
      action: { kind: "open-pricing", label: "Visa prisråd", params: {} },
    },
  ];
}
