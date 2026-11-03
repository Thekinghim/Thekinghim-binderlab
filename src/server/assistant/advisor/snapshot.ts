/**
 * Underlaget till rådgivaren: ett kompakt sammandrag av organisationens senaste 30 och 7
 * dagar, mot perioderna före. Allt räknas här med @/domain och @/analytics, och talen
 * skrivs färdigformaterade ("12 480 kr", "23,7 %", "+12 %"), så att modellen bara
 * behöver citera dem. Förslagens tal kontrolleras sedan mot just det här objektet
 * (grounding.ts).
 *
 * Ren modul: ingen databas, inga miljövariabler (testas i snapshot.test.ts).
 */

import { computeInsights } from "@/analytics/insights";
import type { AnalyticsOrder } from "@/analytics/todos/types";
import {
  addDays,
  changeBp,
  daysOfStockLeft,
  keyMetrics,
  profitabilityViews,
  salesVelocity,
  type EconomicsSources,
  type IsoDate,
  type KeyMetrics,
  type Period,
  type ProfitabilityRow,
  type PurchasePrice,
} from "@/domain";
import { formatDecimal, formatDelta, formatPercent, formatSek } from "@/lib/format";

export interface SnapshotTitle {
  readonly id: string;
  readonly name: string;
  readonly archived?: boolean;
}
export interface SnapshotMachine {
  readonly id: string;
  readonly name: string;
  readonly code: string;
  readonly storeId: string | null;
  readonly activeFrom: IsoDate | null;
  readonly activeTo: IsoDate | null;
  readonly archived?: boolean;
}
export interface SnapshotStore {
  readonly id: string;
  readonly name: string;
}

export interface SnapshotInput {
  readonly organizationName: string;
  /** Dagens affärsdatum. Underlaget slutar i går (senaste hela dagen). */
  readonly today: IsoDate;
  readonly timeZone: string;
  readonly now: Date;
  /** Priser, avtal, placeringar och inställningar (som loadDomainInputFor ger). */
  readonly sources: EconomicsSources;
  /** Order de senaste 60 hela dagarna (minst), med betaltid för timmar. */
  readonly orders: readonly AnalyticsOrder[];
  readonly titles: readonly SnapshotTitle[];
  readonly machines: readonly SnapshotMachine[];
  readonly stores: readonly SnapshotStore[];
  /** Lagersaldo per automat och titel just nu. */
  readonly machineStock: readonly { machineId: string; titleId: string; onHand: number }[];
}

export type Snapshot = ReturnType<typeof buildSnapshot>;

const WEEKDAYS = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];
const MAX_TITLES = 12;
const MAX_STOCK_ROWS = 15;
/** Lagerrader som räcker kortare än så här tas med som risk. */
const STOCK_RISK_DAYS = 7;
const VELOCITY_DAYS = 14;

const kr = (ore: number) => formatSek(ore / 100);
const pct = (bp: number | null) => (bp === null ? "–" : formatPercent(bp / 10_000));
const delta = (bp: number | null) =>
  bp === null ? "–" : formatDelta(bp / 10_000, Math.abs(bp) < 1000 ? 1 : 0);

function rowRevenue(r: ProfitabilityRow): number {
  return r.revenueOre + r.unpricedRevenueOre;
}

function weekdayIndex(date: IsoDate): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

function hourIn(iso: string | undefined, timeZone: string): number | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const h = new Intl.DateTimeFormat("sv-SE", { timeZone, hour: "2-digit", hourCycle: "h23" })
    .format(date)
    .replace(/\D/g, "");
  const n = Number(h);
  return Number.isInteger(n) && n >= 0 && n < 24 ? n : null;
}

function inPeriod(o: { businessDate: IsoDate }, p: Period): boolean {
  return o.businessDate >= p.start && o.businessDate <= p.end;
}

function metrics(m: KeyMetrics) {
  return {
    intakt: kr(m.revenueOre),
    vinst: kr(m.profitOre),
    marginal: pct(m.marginBp),
    order: m.orderCount,
    snittorder: m.averageOrderValueOre === null ? "–" : kr(m.averageOrderValueOre),
  };
}

function change(cur: KeyMetrics, prev: KeyMetrics) {
  return {
    intakt: delta(changeBp(cur.revenueOre, prev.revenueOre)),
    vinst: delta(changeBp(cur.profitOre, prev.profitOre)),
    order: delta(changeBp(cur.orderCount, prev.orderCount)),
  };
}

/** Vanligaste priset (inkl. moms) per titel bland orderna; lika vanliga: det högsta. */
function modePrice(orders: readonly AnalyticsOrder[]): Map<string, { ore: number; n: number }> {
  const counts = new Map<string, Map<number, number>>();
  for (const o of orders) {
    const m = counts.get(o.titleId) ?? new Map<number, number>();
    m.set(o.amountOre, (m.get(o.amountOre) ?? 0) + 1);
    counts.set(o.titleId, m);
  }
  const out = new Map<string, { ore: number; n: number }>();
  for (const [titleId, m] of counts) {
    let best: { ore: number; n: number } | null = null;
    for (const [ore, n] of m) {
      if (!best || n > best.n || (n === best.n && ore > best.ore)) best = { ore, n };
    }
    if (best) out.set(titleId, best);
  }
  return out;
}

function unitCostOn(
  prices: readonly PurchasePrice[],
  titleId: string,
  date: IsoDate,
): number | null {
  let best: PurchasePrice | null = null;
  for (const p of prices) {
    if (p.titleId !== titleId || p.validFrom > date) continue;
    if (!best || p.validFrom > best.validFrom) best = p;
  }
  return best ? best.unitCostOre : null;
}

/** Bygger underlaget. Deterministiskt för samma indata. */
export function buildSnapshot(input: SnapshotInput) {
  const asOf = addDays(input.today, -1);
  const p30: Period = { start: addDays(asOf, -29), end: asOf };
  const prev30: Period = { start: addDays(asOf, -59), end: addDays(asOf, -30) };
  const p7: Period = { start: addDays(asOf, -6), end: asOf };
  const prev7: Period = { start: addDays(asOf, -13), end: addDays(asOf, -7) };

  const titleName = new Map(input.titles.map((t) => [t.id, t.name]));
  const machineById = new Map(input.machines.map((m) => [m.id, m]));
  const storeName = new Map(input.stores.map((s) => [s.id, s.name]));
  const machineLabel = (id: string) => {
    const m = machineById.get(id);
    return m ? `${m.name} (${m.code})` : "Okopplad automat";
  };

  const ordersIn = (p: Period) => input.orders.filter((o) => inPeriod(o, p));
  const o30 = ordersIn(p30);
  const oPrev30 = ordersIn(prev30);
  const o7 = ordersIn(p7);
  const oPrev7 = ordersIn(prev7);
  const pi = (orders: readonly AnalyticsOrder[], period: Period) => ({
    ...input.sources,
    orders,
    period,
  });

  const m30 = keyMetrics(pi(o30, p30));
  const mPrev30 = keyMetrics(pi(oPrev30, prev30));
  const m7 = keyMetrics(pi(o7, p7));
  const mPrev7 = keyMetrics(pi(oPrev7, prev7));

  const views30 = profitabilityViews(pi(o30, p30), ["title", "machine", "store"], {
    fillTimeGaps: false,
  });
  const viewsPrev30 = profitabilityViews(pi(oPrev30, prev30), ["title", "machine"], {
    fillTimeGaps: false,
  });
  const prevRevenue = (rows: readonly ProfitabilityRow[]) =>
    new Map(rows.filter((r) => r.kind === "item").map((r) => [r.key, rowRevenue(r)]));
  const prevTitle = prevRevenue(viewsPrev30.title.rows);
  const prevMachine = prevRevenue(viewsPrev30.machine.rows);
  const count7 = (key: (o: AnalyticsOrder) => string | null) => {
    const m = new Map<string, number>();
    for (const o of o7) {
      const k = key(o);
      if (k) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  };
  const title7 = count7((o) => o.titleId);
  const machine7 = count7((o) => o.machineId);

  const byProfit = (rows: readonly ProfitabilityRow[]) =>
    rows
      .filter((r) => r.kind === "item")
      .sort((a, b) => b.profitOre - a.profitOre || (a.key < b.key ? -1 : 1));

  const prices30 = modePrice(o30);
  const titles = byProfit(views30.title.rows)
    .slice(0, MAX_TITLES)
    .map((r) => {
      const cost = unitCostOn(input.sources.prices, r.key, asOf);
      const price = prices30.get(r.key);
      return {
        titel: titleName.get(r.key) ?? r.key,
        intakt30: kr(rowRevenue(r)),
        vinst30: kr(r.profitOre),
        marginal30: pct(r.marginBp),
        order30: r.orders,
        order7: title7.get(r.key) ?? 0,
        intaktMotForegaende30: delta(changeBp(rowRevenue(r), prevTitle.get(r.key) ?? 0)),
        pris: price ? kr(price.ore) : "–",
        inkopspris: cost === null ? "saknas" : kr(cost),
      };
    });

  const machines = byProfit(views30.machine.rows).map((r) => {
    const m = machineById.get(r.key);
    return {
      automat: machineLabel(r.key),
      butik: m?.storeId ? (storeName.get(m.storeId) ?? "–") : "ej placerad",
      intakt30: kr(rowRevenue(r)),
      vinst30: kr(r.profitOre),
      marginal30: pct(r.marginBp),
      order30: r.orders,
      order7: machine7.get(r.key) ?? 0,
      intaktMotForegaende30: delta(changeBp(rowRevenue(r), prevMachine.get(r.key) ?? 0)),
    };
  });

  const stores = byProfit(views30.store.rows).map((r) => ({
    butik: storeName.get(r.key) ?? r.key,
    intakt30: kr(rowRevenue(r)),
    butiksersattning30: kr(r.compensationOre),
    butiksandel: pct(
      rowRevenue(r) > 0 ? Math.round((r.compensationOre * 10_000) / rowRevenue(r)) : null,
    ),
    vinst30: kr(r.profitOre),
  }));

  // Veckodagar och timmar (30 dagar).
  const weekday = WEEKDAYS.map(() => ({ order: 0, ore: 0 }));
  const hours = Array.from({ length: 24 }, () => 0);
  for (const o of o30) {
    const w = weekday[weekdayIndex(o.businessDate)]!;
    w.order += 1;
    w.ore += o.amountOre;
    const h = hourIn(o.orderedAt, input.timeZone);
    if (h !== null) hours[h]! += 1;
  }
  const weekdays = weekday.map((w, i) => ({
    dag: WEEKDAYS[i]!,
    order: w.order,
    intakt: kr(w.ore),
  }));
  const hourRows = hours
    .map((n, h) => ({ timme: `kl ${String(h).padStart(2, "0")}`, order: n }))
    .filter((r) => r.order > 0);

  // Lager och risk för slutsålt (takt 14 dagar).
  const vStart = addDays(asOf, -(VELOCITY_DAYS - 1));
  const daily = new Map<string, Map<IsoDate, number>>();
  for (const o of input.orders) {
    if (!o.machineId || o.businessDate < vStart || o.businessDate > asOf) continue;
    const key = `${o.machineId}:${o.titleId}`;
    const m = daily.get(key) ?? new Map<IsoDate, number>();
    m.set(o.businessDate, (m.get(o.businessDate) ?? 0) + 1);
    daily.set(key, m);
  }
  const stockRows = input.machineStock
    .filter((s) => {
      const m = machineById.get(s.machineId);
      return m && !m.archived && (!m.activeTo || m.activeTo >= input.today);
    })
    .map((s) => {
      const m = machineById.get(s.machineId)!;
      const sales = [...(daily.get(`${s.machineId}:${s.titleId}`) ?? new Map()).entries()].map(
        ([date, units]) => ({ date, units }),
      );
      const v = salesVelocity(sales, {
        asOf,
        days: VELOCITY_DAYS,
        ...(m.activeFrom ? { activeFrom: m.activeFrom } : {}),
      });
      return {
        automat: machineLabel(s.machineId),
        titel: titleName.get(s.titleId) ?? s.titleId,
        iLager: s.onHand,
        saltPerDag: formatDecimal(v.perDay),
        dagarKvar: daysOfStockLeft(s.onHand, v),
      };
    });
  const atRisk = stockRows
    .filter((r) => r.dagarKvar !== null && r.dagarKvar < STOCK_RISK_DAYS)
    .sort((a, b) => a.dagarKvar! - b.dagarKvar! || a.automat.localeCompare(b.automat, "sv"));
  const deadStock = stockRows.filter((r) => r.dagarKvar === null && r.iLager > 0).length;

  // Prisändringar: försäljningspris (vanligaste, inkl. moms) mot de 30 dagarna före,
  // och inköpspriser som ändrats de senaste 60 dagarna.
  const pricesPrev = modePrice(oPrev30);
  const salesPriceChanges = [...prices30.entries()]
    .map(([titleId, now]) => ({ titleId, now, before: pricesPrev.get(titleId) }))
    .filter((x) => x.before && x.before.ore !== x.now.ore)
    .map((x) => ({
      titel: titleName.get(x.titleId) ?? x.titleId,
      prisFore: kr(x.before!.ore),
      prisNu: kr(x.now.ore),
      orderFore30: oPrev30.filter((o) => o.titleId === x.titleId).length,
      orderNu30: o30.filter((o) => o.titleId === x.titleId).length,
    }));
  const purchaseChanges = input.sources.prices
    .filter((p) => p.validFrom >= prev30.start && p.validFrom <= input.today)
    .map((p) => {
      const before = unitCostOn(input.sources.prices, p.titleId, addDays(p.validFrom, -1));
      return {
        titel: titleName.get(p.titleId) ?? p.titleId,
        fran: p.validFrom,
        inkopFore: before === null ? "–" : kr(before),
        inkopNu: kr(p.unitCostOre),
      };
    })
    .filter((p) => p.inkopFore !== p.inkopNu);

  // Avvikelser: regelbaserade iakttagelser och automater utan försäljning senaste 3 dagarna.
  const insights = computeInsights(
    {
      ...input.sources,
      orders: [...o30, ...oPrev30],
      titles: input.titles,
      machines: input.machines,
    },
    p30,
    prev30,
    { now: input.now, timeZone: input.timeZone },
  );
  const recent = new Set(
    input.orders.filter((o) => o.businessDate >= addDays(asOf, -2)).map((o) => o.machineId),
  );
  const silent = input.machines
    .filter((m) => !m.archived && (!m.activeTo || m.activeTo >= input.today))
    .filter((m) => !m.activeFrom || m.activeFrom <= addDays(asOf, -2))
    .filter((m) => !recent.has(m.id))
    .map((m) => machineLabel(m.id));

  return {
    organisation: input.organizationName,
    senasteHelaDag: asOf,
    perioder: {
      d30: p30,
      foregaende30: prev30,
      d7: p7,
      foregaende7: prev7,
    },
    nyckeltal: {
      d30: metrics(m30),
      foregaende30: metrics(mPrev30),
      forandring30: change(m30, mPrev30),
      d7: metrics(m7),
      foregaende7: metrics(mPrev7),
      forandring7: change(m7, mPrev7),
      andelUtanInkopspris30: pct(m30.unpricedShareBp),
    },
    titlar: titles,
    automater: machines,
    butiker: stores,
    veckodagar30: weekdays,
    timmar30: hourRows,
    lager: {
      takt: `sålda pack per dag, senaste ${VELOCITY_DAYS} dagarna`,
      riskUnderSjuDagar: atRisk.slice(0, MAX_STOCK_ROWS),
      antalRaderMedRisk: atRisk.length,
      raderUtanForsaljning: deadStock,
    },
    prisandringar: {
      forsaljningspris: salesPriceChanges,
      inkopspris: purchaseChanges,
    },
    avvikelser: {
      iakttagelser: insights.map((i) => `${i.text}. ${i.detail}`),
      automaterUtanForsaljningTreDagar: silent,
    },
  };
}

/** Underlaget som text till modellen (kompakt JSON, fast nyckelordning). */
export function snapshotText(snapshot: Snapshot): string {
  return JSON.stringify(snapshot);
}
