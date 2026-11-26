/**
 * Analyskorten på Hem: Resultat, Vinst per stad, Mest sålda, Sämst presterande, Mål, Butiker
 * och Lager. Samma laddare som Pengar och Butiker, så att talen är desamma på sidorna:
 * Lönsamhets modell (loadHemProfit = Pengars loadMoneyProfit, samma minne per förfrågan),
 * underpresterarna (loadMoneyWorst), månadens mål (loadMoneyGoal), att betala
 * (loadMoneyPay, samma urval som Utbetalning) och Vårt lager. Hem formar dem bara för sina
 * kort (timmar i dag, antal sålda, råd per automat).
 *
 * Bara ekonomiroller (null annars), utom Lager som påfyllaren också får (utan kronor) när
 * Vårt lager släpps för påfyllaren (G3).
 */

import "server-only";

import { profitByCity, titleTrendBp, type CityLine } from "@/analytics/home-v2";
import { chartUnitFor, compareText, type SearchParamsInput } from "@/components/shell/period-state";
import { addDays, type IsoDate } from "@/domain";
import { loadContext, loadDomainInput, loadPeriod } from "@/server/data/core";
import {
  hemKey,
  loadHemCore,
  loadHemProfit,
  loadHemStock,
} from "@/server/data/v2/analytics/hem-base";
import { loadDaySales } from "@/server/data/v2/analytics/day-sales";
import { loadMoneyPay } from "@/server/data/v2/analytics/shops";
import { loadMoneyWorst } from "@/server/data/v2/analytics/worst";
import { loadFleetState } from "@/server/data/v2/fleet";

import { missingSettlements, previousProfitOre, type MissingSettlements } from "./cards-model";

/* ------------------------------------------------------------------ */
/* Resultat                                                            */
/* ------------------------------------------------------------------ */

export interface ResultBar {
  readonly key: string;
  readonly label: string;
  /** Intäkt (öre), staplarnas höjd. */
  readonly value: number;
  /** Vinst (öre), den mörka delen. Saknas för timmar (bara intäkt). */
  readonly part?: number;
  readonly previous?: number | null;
  readonly partial: boolean;
}

export interface ResultCard {
  readonly profitOre: number | null;
  readonly revenueOre: number | null;
  readonly orders: number | null;
  readonly marginBp: number | null;
  readonly profitDeltaBp: number | null;
  readonly profitDeltaOre: number | null;
  readonly unit: "vecka" | "dag" | "timme" | "månad";
  readonly bars: ResultBar[];
  readonly best: { readonly label: string; readonly profitOre: number } | null;
  /** Förra periodens vinst per stapel i snitt (öre), för texten. */
  readonly previousPerBarOre: number | null;
  readonly periodText: string;
  /** Timmarna är i dag med "vanlig dag samma timme" som jämförelse (annars en hel dag). */
  readonly pace: boolean;
  /** "mot dagen innan", "mot förra 7 dagarna" (periodmodellens jämförelse). */
  readonly compareText: string;
}

export async function loadResultCard(sp: SearchParamsInput): Promise<ResultCard | null> {
  const key = hemKey(sp);
  const [home, profit, p] = await Promise.all([
    loadHemCore(key),
    loadHemProfit(key),
    loadPeriod(sp),
  ]);
  if (!home || !profit) return null;
  const kpi = new Map(home.model.kpis.map((k) => [k.id, k]));
  const profitKpi = kpi.get("profit");
  // Jämförelseperiodens vinst som den är (samma tal som hjältekortets "mot förra"), inte
  // räknad baklänges ur den avrundade förändringen.
  const prevProfit = previousProfitOre(profitKpi);

  let unit: ResultCard["unit"];
  let bars: ResultBar[];
  // Upplösningen följer periodens längd (chartUnitFor): en dag per timme, upp till 31 dagar
  // per dag, upp till ett halvår per vecka, längre per månad.
  const chart = chartUnitFor(p.days);
  const daySales = chart === "hour" && p.key !== "idag" ? await loadDaySales(sp) : null;
  if (daySales && daySales.sales.hours.length === 24) {
    // En hel dag (I går, ett eget datum): intäkten per timme ur dagens order.
    unit = "timme";
    bars = daySales.sales.hours.map((h) => ({
      key: String(h.hour),
      label: String(h.hour).padStart(2, "0"),
      value: h.revenueOre,
      previous: null,
      partial: false,
    }));
  } else if (p.key === "idag" && home.pace) {
    unit = "timme";
    const hourly = home.pace.todayHourly.map((v, i, a) =>
      Math.max(0, v - (i > 0 ? (a[i - 1] ?? 0) : 0)),
    );
    const base = home.pace.baselineHourly.map((v, i, a) =>
      Math.max(0, v - (i > 0 ? (a[i - 1] ?? 0) : 0)),
    );
    bars = hourly.map((v, h) => ({
      key: String(h),
      label: String(h).padStart(2, "0"),
      value: v,
      previous: base[h] ?? null,
      partial: h === hourly.length - 1,
    }));
  } else {
    const trendKey = chart === "week" ? "week" : chart === "month" ? "month" : "day";
    unit = trendKey === "day" ? "dag" : trendKey === "week" ? "vecka" : "månad";
    const buckets = profit.model.trend[trendKey].buckets;
    const prevPer =
      prevProfit !== null && buckets.length > 0 ? Math.round(prevProfit / buckets.length) : null;
    bars = buckets.map((b) => ({
      key: b.key,
      label: trendKey === "week" ? b.axis.replace(/^V/, "v. ") : b.axis,
      value: Math.max(0, b.revenueOre),
      part: Math.max(0, b.profitOre),
      previous: prevPer,
      partial: b.partial,
    }));
  }
  const withProfit = bars.filter((b) => b.part !== undefined);
  const bestBar = withProfit.reduce<ResultBar | null>(
    (best, b) => (best === null || (b.part ?? 0) > (best.part ?? 0) ? b : best),
    null,
  );
  return {
    profitOre: profitKpi?.value ?? null,
    // Intäkten med inköpspris (som Pengars Resultat och marginalen), inte alla order.
    revenueOre: profit.model.bridge.revenueOre,
    orders: kpi.get("orders")?.value ?? null,
    marginBp: kpi.get("margin")?.value ?? null,
    profitDeltaBp: profitKpi?.delta != null ? Math.round(profitKpi.delta * 10_000) : null,
    profitDeltaOre:
      profitKpi?.value != null && prevProfit !== null ? profitKpi.value - prevProfit : null,
    unit,
    bars,
    best:
      bestBar && (bestBar.part ?? 0) > 0
        ? { label: bestBar.label, profitOre: bestBar.part ?? 0 }
        : null,
    previousPerBarOre:
      unit === "timme"
        ? null
        : prevProfit !== null && bars.length > 0
          ? Math.round(prevProfit / bars.length)
          : null,
    periodText: profit.model.periodLabel,
    pace: unit === "timme" && !daySales,
    compareText: compareText(p.resolved) ?? "mot förra perioden",
  };
}

/* ------------------------------------------------------------------ */
/* Vinst per stad / automat                                            */
/* ------------------------------------------------------------------ */

export interface GeoMachine {
  readonly machineId: string;
  readonly code: string | null;
  readonly name: string;
  readonly city: string | null;
  readonly profitOre: number;
  readonly revenueOre: number;
}

export interface GeoCard {
  readonly cities: CityLine[];
  readonly machines: GeoMachine[];
  readonly totalOre: number;
  readonly perMachineOre: number;
}

export async function loadGeoCard(sp: SearchParamsInput): Promise<GeoCard | null> {
  const [profit, fleet] = await Promise.all([loadHemProfit(hemKey(sp)), loadFleetState()]);
  if (!profit) return null;
  const byId = new Map(fleet.machines.map((m) => [m.id, m]));
  const machines: GeoMachine[] = profit.model.views.machine
    .filter((l) => l.kind === "item")
    .map((l) => {
      const f = byId.get(l.key);
      return {
        machineId: l.key,
        code: l.code,
        name: l.name,
        city: f?.store?.city ?? null,
        profitOre: l.profitOre,
        revenueOre: l.revenueOre,
      };
    });
  const cities = profitByCity(machines);
  const total = machines.reduce((a, m) => a + m.profitOre, 0);
  return {
    cities,
    machines: [...machines].sort((a, b) => b.profitOre - a.profitOre),
    totalOre: total,
    perMachineOre: machines.length > 0 ? Math.round(total / machines.length) : 0,
  };
}

/* ------------------------------------------------------------------ */
/* Mest sålda                                                          */
/* ------------------------------------------------------------------ */

export interface TopTitle {
  readonly titleId: string;
  readonly name: string;
  readonly orders: number;
  readonly revenueOre: number;
  /** Vinst per pack (öre) på order med inköpspris, eller null. */
  readonly profitPerPackOre: number | null;
  /** Sålda per dag senaste 7 dagarna mot hela perioden (bp), eller null. */
  readonly trendBp: number | null;
}

export async function loadTopCard(sp: SearchParamsInput): Promise<TopTitle[] | null> {
  const key = hemKey(sp);
  const [profit, p, ctx] = await Promise.all([loadHemProfit(key), loadPeriod(sp), loadContext()]);
  if (!profit) return null;
  const input = await loadDomainInput({ period: p.period, compare: p.compare, ...p.scope });
  const from7: IsoDate = addDays(p.period.end, -6);
  const n7 = new Map<string, number>();
  const nAll = new Map<string, number>();
  for (const o of input.current.orders) {
    nAll.set(o.titleId, (nAll.get(o.titleId) ?? 0) + 1);
    if (o.businessDate >= from7) n7.set(o.titleId, (n7.get(o.titleId) ?? 0) + 1);
  }
  const days = Math.max(1, p.days);
  void ctx;
  return profit.model.views.title
    .filter((l) => l.kind === "item")
    .sort((a, b) => b.orders - a.orders || b.revenueOre - a.revenueOre)
    .slice(0, 5)
    .map((l) => {
      const priced = l.orders - l.unpricedOrders;
      return {
        titleId: l.key,
        name: l.name,
        orders: l.orders,
        revenueOre: l.revenueOre + l.unpricedRevenueOre,
        profitPerPackOre: priced > 0 ? Math.round(l.profitOre / priced) : null,
        trendBp: days > 7 ? titleTrendBp(n7.get(l.key) ?? 0, nAll.get(l.key) ?? 0, days) : null,
      };
    });
}

/* ------------------------------------------------------------------ */
/* Sämst presterande                                                   */
/* ------------------------------------------------------------------ */

export interface WorstMachine {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly storeName: string | null;
  readonly profitPerDayOre: number;
  readonly vsMedianBp: number | null;
  readonly hint: string;
  readonly action: { readonly label: string; readonly href: string };
}

export interface WorstCard {
  readonly medianOre: number | null;
  readonly rows: WorstMachine[];
}

/** Vad man gör (byggplanen 2.2): fylld och säljer lite = fel plats; halvfull = fyll på / fel titlar. */
export function worstHint(
  fillBp: number | null,
  emptyChannels: number,
): { hint: string; fill: boolean } {
  if (emptyChannels > 0) return { hint: `${emptyChannels} fack tomma`, fill: true };
  if (fillBp !== null && fillBp >= 7_000)
    return { hint: "Fylld men säljer lite: pröva en annan plats", fill: false };
  if (fillBp !== null && fillBp <= 5_000)
    return { hint: "Halvfull: fyll på eller byt titlar", fill: true };
  return { hint: "Tjänar under hälften av en vanlig automat", fill: false };
}

export async function loadWorstCard(): Promise<WorstCard | null> {
  // Samma urval och ordning som Pengars Underpresterar; fyllnaden ur flottans läge för rådet.
  const [worst, fleet] = await Promise.all([loadMoneyWorst(), loadFleetState()]);
  if (!worst) return null;
  const fillOf = new Map(fleet.machines.map((m) => [m.id, m.fill]));
  const rows = worst.rows.slice(0, 5).map((m) => {
    const fill = fillOf.get(m.machineId) ?? null;
    const h = worstHint(fill?.fillBp ?? null, fill?.emptyChannels ?? 0);
    return {
      machineId: m.machineId,
      code: m.code,
      name: m.name,
      storeName: m.storeName,
      profitPerDayOre: m.profitPerDayOre,
      vsMedianBp: m.vsMedianBp,
      hint: h.hint,
      action: h.fill
        ? { label: "Fyll på", href: `/fyll-pa/${m.machineId}?fran=hem` }
        : { label: "Visa", href: `/automater?valj=${encodeURIComponent(m.code)}` },
    };
  });
  return { medianOre: worst.medianProfitPerDayOre, rows };
}

/* ------------------------------------------------------------------ */
/* Butiker                                                             */
/* ------------------------------------------------------------------ */

export interface ShopsCard {
  readonly unpaidOre: number;
  readonly stores: number;
  readonly oldestDue: IsoDate | null;
  readonly oldestStore: string | null;
  readonly rows: readonly {
    readonly storeId: string;
    readonly name: string;
    readonly leftOre: number;
    readonly due: IsoDate;
  }[];
  readonly split: {
    readonly totalOre: number;
    readonly storesOre: number;
    readonly ourOre: number;
  } | null;
  /**
   * Butiker utan avräkning (samma som "Saknas" på Utbetalning och "Skapa
   * oktober-avräkningarna" i Att göra): texten, äldsta månadens sista dag och länken. null
   * när inget saknas.
   */
  readonly missing: MissingSettlements | null;
}

export async function loadShopsCard(sp: SearchParamsInput): Promise<ShopsCard | null> {
  const ctx = await loadContext();
  if (!ctx.canSeeEconomy) return null;
  const [home, pay] = await Promise.all([
    loadHemCore(hemKey(sp)),
    // Samma "att betala" som Pengar och Butiker (obetalda, inte spärrade, minus förskott).
    loadMoneyPay().catch((error: unknown) => {
      console.error("[hem] Avräkningarna kunde inte läsas:", error);
      return null;
    }),
  ]);
  const byStore = new Map<string, { name: string; leftOre: number; due: IsoDate }>();
  for (const r of pay?.items ?? []) {
    const cur = byStore.get(r.storeId);
    byStore.set(r.storeId, {
      name: r.storeName,
      leftOre: (cur?.leftOre ?? 0) + r.leftOre,
      due: cur && cur.due < r.due ? cur.due : r.due,
    });
  }
  const rows = [...byStore.entries()]
    .map(([storeId, v]) => ({ storeId, ...v }))
    .sort((a, b) => a.due.localeCompare(b.due) || b.leftOre - a.leftOre);
  const split = home?.model.profitSplit ?? null;
  return {
    unpaidOre: pay?.totalOre ?? 0,
    stores: rows.length,
    oldestDue: rows[0]?.due ?? null,
    oldestStore: rows[0]?.name ?? null,
    rows,
    split: split
      ? { totalOre: split.totalOre, storesOre: split.storesOre, ourOre: split.ourOre }
      : null,
    missing: missingSettlements(pay?.missing ?? []),
  };
}

/* ------------------------------------------------------------------ */
/* Lager                                                               */
/* ------------------------------------------------------------------ */

export interface StockCard {
  readonly home: number;
  readonly inMachines: number;
  readonly homeValueOre: number | null;
  readonly machineValueOre: number | null;
  readonly runsOut: readonly {
    readonly titleId: string;
    readonly name: string;
    readonly home: number;
    readonly lastsDays: number | null;
    readonly perDayTenths: number | null;
    readonly verb: "Packa" | "Beställ" | null;
  }[];
  readonly runsOutCount: number;
}

/** Titlar som räcker kortare än så här (dagar) står i kortet. */
export const STOCK_SHORT_DAYS = 7;

export async function loadStockCard(): Promise<StockCard | null> {
  const stock = await loadHemStock();
  if (!stock) return null;
  let homeValue = 0;
  let machineValue = 0;
  let priced = false;
  for (const r of stock.rows) {
    if (r.unitCostOre === null) continue;
    priced = true;
    homeValue += Math.max(0, r.home) * r.unitCostOre;
    machineValue += Math.max(0, r.inMachines) * r.unitCostOre;
  }
  const short = stock.rows
    .filter((r) => !r.retired && r.lastsDays !== null && r.lastsDays < STOCK_SHORT_DAYS)
    .sort((a, b) => (a.lastsDays ?? 0) - (b.lastsDays ?? 0) || a.name.localeCompare(b.name, "sv"));
  return {
    home: stock.totals.home,
    inMachines: stock.totals.inMachines,
    homeValueOre: priced ? homeValue : null,
    machineValueOre: priced ? machineValue : null,
    runsOut: short.slice(0, 4).map((r) => ({
      titleId: r.titleId,
      name: r.name,
      home: r.home,
      lastsDays: r.lastsDays,
      perDayTenths: r.sold7 > 0 ? Math.round((r.sold7 * 10) / 7) : null,
      verb: r.action ? (r.own ? "Packa" : "Beställ") : null,
    })),
    runsOutCount: short.length,
  };
}
