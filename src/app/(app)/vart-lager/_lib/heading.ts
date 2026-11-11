/**
 * Rubriken på Vårt lager: en kort mening med den stora siffran och en grå rad med det som
 * ska göras. Ren och klientsäker.
 */

import { formatInt, NBSP } from "@/lib/format";

import { plural } from "../../lager/_lib/display";
import { needsPurchase, type VartLagerModel } from "./model";
import { stepsText } from "./steps";

export function headingOf(m: Pick<VartLagerModel, "totals" | "lowDays" | "rows">): {
  title: string;
  aside: string;
} {
  const t = m.totals;
  const title = `${formatInt(t.home)}${NBSP}pack i lager.`;
  if (t.negative > 0) {
    // En titel under 0 som också ska fyllas på: båda stegen, samma text som på Inköp.
    const neg = m.rows.filter((r) => r.negative);
    const one = neg.length === 1 ? neg[0]! : null;
    const steps = one ? stepsText(true, one.action) : null;
    if (one && steps) return { title, aside: `${one.name}: ${steps}` };
    const more = neg.some((r) => r.action !== null);
    return {
      title,
      aside: `${plural(t.negative, "titel", "titlar")} under 0. ${more ? "Räkna om först." : "Räkna om."}`,
    };
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
  if (what) {
    // Utan "tar slut" före: skriv ut vad talet räknar ("Beställ 1 titel.").
    const full = [
      pack > 0 ? `packa ${plural(pack, "titel", "titlar")}` : null,
      order > 0 ? `beställ ${plural(order, "titel", "titlar")}` : null,
    ]
      .filter((p): p is string => p !== null)
      .join(", ");
    return { title, aside: `${full.charAt(0).toUpperCase()}${full.slice(1)}.` };
  }
  return { title, aside: `Allt räcker minst ${formatInt(m.lowDays)}${NBSP}dagar.` };
}
