/**
 * KPI-bandet på Hem (V2, byggplanen 3.5): åtta rutor för vald period. Allt ur befintliga
 * modeller: Hems nyckeltal (intäkt, vinst, marginal, sålda pack, snittköp, med jämförelse och
 * dagsserie), takten i dag (_hem/pace.ts, intäkt mot samma klockslag en vanlig veckodag),
 * vinst per automat och dag (vinsten ÷ automatdagar, @/analytics/home-v2) och lagervärdet
 * (Vårt lager: hemma + i automaterna till inköpspris).
 *
 * Bara ekonomiroller; påfyllaren får null och ser inte bandet.
 */

import "server-only";

import { changeBp, kpiDeltaBp, machineDays, profitPerMachineDayOre } from "@/analytics/home-v2";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { loadContext, loadDomainInput, loadPeriod } from "@/server/data/core";

import type { HomeKpi } from "@/app/(app)/_hem/model";
import { hemKey, loadHemCore, loadHemStock } from "./hem-base";

export type KpiTileUnit = "ore" | "bp" | "count";

export interface KpiBandTile {
  readonly id: string;
  readonly label: string;
  readonly value: number | null;
  readonly unit: KpiTileUnit;
  readonly deltaBp: number | null;
  readonly deltaUnit: "pct" | "pe";
  readonly compare: string | null;
  readonly trend: readonly number[];
  readonly href: string;
}

const WEEKDAY = ["mån", "tis", "ons", "tor", "fre", "lör", "sön"];

function fromKpi(k: HomeKpi | undefined, label: string, href: string, compare: string | null) {
  if (!k) return null;
  const deltaBp = kpiDeltaBp(k.delta, k.deltaKind);
  return {
    id: k.id,
    label,
    value: k.value,
    unit: k.unit,
    deltaBp,
    deltaUnit: k.deltaKind === "absolute" ? ("pe" as const) : ("pct" as const),
    compare: deltaBp === null ? null : compare,
    trend: k.trend,
    href,
  } satisfies KpiBandTile;
}

/** Värdet av lagret till inköpspris: hemma + i automaterna (öre), eller null. */
export function stockValueOre(
  rows: readonly {
    readonly home: number;
    readonly inMachines: number;
    readonly unitCostOre: number | null;
  }[],
): number | null {
  let sum = 0;
  let any = false;
  for (const r of rows) {
    if (r.unitCostOre === null) continue;
    const packs = Math.max(0, r.home) + Math.max(0, r.inMachines);
    if (packs === 0) continue;
    sum += packs * r.unitCostOre;
    any = true;
  }
  return any ? sum : null;
}

export async function loadKpiBand(sp: SearchParamsInput): Promise<KpiBandTile[] | null> {
  const key = hemKey(sp);
  const [ctx, home] = await Promise.all([loadContext(), loadHemCore(key)]);
  if (!ctx.canSeeEconomy || !home) return null;
  const p = await loadPeriod(sp);
  const [input, stock] = await Promise.all([
    loadDomainInput({ period: p.period, compare: p.compare, ...p.scope }),
    loadHemStock(),
  ]);
  const kpis = new Map(home.model.kpis.map((k) => [k.id, k]));
  const today = p.key === "idag";
  const compare = today ? "mot i går" : "mot förra";
  const lp = (extra: string) => `/lonsamhet${extra}`;

  const rawProfit = kpis.get("profit");
  // Inga order i perioden: vinsten är 0 kr (inte "–"), som intäkten.
  const noSales = (kpis.get("orders")?.value ?? 0) === 0;
  const profit =
    rawProfit && rawProfit.value === null && noSales ? { ...rawProfit, value: 0 } : rawProfit;
  const md = machineDays(input.machines, p.period);
  const mdPrev = p.compare ? machineDays(input.machines, p.compare) : 0;
  const perMachine = profitPerMachineDayOre(profit?.value ?? null, md);
  // Jämförelseperiodens vinst direkt ur modellen (att räkna baklänges ur förändringen blir fel
  // när den förra vinsten var negativ eller den nya är 0).
  const prevProfit = profit?.previous ?? null;
  const perMachinePrev = profitPerMachineDayOre(prevProfit, mdPrev);

  const pace = home.pace;
  const tiles: (KpiBandTile | null)[] = [
    fromKpi(profit, today ? "Vinst i dag" : "Vinst", lp(""), compare),
    // Fast uppsättning rutor (layouten hoppar inte): utan takt står rutan kvar med "–".
    {
      id: "pace",
      label: "Intäkt i dag",
      value: pace ? pace.soFarOre : null,
      unit: "ore",
      deltaBp: pace && pace.baselineSoFarOre > 0 ? pace.deltaBp : null,
      deltaUnit: "pct",
      compare:
        pace && pace.baselineSoFarOre > 0
          ? `mot vanlig ${WEEKDAY[pace.weekday - 1] ?? "dag"}`
          : null,
      trend: pace ? pace.todayHourly : [],
      href: lp("?period=idag"),
    },
    fromKpi(kpis.get("revenue"), "Intäkt", lp(""), compare),
    fromKpi(kpis.get("orders"), "Sålda pack", "/order", compare),
    fromKpi(kpis.get("aov"), "Snittköp", "/order", compare),
    fromKpi(kpis.get("margin"), "Marginal", lp(""), compare),
    {
      id: "per-machine",
      label: "Vinst/automat/dag",
      value: perMachine,
      unit: "ore",
      deltaBp: changeBp(perMachine, perMachinePrev),
      deltaUnit: "pct",
      compare: changeBp(perMachine, perMachinePrev) === null ? null : compare,
      trend: [],
      href: "/automater",
    },
    {
      id: "stock-value",
      label: "Lagervärde",
      value: stock ? stockValueOre(stock.rows) : null,
      unit: "ore",
      deltaBp: null,
      deltaUnit: "pct",
      compare: "till inköpspris",
      trend: [],
      href: "/vart-lager",
    },
  ];
  return tiles.filter((t): t is KpiBandTile => t !== null);
}
