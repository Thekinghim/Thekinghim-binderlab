/**
 * Automat-rankingens texter: rubrik, omdöme och rader för Automater och raden på Hem.
 * Ren funktion utan I/O. Reglerna (median, trösklar, förra perioden) finns i
 * @/analytics/ranking/fleet; talen kommer från Enhetsekonomi, så samma automat har samma
 * vinst per dag på båda sidorna.
 */

import {
  FLEET_MIN_DAYS,
  type FleetRanking,
  type FleetRow,
  type FleetVerdict,
} from "@/analytics/ranking/fleet";
import { tenths } from "@/analytics/todos/text";
import { formatInt, formatSek, MINUS, NBSP } from "@/lib/format";

export interface RankRow {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly href: string;
  readonly rank: number;
  readonly verdict: FleetVerdict;
  /** "Bäst" · "Går bra" · "Går dåligt: överväg att flytta" … */
  readonly verdictText: string;
  /** Omdömet behöver uppmärksamhet (går dåligt eller sämre). */
  readonly warn: boolean;
  /** "412 kr/dag" */
  readonly profit: string;
  /** "Säljer 1 240 kr/dag · 14,2 pack/dag" */
  readonly sales: string;
  /** "Titlar slutsålda 3,5 dagar · ca 320 kr förlorat", eller null (inget slutsålt eller okänt). */
  readonly lost: string | null;
  /** "30 dagar · 40 kr/dag mer än en vanlig automat" */
  readonly basis: string;
  readonly bar: number;
}

export interface RankingView {
  readonly mode: FleetRanking["mode"];
  readonly rows: RankRow[];
  readonly title: string;
  readonly aside: string;
  /** "Vinst före butikernas andel." */
  readonly note: string;
}

export function perDayText(ore: number): string {
  return `${formatSek(ore / 100)}/dag`;
}

function signedPct(bp: number): string {
  return `${bp >= 0 ? "+" : MINUS}${formatInt(Math.abs(bp) / 100)}${NBSP}%`;
}

function daysText(n: number): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? "dag" : "dagar"}`;
}

export function verdictText(r: Pick<FleetRow, "verdict" | "activeDays">): string {
  switch (r.verdict) {
    case "best":
      return "Bäst";
    case "good":
      return "Går bra";
    case "weak":
      return "Går dåligt: överväg att flytta";
    case "new":
      return `För ny: ${daysText(r.activeDays)}`;
    case "alone":
      return "Inget att jämföra med än";
    case "better":
      return "Går bättre än förra perioden";
    case "same":
      return "Går som förra perioden";
    case "worse":
      return "Går sämre än förra perioden";
  }
}

function lostText(r: FleetRow): string | null {
  if (r.stockoutDayTenths === null || r.lostRevenueOre === null) return null;
  if (r.stockoutDayTenths <= 0 && r.lostRevenueOre <= 0) return null;
  // Summan över automatens titlar: kan vara fler dagar än perioden, därför "Titlar".
  const days = `Titlar slutsålda ${tenths(r.stockoutDayTenths)}${NBSP}dagar`;
  return r.lostRevenueOre > 0 ? `${days} · ca ${formatSek(r.lostRevenueOre / 100)} förlorat` : days;
}

function basisText(r: FleetRow): string {
  const days = daysText(r.activeDays);
  // "En vanlig automat" = medianen (den mittersta) av automaterna med nog många dagar.
  if (r.vsMedianOre !== null) {
    return r.vsMedianOre === 0
      ? `${days} · som en vanlig automat`
      : `${days} · ${perDayText(Math.abs(r.vsMedianOre))} ${
          r.vsMedianOre > 0 ? "mer" : "mindre"
        } än en vanlig automat`;
  }
  if (r.previousProfitPerDayOre !== null) {
    return `${days} · förra perioden ${perDayText(r.previousProfitPerDayOre)}${
      r.vsPreviousBp === null ? "" : ` (${signedPct(r.vsPreviousBp)})`
    }`;
  }
  return days;
}

export function rankingView(args: {
  ranking: FleetRanking;
  machines: ReadonlyMap<string, { code: string; name: string }>;
  hrefOf: (code: string) => string;
  storeShareDeducted: boolean;
}): RankingView {
  const { ranking } = args;
  const codeOf = (id: string) => args.machines.get(id)?.code ?? "Automaten";
  const rows: RankRow[] = ranking.rows
    .filter((r) => args.machines.has(r.machineId))
    .map((r) => {
      const m = args.machines.get(r.machineId)!;
      return {
        machineId: r.machineId,
        code: m.code,
        name: m.name,
        href: args.hrefOf(m.code),
        rank: r.rank,
        verdict: r.verdict,
        verdictText: verdictText(r),
        warn: r.verdict === "weak" || r.verdict === "worse",
        profit: perDayText(r.profitPerDayOre),
        sales: `Säljer ${perDayText(r.revenuePerDayOre)} · ${tenths(r.unitsPerDayTenths)}${NBSP}pack/dag`,
        lost: lostText(r),
        basis: basisText(r),
        bar: r.bar,
      };
    });

  let title: string;
  let aside: string;
  const only = ranking.rows[0];
  if (ranking.mode === "empty" || !only) {
    title = "Ingen automat har sålt i perioden.";
    aside = "Välj en längre period.";
  } else if (ranking.mode === "single") {
    title = `${codeOf(only.machineId)} tjänar ${perDayText(only.profitPerDayOre)}.`;
    aside =
      only.verdict === "new"
        ? `För lite data: ${daysText(only.activeDays)}. Minst ${FLEET_MIN_DAYS} behövs.`
        : only.verdict === "alone"
          ? "Bara en automat och ingen förra period: inget att jämföra med än."
          : `${verdictText(only)}${only.vsPreviousBp === null ? "" : ` (${signedPct(only.vsPreviousBp)})`}.`;
  } else {
    const weak = ranking.weak;
    title = ranking.best
      ? `${codeOf(ranking.best.machineId)} tjänar mest: ${perDayText(ranking.best.profitPerDayOre)}.`
      : "Vinst per dag.";
    aside =
      weak.length === 1
        ? `${codeOf(weak[0]!.machineId)} går dåligt: överväg att flytta den.`
        : weak.length > 1
          ? `${formatInt(weak.length)}${NBSP}automater går dåligt: överväg att flytta dem.`
          : ranking.medianProfitPerDayOre === null
            ? `För lite data för att jämföra: minst två automater behöver ${FLEET_MIN_DAYS}${NBSP}dagar.`
            : "Ingen automat går dåligt.";
  }
  return {
    mode: ranking.mode,
    rows,
    title,
    aside,
    note: args.storeShareDeducted
      ? "Vinst efter butikernas andel."
      : "Vinst före butikernas andel.",
  };
}

/**
 * Raden på Hem (bara med minst två automater som sålt): "BL-003 tjänar mest: 412 kr/dag.
 * BL-007 går dåligt: överväg att flytta den." null när det inte finns något att säga.
 */
export function homeRankingLine(view: RankingView, ranking: FleetRanking): string | null {
  if (view.mode !== "fleet") return null;
  if (!ranking.best && ranking.weak.length === 0) return null;
  return ranking.best ? `${view.title} ${view.aside}` : view.aside;
}
