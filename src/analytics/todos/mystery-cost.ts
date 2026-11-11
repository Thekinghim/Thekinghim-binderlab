/**
 * Mystery pack med fel inköpspris: kalkylen (innehållet × dagens inköpspriser på delarna)
 * är inte titelns eget inköpspris. Sålda mystery packs räknas med titelns pris, så vinsten
 * blir fel tills priset uppdateras. Händer när en del byter pris eller innehållet ändras.
 *
 *   rubrik      = "Mystery pack premium kostar nu 213 kr, inte 174 kr"
 *   nivå        = 'soon' (vinsten per sålt pack visas fel)
 *   fingerprint = nuvarande pris + kalkylens pris (en ny skillnad tar upp punkten igen)
 *
 * Inget skrivs om av sig självt: punkten leder till Mystery packs, där ägaren väljer
 * "Uppdatera priset från i dag" eller "Rätta priset". Bara ägare och admin (laddaren skickar
 * `mysteryRecipes` bara med ekonomin).
 */

import { mysteryCostDrifts, PriceIndex } from "@/domain";

import { evidence } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import { krAuto } from "./text";
import type { TodoItem } from "./types";

/** Mystery-packets sida, vid kalkylen. */
export function mysteryCostLink(titleId: string): string {
  return `/vart-lager/mystery/${encodeURIComponent(titleId)}#kalkyl`;
}

export function mysteryCostTodos(ctx: TodoContext): TodoItem[] {
  const recipes = ctx.input.mysteryRecipes ?? [];
  if (recipes.length === 0) return [];
  const active = new Set(ctx.input.titles.filter((t) => !t.archived).map((t) => t.id));
  const index = new PriceIndex(ctx.input.prices);
  const priceOf = (id: string) => index.priceOn(id, ctx.today)?.unitCostOre ?? null;
  return mysteryCostDrifts(
    recipes.filter((r) => active.has(r.titleId)),
    priceOf,
  ).map((d): TodoItem => {
    const name = ctx.titleName(d.titleId);
    return {
      key: `mystery-cost:${d.titleId}`,
      fingerprint: `${d.currentOre ?? "-"}|${d.calculatedOre}`,
      kind: "mystery-cost",
      level: "soon",
      urgency: urgencyOf("soon", 0),
      atStakeOre: null,
      daysLeft: null,
      title:
        d.currentOre === null
          ? `${name} kostar ${krAuto(d.calculatedOre)} men saknar inköpspris`
          : `${name} kostar nu ${krAuto(d.calculatedOre)}, inte ${krAuto(d.currentOre)}`,
      detail:
        d.currentOre === null
          ? "Utan inköpspris räknas ingen vinst på sålda pack. Lägg in priset."
          : "Innehållet eller ett inköpspris har ändrats. Uppdatera priset, annars visas fel vinst.",
      evidence: evidence({
        rule: "Innehållet × dagens inköpspriser är inte mystery-packets eget inköpspris.",
        titleIds: [d.titleId],
        figures: [
          ...(d.currentOre === null
            ? []
            : [
                {
                  key: "currentCostOre",
                  label: "Inköpspris i dag",
                  value: d.currentOre,
                  unit: "ore" as const,
                },
              ]),
          {
            key: "calculatedCostOre",
            label: "Innehållet kostar",
            value: d.calculatedOre,
            unit: "ore",
          },
        ],
      }),
      link: mysteryCostLink(d.titleId),
      action: {
        kind: "open-mystery",
        label: d.currentOre === null ? "Lägg in priset" : "Uppdatera priset",
        params: { titleId: d.titleId },
      },
    };
  });
}
