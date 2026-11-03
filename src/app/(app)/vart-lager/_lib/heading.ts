/**
 * Rubriken på Vårt lager. Ren och klientsäker.
 */

import { formatInt, NBSP } from "@/lib/format";

import { plural } from "../../lager/_lib/display";
import type { VartLagerModel } from "./model";

export function headingOf(m: Pick<VartLagerModel, "totals" | "lowDays">): {
  title: string;
  aside: string;
} {
  const t = m.totals;
  const title = `${formatInt(t.home)}${NBSP}pack hemma.`;
  if (t.negative > 0) {
    return { title, aside: `${plural(t.negative, "titel", "titlar")} under 0. Räkna om.` };
  }
  if (t.runsOut > 0) {
    return {
      title,
      aside: `${plural(t.runsOut, "titel tar", "titlar tar")} slut inom ${formatInt(m.lowDays)} dagar.`,
    };
  }
  return { title, aside: "Allt räcker en vecka till." };
}
