/**
 * Butik med automat men utan avtal: en punkt per butik i Att göra ("Hörnan har inget
 * avtal – räknas som 0 %" → Lägg in avtal på butikens sida). Underlaget är agreementGaps
 * (@/domain) från avräkningsmånadens början t.o.m. i dag, så att en lucka som påverkar
 * nästa avräkning syns innan avräkningen skapas.
 *
 *   punkt      = minst en dag med automat i butiken och inget avtal
 *   nivå       = 'now' när alla dagarna saknar avtal (butiken får inget), annars 'soon'
 *   nyckel     = 'agreement:<butik>', fingerprint = dagar och första dagen
 */

import { evidence, nameLookup } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import { day, plural } from "./text";
import type { TodoItem } from "./types";

/** Butikens flik Villkor, där "Lägg in avtal" finns. */
export function agreementLink(storeId: string): string {
  return `/butiker/${encodeURIComponent(storeId)}?vy=avtal`;
}

export function agreementGapTodos(ctx: TodoContext): TodoItem[] {
  const gaps = ctx.input.agreementGaps ?? [];
  if (gaps.length === 0) return [];
  const storeName = nameLookup(ctx.input.stores ?? []);
  return gaps
    .filter((g) => g.days > 0 && g.ranges.length > 0)
    .map((g): TodoItem => {
      const whole = g.days >= g.placedDays;
      const name = storeName(g.storeId);
      const first = g.ranges[0]!;
      const last = g.ranges[g.ranges.length - 1]!;
      const when =
        g.ranges.length === 1 && first.start === first.end
          ? day(first.start)
          : `${day(first.start)}–${day(last.end)}`;
      return {
        key: `agreement:${g.storeId}`,
        fingerprint: `${g.days}|${first.start}`,
        kind: "agreement",
        level: whole ? "now" : "soon",
        urgency: urgencyOf(whole ? "now" : "soon", null),
        atStakeOre: null,
        daysLeft: null,
        title: whole
          ? `${name} har inget avtal – räknas som 0 %`
          : `${name}: inget avtal ${plural(g.days, "dag", "dagar")} – 0 % de dagarna`,
        detail: `En automat stod i butiken utan avtal (${when}). Lägg in avtalet, så räknas butikens andel rätt.`,
        evidence: evidence({
          rule: "Dagar med automat i butiken men inget avtal räknas som 0 % (ingen andel, ingen hyra).",
          period: { start: first.start, end: last.end },
          machineIds: g.machineIds,
          storeIds: [g.storeId],
          figures: [{ key: "days", label: "Dagar utan avtal", value: g.days, unit: "days" }],
        }),
        link: agreementLink(g.storeId),
      };
    });
}

/**
 * En butik utan kontrakt och utan avtal får EN punkt: "Skapa kontrakt" lägger också in
 * avtalet (src/server/contracts), så kontraktspunkten uppgraderas ("… saknar kontrakt och
 * avtal – räknas som 0 %", nu) och avtalspunkten för samma butik tas bort.
 */
export function mergeAgreementTodos(
  contracts: readonly TodoItem[],
  agreements: readonly TodoItem[],
): { contracts: TodoItem[]; agreements: TodoItem[] } {
  const byStore = new Map(agreements.map((t) => [t.key.slice("agreement:".length), t]));
  const merged = new Set<string>();
  const out = contracts.map((c) => {
    const storeId = c.key.startsWith("contract-missing:")
      ? c.key.slice("contract-missing:".length)
      : null;
    const gap = storeId ? byStore.get(storeId) : undefined;
    if (!storeId || !gap || c.fingerprint !== "missing") return c;
    merged.add(gap.key);
    const name = c.title.replace(/ saknar kontrakt$/, "");
    return {
      ...c,
      fingerprint: `${c.fingerprint}|${gap.fingerprint}`,
      level: "now" as const,
      urgency: urgencyOf("now", null),
      title:
        gap.level === "now"
          ? `${name} saknar kontrakt och avtal – räknas som 0 %`
          : `${name} saknar kontrakt; ${gap.title.slice(name.length + 2)}`,
      detail: `${c.detail} ${gap.detail}`,
    };
  });
  return { contracts: out, agreements: agreements.filter((t) => !merged.has(t.key)) };
}
