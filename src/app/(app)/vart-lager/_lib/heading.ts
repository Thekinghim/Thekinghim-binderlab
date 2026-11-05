/**
 * Rubriken på Vårt lager: en kort mening med den stora siffran och en grå rad med det som
 * ska göras. Ren och klientsäker.
 */

import { formatInt, NBSP } from "@/lib/format";

import { plural } from "../../lager/_lib/display";
import { needsPurchase, type VartLagerModel } from "./model";

export function headingOf(m: Pick<VartLagerModel, "totals" | "lowDays" | "rows">): {
  title: string;
  aside: string;
} {
  const t = m.totals;
  const title = `${formatInt(t.home)}${NBSP}pack i lager.`;
  if (t.negative > 0) {
    return { title, aside: `${plural(t.negative, "titel", "titlar")} under 0. Räkna om.` };
  }
  // Packa och beställ: samma titlar som Att göra-listan och Inköp (needsPurchase).
  const todo = m.rows.filter((r) => !r.negative && needsPurchase(r));
  const pack = todo.filter((r) => r.own).length;
  const order = todo.length - pack;
  const parts = [
    pack > 0 ? `packa ${formatInt(pack)}` : null,
    order > 0 ? `beställ ${formatInt(order)}` : null,
  ].filter((p): p is string => p !== null);
  const what = parts.join(", ");
  if (t.runsOut > 0) {
    return {
      title,
      aside: what
        ? `${plural(t.runsOut, "titel tar", "titlar tar")} slut: ${what}.`
        : `${plural(t.runsOut, "titel tar", "titlar tar")} slut. Inget att beställa än.`,
    };
  }
  if (what) return { title, aside: `${what.charAt(0).toUpperCase()}${what.slice(1)}.` };
  return { title, aside: `Allt räcker ${formatInt(m.lowDays)}${NBSP}dagar.` };
}
