/**
 * Rubriken på Vårt lager: en kort mening med den stora siffran och en grå rad med det som
 * ska göras. Ren och klientsäker.
 */

import { formatInt, NBSP } from "@/lib/format";

import { plural } from "../../lager/_lib/display";
import type { VartLagerModel } from "./model";

export function headingOf(m: Pick<VartLagerModel, "totals" | "lowDays" | "rows">): {
  title: string;
  aside: string;
} {
  const t = m.totals;
  const title = `${formatInt(t.home)}${NBSP}pack i lager.`;
  if (t.negative > 0) {
    return { title, aside: `${plural(t.negative, "titel", "titlar")} under 0. Räkna om.` };
  }
  if (t.runsOut > 0) {
    const out = m.rows.filter((r) => r.runsOut && !r.negative);
    const pack = out.filter((r) => r.own).length;
    const order = out.length - pack;
    const parts = [
      pack > 0 ? `packa ${formatInt(pack)}` : null,
      order > 0 ? `beställ ${formatInt(order)}` : null,
    ].filter((p): p is string => p !== null);
    const todo = parts.join(", ");
    return {
      title,
      aside: `${plural(t.runsOut, "titel tar", "titlar tar")} slut: ${todo}.`,
    };
  }
  return { title, aside: `Allt räcker ${formatInt(m.lowDays)}${NBSP}dagar.` };
}
