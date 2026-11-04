/**
 * Ekonomiverktyg: nyckeltal, lönsamhet per automat/butik/titel/tid och iakttagelser.
 * Bara ägare, admin och läsare (påfyllaren ser aldrig ekonomi; laddaren kastar också).
 *
 * Talen räknas av @/domain (keyMetrics, profitability, changeBp) och @/analytics
 * (computeInsights) på indata från loadDomainInputFor (RLS).
 */

import "server-only";

import { z } from "zod";

import { computeInsights } from "@/analytics/insights";
import {
  changeBp,
  keyMetrics,
  NO_MACHINE_KEY,
  NO_STORE_KEY,
  profitability,
  UNALLOCATED_KEY,
  type GroupBy,
  type KeyMetrics,
  type Period,
  type ProfitabilityRow,
} from "@/domain";
import { formatDelta } from "@/lib/format";
import { loadDomainInputFor } from "@/server/data/core/loaders";
import { ECONOMY_ROLES } from "@/server/data/core/types";

import {
  count,
  defineTool,
  kr,
  nameMaps,
  pageHref,
  pct,
  periodBefore,
  periodFrom,
  periodSchema,
  periodText,
  resolveScope,
  scopeSchema,
  scopeText,
  type ResolvedScope,
  type ToolContext,
} from "./common";

function scopeIds(scope: ResolvedScope) {
  return { machineId: scope.machine?.id ?? null, storeId: scope.store?.id ?? null };
}

function periodData(period: Period) {
  return { fran: period.start, till: period.end, text: periodText(period) };
}

function metricsData(m: KeyMetrics) {
  return {
    intakt: kr(m.revenueOre),
    intaktOre: m.revenueOre,
    vinst: kr(m.profitOre),
    vinstOre: m.profitOre,
    marginal: pct(m.marginBp),
    marginalBp: m.marginBp,
    order: m.orderCount,
    snittorder: m.averageOrderValueOre === null ? "–" : kr(m.averageOrderValueOre),
    snittorderOre: m.averageOrderValueOre,
    andelUtanInkopspris: pct(m.unpricedShareBp),
    andelUtanInkopsprisBp: m.unpricedShareBp,
  };
}

function deltaText(bp: number | null): string {
  return bp === null ? "–" : formatDelta(bp / 10_000, Math.abs(bp) < 1000 ? 1 : 0);
}

// ---------------------------------------------------------------------------
// nyckeltal
// ---------------------------------------------------------------------------

const keyMetricsInput = z
  .object({
    ...periodSchema,
    ...scopeSchema,
    jamfor: z
      .boolean()
      .optional()
      .describe("Jämför med lika lång period direkt före. Standard: sant."),
  })
  .strict();

export const keyMetricsTool = defineTool({
  name: "nyckeltal",
  title: "Nyckeltal",
  label: () => "Nyckeltal",
  description:
    "Intäkt, vinst, marginal, antal order (= sålda pack), snittorder och andel av intäkten utan inköpspris för en period, för hela organisationen eller en automat/butik. Jämför med lika lång period före. Använd för frågor om totalen: 'hur gick oktober', 'vad var vinsten förra veckan'.",
  roles: ECONOMY_ROLES,
  input: keyMetricsInput,
  async run(ctx: ToolContext, input) {
    const period = periodFrom(ctx, input);
    const scope = await resolveScope(ctx, input);
    const compare = input.jamfor === false ? null : periodBefore(period);
    const data = await loadDomainInputFor(
      ctx.viewer,
      { period, compare, ...scopeIds(scope), vmb: ctx.vmb },
      ctx.now,
    );
    const current = keyMetrics(data.current);
    const previous = data.previous ? keyMetrics(data.previous) : null;
    const revenueChange = previous ? changeBp(current.revenueOre, previous.revenueOre) : null;
    const profitChange = previous ? changeBp(current.profitOre, previous.profitOre) : null;
    const where = scopeText(scope);
    return {
      summary: `${periodText(period)}${where}: intäkt ${kr(current.revenueOre)}, vinst ${kr(current.profitOre)}, marginal ${pct(current.marginBp)}, ${count(current.orderCount)} order.`,
      data: {
        period: periodData(period),
        filter: {
          automat: scope.machine ? `${scope.machine.name} (${scope.machine.code})` : "alla",
          butik: scope.store?.name ?? "alla",
        },
        nyckeltal: metricsData(current),
        ...(previous && compare
          ? {
              jamforelseperiod: periodData(compare),
              foregaende: metricsData(previous),
              forandring: {
                intakt: deltaText(revenueChange),
                intaktBp: revenueChange,
                vinst: deltaText(profitChange),
                vinstBp: profitChange,
              },
            }
          : {}),
        anmarkning:
          "Vinst och marginal gäller order med inköpspris. Order utan inköpspris ingår i intäkten men inte i vinsten.",
      },
      figures: [
        { label: "Intäkt", value: kr(current.revenueOre) },
        { label: "Vinst", value: kr(current.profitOre) },
        { label: "Marginal", value: pct(current.marginBp) },
        { label: "Order", value: count(current.orderCount) },
        ...(previous
          ? [{ label: "Intäkt mot perioden före", value: deltaText(revenueChange) }]
          : []),
      ],
      links: [
        { label: "Lönsamhet", href: pageHref("/lonsamhet", period, scopeIds(scope)) },
        { label: "Hem", href: pageHref("/", period, scopeIds(scope)) },
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// lonsamhet
// ---------------------------------------------------------------------------

const GROUPS = {
  automat: "machine",
  butik: "store",
  titel: "title",
  manad: "month",
  vecka: "week",
  dag: "day",
} as const satisfies Record<string, GroupBy>;
type GroupKey = keyof typeof GROUPS;

const GROUP_LABEL: Record<GroupKey, string> = {
  automat: "automat",
  butik: "butik",
  titel: "titel",
  manad: "månad",
  vecka: "vecka",
  dag: "dag",
};

const SORTS = ["vinst", "intakt", "marginal", "order", "tid"] as const;

const profitabilityInput = z
  .object({
    ...periodSchema,
    ...scopeSchema,
    per: z
      .enum(["automat", "butik", "titel", "manad", "vecka", "dag"])
      .describe("Vad raderna ska vara: automat, butik, titel, manad, vecka eller dag."),
    sortera: z
      .enum(SORTS)
      .optional()
      .describe("Sortering: vinst (standard), intakt, marginal, order eller tid (för tidsrader)."),
    ordning: z
      .enum(["hogst", "lagst"])
      .optional()
      .describe("hogst (standard) eller lagst först. Gäller inte sortera=tid."),
    antal: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe("Högst så många rader. Standard 10."),
  })
  .strict();

function rowRevenue(r: ProfitabilityRow): number {
  return r.revenueOre + r.unpricedRevenueOre;
}

function sortValue(r: ProfitabilityRow, sort: (typeof SORTS)[number]): number {
  switch (sort) {
    case "intakt":
      return rowRevenue(r);
    case "marginal":
      return r.marginBp ?? Number.NEGATIVE_INFINITY;
    case "order":
      return r.orders;
    default:
      return r.profitOre;
  }
}

const SPECIAL_ROWS: Record<string, string> = {
  [NO_MACHINE_KEY]: "Order utan kopplad automat",
  [NO_STORE_KEY]: "Order utan butik (automaten var inte placerad)",
  [UNALLOCATED_KEY]: "Ej fördelad hyra",
};

export const profitabilityTool = defineTool({
  name: "lonsamhet",
  title: "Lönsamhet",
  label: (input) => `Lönsamhet per ${GROUP_LABEL[input.per]}`,
  description:
    "Lönsamhet uppdelad per automat, butik, titel, månad, vecka eller dag för en period: intäkt, inköp, VMB-moms, butiksersättning, vinst, marginal och order per rad, sorterad. Använd för 'vilken automat tjänade mest', 'sämsta titlarna', 'vinst per månad'. Vinst = intäkt − inköp − avgifter − butiksersättning (butikens del enligt avtalet); utan VMB som standard (VMB-moms 0), med VMB-moms dragen bara när vyknappen \"Med VMB\" är på (följer sidan där frågan ställdes).",
  roles: ECONOMY_ROLES,
  input: profitabilityInput,
  async run(ctx: ToolContext, input) {
    const period = periodFrom(ctx, input);
    const scope = await resolveScope(ctx, input);
    const data = await loadDomainInputFor(
      ctx.viewer,
      { period, compare: null, ...scopeIds(scope), vmb: ctx.vmb },
      ctx.now,
    );
    const groupBy = GROUPS[input.per];
    const isTime = groupBy === "day" || groupBy === "week" || groupBy === "month";
    const result = profitability(data.current, groupBy, { fillTimeGaps: false });
    const names = nameMaps(data);
    const sort = input.sortera ?? (isTime ? "tid" : "vinst");
    const limit = input.antal ?? 10;

    const items = result.rows.filter((r) => r.kind === "item" || r.kind === "time");
    const special = result.rows.filter(
      (r) => r.kind !== "item" && r.kind !== "time" && r.kind !== "total",
    );
    const sorted =
      sort === "tid"
        ? [...items].sort((a, b) => (a.key < b.key ? -1 : 1))
        : [...items].sort((a, b) => {
            const d = sortValue(b, sort) - sortValue(a, sort);
            return (input.ordning === "lagst" ? -d : d) || (a.key < b.key ? -1 : 1);
          });

    const label = (r: ProfitabilityRow): string => {
      if (r.range) return periodText(r.range) + (r.partial ? " (del av perioden)" : "");
      if (groupBy === "machine") {
        const m = names.machine.get(r.key);
        return m ? `${m.name} (${m.code})` : r.key;
      }
      if (groupBy === "store") return names.store.get(r.key) ?? r.key;
      return names.title.get(r.key) ?? r.key;
    };
    const row = (r: ProfitabilityRow, i: number) => ({
      plats: i + 1,
      namn: label(r),
      id: r.key,
      intakt: kr(rowRevenue(r)),
      intaktOre: rowRevenue(r),
      inkop: kr(r.costOre),
      inkopOre: r.costOre,
      vmbMoms: kr(r.vmbVatOre),
      vmbMomsOre: r.vmbVatOre,
      butiksersattning: kr(r.compensationOre),
      butiksersattningOre: r.compensationOre,
      vinst: kr(r.profitOre),
      vinstOre: r.profitOre,
      marginal: pct(r.marginBp),
      marginalBp: r.marginBp,
      order: r.orders,
      orderUtanInkopspris: r.unpricedOrders,
    });
    const shown = sorted.slice(0, limit);
    const t = result.totals;
    const top = shown[0];
    const where = scopeText(scope);
    const linkScope = (r: ProfitabilityRow) =>
      groupBy === "machine"
        ? { machineId: r.key, storeId: scope.store?.id ?? null }
        : groupBy === "store"
          ? { storeId: r.key, machineId: scope.machine?.id ?? null }
          : scopeIds(scope);

    return {
      summary: top
        ? `${periodText(period)}${where}, per ${GROUP_LABEL[input.per]} (${items.length} rader, sorterat på ${sort}): först ${label(top)} med vinst ${kr(top.profitOre)} och intäkt ${kr(rowRevenue(top))}. Totalt vinst ${kr(t.profitOre)}.`
        : `${periodText(period)}${where}: inga order.`,
      data: {
        period: periodData(period),
        per: input.per,
        sorterat: sort,
        ordning:
          sort === "tid"
            ? "äldst först"
            : input.ordning === "lagst"
              ? "lägst först"
              : "högst först",
        antalRader: items.length,
        visade: shown.length,
        rader: shown.map(row),
        ovrigaRader: special.map((r) => ({
          namn: SPECIAL_ROWS[r.key] ?? r.key,
          intakt: kr(rowRevenue(r)),
          vinst: kr(r.profitOre),
          vinstOre: r.profitOre,
          order: r.orders,
        })),
        totalt: {
          intakt: kr(rowRevenue(t)),
          intaktOre: rowRevenue(t),
          vinst: kr(t.profitOre),
          vinstOre: t.profitOre,
          marginal: pct(t.marginBp),
          marginalBp: t.marginBp,
          order: t.orders,
        },
        utanInkopspris: {
          order: result.unpriced.orders,
          intakt: kr(result.unpriced.revenueOre),
          andel: pct(result.unpriced.shareBp),
        },
      },
      figures: shown.slice(0, 5).map((r) => ({
        label: label(r),
        value: `${kr(r.profitOre)} vinst · ${kr(rowRevenue(r))} intäkt`,
      })),
      links: [
        { label: "Lönsamhet", href: pageHref("/lonsamhet", period, scopeIds(scope)) },
        ...(top && (groupBy === "machine" || groupBy === "store")
          ? [
              {
                label: `Lönsamhet för ${label(top)}`,
                href: pageHref("/lonsamhet", period, linkScope(top)),
              },
            ]
          : []),
      ],
    };
  },
});

// ---------------------------------------------------------------------------
// iakttagelser
// ---------------------------------------------------------------------------

const insightsInput = z.object({ ...periodSchema }).strict();

export const insightsTool = defineTool({
  name: "iakttagelser",
  title: "Iakttagelser",
  label: () => "Iakttagelser",
  description:
    "Upp till fyra iakttagelser om perioden, framräknade med fasta regler: koncentration till en titel, titlar som ökat eller minskat, bästa dag, veckodagsmönster, titlar med förlust, stillastående automater. Varje iakttagelse har text, siffror och länk. Använd för 'vad är värt att veta', 'något som sticker ut'.",
  roles: ECONOMY_ROLES,
  input: insightsInput,
  async run(ctx: ToolContext, input) {
    const period = periodFrom(ctx, input);
    const compare = periodBefore(period);
    const data = await loadDomainInputFor(ctx.viewer, { period, compare, vmb: ctx.vmb }, ctx.now);
    const insights = computeInsights(
      {
        ...data.sources,
        orders: [...data.current.orders, ...(data.previous?.orders ?? [])],
        titles: data.titles,
        machines: data.machines,
      },
      period,
      compare,
      { now: ctx.now, timeZone: ctx.timeZone },
    );
    return {
      summary:
        insights.length === 0
          ? `${periodText(period)}: inga iakttagelser (för lite data).`
          : `${periodText(period)}: ${insights.length} iakttagelser. ${insights[0]!.text}.`,
      data: {
        period: periodData(period),
        jamforelseperiod: periodData(compare),
        iakttagelser: insights.map((i) => ({
          text: i.text,
          detalj: i.detail,
          regel: i.evidence.rule,
          lank: i.link,
        })),
      },
      figures: insights.map((i) => ({ label: i.text, value: i.detail })),
      links: insights.slice(0, 3).map((i) => ({ label: i.text, href: i.link })),
    };
  },
});
