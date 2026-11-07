/**
 * Kontroll 1, inläsningen: vår vinst och marginal som sidorna själva räknar dem, med
 * sidornas egna laddare och vymodeller, för en given användare (ägare eller admin) och
 * vyknappen "Visa butikernas andel" av och på:
 *
 *   Hem        loadHomeWith (samma funktion som sidan) → nyckeltalen Vår vinst/Vår marginal
 *   Lönsamhet  loadLonsamhetWith (samma funktion som sidan) → nyckeltalen, summan av
 *              raderna per titel, automat och butik, och av staplarna per dag
 *   Automater  loadOverviewWith → nyckeltalen och summan av raderna
 *   Butiker    loadStoreListWith → summan av raderna
 *   Värde      loadValueFor → kvar efter inköp (före andelen) och vår del per butik
 *
 * Perioder: de senaste 30 dagarna, denna månad (t.o.m. i dag) och förra månaden (hel).
 * Värde räknar hela månader t.o.m. i går, så Värde jämförs för förra månaden och för denna
 * månad t.o.m. i går. Butikernas andel jämförs med avräkningsmotorn: storeCompensation
 * (samma liggare som avräkningarna) för varje period, och för förra månaden också med
 * månadens avräkningar (computeSettlementsTx), det butikerna faktiskt ska få.
 *
 * Läser bara. Allt läses under RLS som användaren.
 */

import "server-only";

import type { ProfitPeriodFigures, ProfitSource, ShareEngine } from "@/analytics/self-check";
import { loadHomeWith } from "@/app/(app)/_hem/data";
import { loadOverviewWith } from "@/app/(app)/automater/_lib/data";
import { loadStoreListWith } from "@/app/(app)/butiker/_lib/data";
import { loadLonsamhetWith } from "@/app/(app)/lonsamhet/_lib/data";
import { monthName } from "@/analytics/todos/text";
import {
  addDays,
  addMonths,
  monthEnd,
  monthOf,
  monthStart,
  profitability,
  storeCompensation,
  type IsoDate,
  type IsoMonth,
} from "@/domain";
import { withUserDbFor } from "@/server/access";
import { businessToday, loadDataStartFor, type Viewer } from "@/server/data/core/loaders";
import { viewerPageLoaders, type PageLoaders } from "@/server/data/page-loaders";
import { computeSettlementsTx } from "@/server/settlements/live";
import { loadValueFor } from "@/server/varde/load";

export interface UnpricedTitle {
  readonly titleId: string;
  readonly name: string;
  readonly orders: number;
  readonly revenueOre: number;
}

export interface ProfitGathered {
  readonly periods: ProfitPeriodFigures[];
  /** Titlar som sålt utan inköpspris de senaste 30 dagarna (till datahygienen). */
  readonly unpricedTitles: UnpricedTitle[];
}

interface PeriodSpec {
  readonly label: string;
  readonly from: IsoDate;
  readonly to: IsoDate;
  /** Hel stängd månad: jämför också med månadens avräkningar. */
  readonly settlementMonth?: IsoMonth;
}

const sum = (xs: readonly { profitOre: number }[]) => xs.reduce((n, x) => n + x.profitOre, 0);

/** Lönsamhet som sidan räknar den (samma laddning och modell, ./lonsamhet/_lib/data). */
async function lonsamhet(loaders: PageLoaders, sp: { from: string; to: string }) {
  return loadLonsamhetWith(loaders, sp);
}

/** Allt som sidorna visar som vår vinst för perioden, i vyknappens läge. */
async function pageFigures(loaders: PageLoaders, spec: PeriodSpec) {
  const sp = { from: spec.from, to: spec.to };
  const [{ model: m, input }, home, automater, butiker] = await Promise.all([
    lonsamhet(loaders, sp),
    loadHomeWith(
      {
        context: loaders.context,
        period: loaders.period,
        domainInput: loaders.domainInput,
        // Bara nyckeltalen behövs: Att göra, förlorad försäljning m.m. läses inte.
        todos: async () => [],
      },
      sp,
    ),
    loadOverviewWith(loaders, sp),
    loadStoreListWith(loaders, sp),
  ]);
  const kpi = (id: string) => m.kpis.find((k) => k.id === id)?.value ?? null;
  const noStore = sum(m.views.store.filter((r) => r.kind === "no-store"));
  const homeKpi = (id: string) => home.model.kpis.find((k) => k.id === id)?.value ?? null;
  const day = m.trend.day;
  const sources: ProfitSource[] = [
    { label: "Lönsamhet nyckeltal", profitOre: kpi("profit") ?? 0, marginBp: kpi("margin") },
    { label: "Lönsamhet per titel", profitOre: sum(m.views.title) },
    { label: "Lönsamhet per automat", profitOre: sum(m.views.machine) },
    { label: "Lönsamhet per butik", profitOre: sum(m.views.store) },
    {
      label: "Lönsamhet per dag",
      profitOre: sum(day.buckets) + day.unallocatedProfitOre,
    },
    { label: "Hem nyckeltal", profitOre: homeKpi("profit") ?? 0, marginBp: homeKpi("margin") },
    {
      label: "Automater nyckeltal",
      profitOre: automater.overview.totals.profitOre,
      marginBp: automater.overview.totals.marginBp,
    },
    {
      label: "Automater rader",
      profitOre: sum(automater.overview.rows) + sum(automater.overview.others),
    },
    // Butiker listar butikerna: en automat utan butik (t.ex. ny från Awish) syns inte där,
    // men i Lönsamhet per butik som "Utan butik". Den delen räknas till Butiker här och
    // blir en varning (koppla automaten), inte en skillnad mellan sidorna.
    { label: "Butiker rader", profitOre: sum(butiker.rows) + noStore },
  ];
  return { sources, input, model: m, noStore };
}

/** Värde för månaden (t.o.m. i går om den pågår): kvar efter inköp och vår del per butik. */
async function valueFigures(viewer: Viewer, month: IsoMonth, now: Date) {
  const data = await loadValueFor(viewer, month, now);
  if (!data.hasData || !data.margin || !data.period) return null;
  return {
    period: data.period,
    kept: data.margin.current.keptOre,
    keptMarginBp: data.margin.keptMarginBp,
    ours: data.margin.stores.reduce((n, s) => n + s.ourOre, 0),
  };
}

export async function gatherProfit(viewer: Viewer, now: Date): Promise<ProfitGathered> {
  const today = businessToday(now, viewer.organization.timezone);
  const yesterday = addDays(today, -1);
  const thisMonth = monthOf(today);
  const lastMonth = addMonths(thisMonth, -1);
  const dataStartP = loadDataStartFor(viewer);
  dataStartP.catch(() => {});
  const dataStart = () => dataStartP;
  const off = viewerPageLoaders(viewer, { now, storeShare: false, dataStart });
  const on = viewerPageLoaders(viewer, { now, storeShare: true, dataStart });

  const specs: PeriodSpec[] = [
    { label: "Senaste 30 dagarna", from: addDays(today, -29), to: today },
    {
      label: `${capitalize(monthName(thisMonth))} t.o.m. i dag`,
      from: monthStart(thisMonth),
      to: today,
    },
    {
      label: capitalize(monthName(lastMonth)),
      from: monthStart(lastMonth),
      to: monthEnd(lastMonth),
      settlementMonth: lastMonth,
    },
  ];

  const periods: ProfitPeriodFigures[] = [];
  let unpricedTitles: UnpricedTitle[] = [];
  const storeIds = (await off.masterData()).stores.map((s) => s.id);

  for (const spec of specs) {
    const [a, b] = await Promise.all([pageFigures(off, spec), pageFigures(on, spec)]);
    const shares: ShareEngine[] = [
      {
        label: "avräkningsmotorn (butikernas andel enligt avtalen)",
        amountOre: storeCompensation(b.input.current).totalOre,
      },
    ];
    if (spec.settlementMonth && storeIds.length > 0) {
      const live = await withUserDbFor(viewer.user, (tx) =>
        computeSettlementsTx(tx, {
          organizationId: viewer.organization.id,
          month: spec.settlementMonth!,
          storeIds,
          now,
        }),
      );
      const all = [...live.values()];
      // En avräkning som inte går att räkna tas upp av kontrollen Avräkningar.
      if (all.every((l) => l.ok)) {
        shares.push({
          label: `avräkningarna för ${monthName(spec.settlementMonth)}`,
          amountOre: all.reduce((n, l) => n + (l.ok ? l.computed.amountOre : 0), 0),
        });
      }
    }
    const unpricedOrders = profitability(a.input.current, "title").unpriced.orders;
    periods.push({
      label: spec.label,
      off: a.sources,
      on: b.sources,
      shares,
      unpricedOrders,
      noStoreProfitOre: a.noStore,
    });
    if (unpricedTitles.length === 0 && spec === specs[0]) {
      const names = new Map(a.input.titles.map((t) => [t.id, t.name]));
      unpricedTitles = profitability(a.input.current, "title").unpriced.byTitle.map((t) => ({
        titleId: t.titleId,
        name: names.get(t.titleId) ?? "Okänd titel",
        orders: t.orders,
        revenueOre: t.revenueOre,
      }));
    }
  }

  // Värde: hela förra månaden, och denna månad t.o.m. i går.
  const valueMonths: { month: IsoMonth; label: string }[] = [
    { month: lastMonth, label: `Värde, ${monthName(lastMonth)}` },
  ];
  if (yesterday >= monthStart(thisMonth)) {
    valueMonths.push({ month: thisMonth, label: `Värde, ${monthName(thisMonth)} t.o.m. i går` });
  }
  for (const v of valueMonths) {
    const value = await valueFigures(viewer, v.month, now);
    if (!value) continue;
    const spec = { label: v.label, from: value.period.start, to: value.period.end };
    const [a, b] = await Promise.all([lonsamhet(off, spec), lonsamhet(on, spec)]);
    const kpi = (m: typeof a.model, id: string) => m.kpis.find((k) => k.id === id)?.value ?? null;
    periods.push({
      label: v.label,
      off: [
        {
          label: "Lönsamhet nyckeltal",
          profitOre: kpi(a.model, "profit") ?? 0,
          marginBp: kpi(a.model, "margin"),
        },
        { label: "Värde kvar efter inköp", profitOre: value.kept, marginBp: value.keptMarginBp },
      ],
      on: [
        { label: "Lönsamhet nyckeltal", profitOre: kpi(b.model, "profit") ?? 0 },
        { label: "Värde vår del per butik", profitOre: value.ours },
      ],
      shares: [],
    });
  }

  return { periods, unpricedTitles };
}

/**
 * Butikens andel per butik för en hel månad, som Lönsamhet per butik visar den med
 * butikernas andel (till kontrollen Avräkningar).
 */
export async function monthStoreShares(
  viewer: Viewer,
  month: IsoMonth,
  now: Date,
): Promise<Map<string, number>> {
  const on = viewerPageLoaders(viewer, { now, storeShare: true });
  const { model } = await lonsamhet(on, { from: monthStart(month), to: monthEnd(month) });
  return new Map(model.views.store.map((r) => [r.key, r.compensationOre]));
}

/** Titlar som sålt utan inköpspris i perioden (när kontroll 1 inte kunde köras). */
export async function unpricedTitlesFor(
  viewer: Viewer,
  from: IsoDate,
  to: IsoDate,
  now: Date,
): Promise<UnpricedTitle[]> {
  const loaders = viewerPageLoaders(viewer, { now, storeShare: false });
  const input = await loaders.domainInput({ period: { start: from, end: to } });
  const names = new Map(input.titles.map((t) => [t.id, t.name]));
  return profitability(input.current, "title").unpriced.byTitle.map((t) => ({
    titleId: t.titleId,
    name: names.get(t.titleId) ?? "Okänd titel",
    orders: t.orders,
    revenueOre: t.revenueOre,
  }));
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
