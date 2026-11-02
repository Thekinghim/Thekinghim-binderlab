/**
 * Datakvalitet: titlar som troligen är samma produkt och kan slås ihop (felstavning,
 * versaler, mellanslag, ordföljd). Reglerna för likhet finns i similarity.ts.
 *
 * Bara aktiva titlar jämförs. Förslaget är att slå ihop titeln med färre order (alla
 * tider) in i den med fler; vid lika antal behålls den med lägst id. Flera stavningar av
 * samma namn ger ett förslag per titel som ska bort, alla in i samma titel (`mergeProposals`). Punkten har nivån
 * 'later' och kronor i risk = den mindre titelns intäkt de senaste 30 dagarna × 7 / 30
 * (intäkt per vecka som hamnar på fel titel).
 */

import { addDays, mulDivRound, revenue } from "@/domain";
import { evidence, links } from "./common";
import { HORIZON_DAYS, urgencyOf, type TodoContext } from "./context";
import { compareTitles, type DuplicateReason, type TitleComparison } from "./similarity";
import { plural } from "./text";
import type { AnalyticsOrder, TitleRef, TodoItem } from "./types";

const REASON_TEXT: Record<DuplicateReason, string> = {
  same: "Namnen skiljer sig bara i versaler, accenter eller skiljetecken.",
  spacing: "Namnen skiljer sig bara i mellanslag.",
  "word-order": "Namnen har samma ord i annan ordning.",
  typo: "Namnen skiljer sig med en eller två bokstäver.",
};

/** Ett förslag: slå ihop `from` in i `into`. */
interface MergeProposal {
  readonly from: TitleRef;
  readonly into: TitleRef;
  readonly comparison: TitleComparison;
}

/**
 * Förslag på sammanslagningar, högst ett per titel som ska bort.
 *
 * Titlar som liknar varandra (direkt eller via varandra) bildar en grupp. I gruppen behålls
 * titeln med flest order (vid lika: lägst id), och varje titel som liknar den direkt slås
 * ihop in i den. Titlar i gruppen som bara liknar en titel som själv ska bort hanteras i en
 * ny omgång bland de återstående, så att ingen titel föreslås bli sammanslagen in i en titel
 * som också ska bort. Tre stavningar av samma namn ger alltså två förslag, inte tre.
 */
export function mergeProposals(
  titles: readonly TitleRef[],
  orderCount: (titleId: string) => number,
): MergeProposal[] {
  const sorted = [...titles].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const similar = new Map<string, Map<string, TitleComparison>>();
  const link = (a: TitleRef, b: TitleRef, c: TitleComparison) => {
    const forA = similar.get(a.id) ?? new Map<string, TitleComparison>();
    forA.set(b.id, c);
    similar.set(a.id, forA);
  };
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i] as TitleRef;
      const b = sorted[j] as TitleRef;
      const cmp = compareTitles(a.name, b.name);
      if (!cmp.duplicate || cmp.reason === null) continue;
      link(a, b, cmp);
      link(b, a, cmp);
    }
  }
  // Fler order först, sedan lägst id.
  const rank = (a: TitleRef, b: TitleRef) =>
    orderCount(b.id) - orderCount(a.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const remaining = sorted.filter((t) => similar.has(t.id)).sort(rank);
  const handled = new Set<string>();
  const out: MergeProposal[] = [];
  for (const into of remaining) {
    if (handled.has(into.id)) continue;
    handled.add(into.id);
    for (const from of remaining) {
      if (handled.has(from.id)) continue;
      const comparison = similar.get(into.id)?.get(from.id);
      if (!comparison) continue;
      handled.add(from.id);
      out.push({ from, into, comparison });
    }
  }
  return out;
}

/** Punkter för titlar som kan slås ihop. */
export function duplicateTitleTodos(ctx: TodoContext): TodoItem[] {
  const { input, today, options } = ctx;
  const ordersByTitle = new Map<string, AnalyticsOrder[]>();
  for (const o of input.orders) {
    const list = ordersByTitle.get(o.titleId);
    if (list) list.push(o);
    else ordersByTitle.set(o.titleId, [o]);
  }
  const windowStart = addDays(today, -(options.unpricedWindowDays - 1));
  const proposals = mergeProposals(
    input.titles.filter((t) => !t.archived),
    (id) => ordersByTitle.get(id)?.length ?? 0,
  );

  const out: TodoItem[] = [];
  for (const { from, into, comparison: cmp } of proposals) {
    const reason = cmp.reason as DuplicateReason;
    const [a, b] = from.id < into.id ? [from, into] : [into, from];
    const fromOrders = ordersByTitle.get(from.id) ?? [];
    const intoOrders = ordersByTitle.get(into.id) ?? [];
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
        `${REASON_TEXT[reason]} "${from.name}" har ${plural(fromOrders.length, "order", "order")}, ` +
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
  return out;
}
