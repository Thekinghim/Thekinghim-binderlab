/**
 * Sidans svar högst upp: tvådelad rubrik med fakta ur vymodellen.
 *   "2 fack kritiska, 5 låga."  "Ascended Heroes är slut i BL-001. 46 pack ska ut i dag."
 */

import { formatInt, NBSP } from "@/lib/format";

import { codeText, packs, tenthsText } from "./display";
import type { LagerView, StockCell } from "./types";

export interface Headline {
  readonly title: string;
  readonly aside: string;
}

function count(n: number, one: string, many: string): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}

/** Den mest brådskande cellen: slut först, sedan färst dagar kvar, sedan minst i lager. */
export function mostUrgent(view: Pick<LagerView, "cells">): StockCell | null {
  let best: StockCell | null = null;
  const rank = (c: StockCell) => (c.status === "critical" ? 0 : c.status === "low" ? 1 : 2);
  for (const row of view.cells) {
    for (const c of row) {
      if (!c.stocked || c.status === "ok") continue;
      if (
        best === null ||
        rank(c) < rank(best) ||
        (rank(c) === rank(best) &&
          ((c.daysLeft ?? Infinity) < (best.daysLeft ?? Infinity) ||
            ((c.daysLeft ?? Infinity) === (best.daysLeft ?? Infinity) && c.onHand < best.onHand)))
      ) {
        best = c;
      }
    }
  }
  return best;
}

export function headlineOf(view: LagerView): Headline {
  const { critical, low, ok } = view.counts;
  const total = critical + low + ok;
  const packsToday = view.packLists.reduce((s, p) => s + p.totalPacks, 0);
  const machinesToday = view.packLists.filter((p) => p.totalPacks > 0).length;
  const titleName = new Map(view.titles.map((t) => [t.id, t.name]));
  const machineCode = new Map(view.machines.map((m) => [m.id, codeText(m.code)]));

  if (view.machines.length === 0) {
    return {
      title: "Ingen automat i drift.",
      aside: "Lagret i automaterna visas när en automat är i drift.",
    };
  }
  if (total === 0) {
    return {
      title: "Inget lager registrerat.",
      aside: `${count(view.machines.length, "automat", "automater")} utan saldo. Inventera för att börja.`,
    };
  }

  const urgent = mostUrgent(view);
  const where = urgent
    ? `${titleName.get(urgent.titleId) ?? "En titel"} i ${machineCode.get(urgent.machineId) ?? "en automat"}`
    : "";
  const urgentText = urgent
    ? urgent.onHand === 0
      ? `${where} är slut.`
      : `${where} har ${packs(urgent.onHand)} kvar.`
    : "";
  const today =
    packsToday > 0
      ? `${packs(packsToday)} ut till ${count(machinesToday, "automat", "automater")} i dag.`
      : "Inget behöver fyllas på i dag.";

  if (critical > 0) {
    return {
      title: `${count(critical, "fack kritiskt", "fack kritiska")}${low > 0 ? `, ${formatInt(low)} ${low === 1 ? "lågt" : "låga"}` : ""}.`,
      aside: `${urgentText} ${today}`,
    };
  }
  if (low > 0) {
    return {
      title: `Inget fack är slut. ${count(low, "fack lågt", "fack låga")}.`,
      aside: `${urgentText} ${today}`,
    };
  }
  return {
    title: `Alla ${formatInt(total)}${NBSP}fack räcker minst ${tenthsText(view.lowThresholdTenths)}${NBSP}dagar.`,
    aside: today,
  };
}
