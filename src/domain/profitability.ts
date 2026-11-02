/**
 * Lönsamhet för en period, grupperad per titel, automat, butik, dag, vecka eller månad.
 *
 * Huvudregel: en order utan inköpspris räknas INTE in i vinsten. I varje rad avser
 * intäkt, inköp, avgifter, butiksersättning, vinst och marginal bara prissatta order.
 * Order utan pris redovisas separat i `unpriced*`-fälten (deras intäkt, moms, avgifter,
 * provision och andel av hyran), så att allt går ihop:
 *
 *   betalt (grossOre) = vatOre + revenueOre + unpricedVatOre + unpricedRevenueOre
 *   vinst             = revenueOre − costOre − feesOre − compensationOre
 *   compensationOre   = commissionOre + rentOre
 *   all hyra i perioden = Σ rentOre + Σ unpricedRentOre      (ej fördelad hyra ingår i rentOre)
 *
 * Identitet: i varje vy är summan av raderna lika med `totals` i varje fält (exakt i öre),
 * och `totals` är desamma oavsett gruppering.
 *
 * Ej fördelad hyra (butik-månad med hyra men utan order) är en kostnad för perioden och
 * dras från vinsten. Den hamnar på raden med nyckeln 'unallocated' per titel, automat,
 * dag och vecka; per butik på butikens rad; per månad på månadens rad.
 */

import {
  assertPeriod,
  eachDay,
  eachMonth,
  maxDate,
  minDate,
  monthEnd,
  monthStart,
  weekOf,
} from "./dates";
import { buildLedger, type Ledger, type LedgerDiagnostics, type LedgerEntry } from "./ledger";
import { checkSafe, ratioBp } from "./money";
import type { StoreMonthRent } from "./rent";
import type { GroupBy, IsoDate, Period, ProfitabilityInput } from "./types";

/** Version av beräkningsreglerna. Sparas med rapporter (`reports.calc_version`). */
export const CALC_VERSION = "1.0.0";

/** Nyckel för ej fördelad hyra. */
export const UNALLOCATED_KEY = "unallocated";
/** Nyckel för order utan kopplad automat (vy per automat). */
export const NO_MACHINE_KEY = "no-machine";
/** Nyckel för order vars automat inte var placerad i någon butik (vy per butik). */
export const NO_STORE_KEY = "no-store";
/** Nyckel för totalraden. */
export const TOTAL_KEY = "total";

/** Vilken sorts rad det är. */
export type RowKind = "item" | "time" | "unallocated" | "no-machine" | "no-store" | "total";

/** En rad i lönsamhetstabellen. Belopp i öre. */
export interface ProfitabilityRow {
  /** titleId, machineId, storeId, 'ÅÅÅÅ-MM-DD', 'ÅÅÅÅ-Www', 'ÅÅÅÅ-MM' eller en särskild nyckel. */
  readonly key: string;
  readonly kind: RowKind;
  /** För tidsrader: den del av perioden raden täcker. Annars `null`. */
  readonly range: Period | null;
  /** Sant om tidsraden bara täcker en del av veckan/månaden (periodens kanter). */
  readonly partial: boolean;

  /** Alla order (prissatta + utan pris). */
  readonly orders: number;
  readonly pricedOrders: number;
  readonly unpricedOrders: number;

  /** Betalt inkl. moms, alla order. */
  readonly grossOre: number;
  /** Moms, prissatta order. */
  readonly vatOre: number;
  /** Nettointäkt (exkl. moms), prissatta order. */
  readonly revenueOre: number;
  /** Inköp, prissatta order. */
  readonly costOre: number;
  /** Avgifter (kortavgift), prissatta order. */
  readonly feesOre: number;
  /** Provision, prissatta order. */
  readonly commissionOre: number;
  /** Hyra: fördelad på prissatta order + ej fördelad hyra. */
  readonly rentOre: number;
  /** Butiksersättning = provision + hyra. */
  readonly compensationOre: number;
  /** Vinst = intäkt − inköp − avgifter − butiksersättning. */
  readonly profitOre: number;
  /** Marginal i bp = round(vinst × 10 000 / intäkt). `null` när intäkten är 0. */
  readonly marginBp: number | null;
  /** Den del av `rentOre` som inte kunde fördelas på någon order. */
  readonly unallocatedRentOre: number;

  /** Order utan inköpspris: redovisas separat och ingår inte i vinsten. */
  readonly unpricedRevenueOre: number;
  readonly unpricedVatOre: number;
  readonly unpricedFeesOre: number;
  readonly unpricedCommissionOre: number;
  readonly unpricedRentOre: number;
  /** Provision + hyra som hör till order utan pris. */
  readonly unpricedCompensationOre: number;
}

/** Order utan inköpspris för en titel. */
export interface UnpricedTitle {
  readonly titleId: string;
  readonly orders: number;
  readonly revenueOre: number;
  /** Första och sista affärsdag med order utan pris (för "lägg in pris giltigt från …"). */
  readonly firstDate: IsoDate;
  readonly lastDate: IsoDate;
}

/** Sammanfattning av order utan inköpspris. */
export interface UnpricedSummary {
  readonly orders: number;
  /** Nettointäkt för order utan pris. */
  readonly revenueOre: number;
  /** Andel av periodens nettointäkt (alla order) i bp. 0 om intäkten är 0. */
  readonly shareBp: number;
  /** Titlar med minst en order utan pris, sorterade. */
  readonly titleIds: string[];
  /** Per titel, störst intäkt först. */
  readonly byTitle: UnpricedTitle[];
}

export type WaterfallKey = "revenue" | "cost" | "fees" | "compensation" | "profit";

/** Ett steg i vattenfallet. Avdrag har negativt värde; summan av stegen före vinsten = vinsten. */
export interface WaterfallStep {
  readonly key: WaterfallKey;
  readonly label: string;
  readonly valueOre: number;
  /** Sant för slutsumman (vinst), som ritas från noll. */
  readonly total: boolean;
}

/** Vattenfall Intäkt → Inköp → Avgifter → Butiksersättning → Vinst för prissatta order. */
export interface ProfitabilityWaterfall {
  readonly steps: readonly WaterfallStep[];
  /** Butiksersättningen uppdelad. */
  readonly compensation: { readonly commissionOre: number; readonly rentOre: number };
  /** Det som inte ingår (order utan inköpspris). */
  readonly excluded: {
    readonly label: string;
    readonly orders: number;
    readonly revenueOre: number;
    readonly shareBp: number;
  };
}

/** Resultatet av `profitability`. */
export interface ProfitabilityResult {
  readonly calcVersion: string;
  readonly period: Period;
  readonly groupBy: GroupBy;
  readonly rows: ProfitabilityRow[];
  readonly totals: ProfitabilityRow;
  readonly unpriced: UnpricedSummary;
  readonly waterfall: ProfitabilityWaterfall;
  /** Hyra per butik och månad, för spårbarhet. */
  readonly storeMonthRent: readonly StoreMonthRent[];
  readonly diagnostics: LedgerDiagnostics;
}

/** Inställningar för grupperingen. */
export interface ProfitabilityOptions {
  /** Tidsvyer: ta med tomma dagar/veckor/månader så att axeln blir hel. Standard: sant. */
  readonly fillTimeGaps?: boolean;
}

class RowAccumulator {
  orders = 0;
  pricedOrders = 0;
  unpricedOrders = 0;
  grossOre = 0;
  vatOre = 0;
  revenueOre = 0;
  costOre = 0;
  feesOre = 0;
  commissionOre = 0;
  rentOre = 0;
  unallocatedRentOre = 0;
  unpricedRevenueOre = 0;
  unpricedVatOre = 0;
  unpricedFeesOre = 0;
  unpricedCommissionOre = 0;
  unpricedRentOre = 0;

  constructor(
    readonly key: string,
    readonly kind: RowKind,
    readonly range: Period | null,
    readonly partial: boolean,
  ) {}

  addEntry(e: LedgerEntry): void {
    this.orders++;
    this.grossOre += e.grossOre;
    if (e.priced) {
      this.pricedOrders++;
      this.vatOre += e.vatOre;
      this.revenueOre += e.netRevenueOre;
      this.costOre += e.costOre;
      this.feesOre += e.cardFeeOre;
      this.commissionOre += e.commissionOre;
      this.rentOre += e.rentOre;
    } else {
      this.unpricedOrders++;
      this.unpricedVatOre += e.vatOre;
      this.unpricedRevenueOre += e.netRevenueOre;
      this.unpricedFeesOre += e.cardFeeOre;
      this.unpricedCommissionOre += e.commissionOre;
      this.unpricedRentOre += e.rentOre;
    }
  }

  addUnallocatedRent(rentOre: number): void {
    this.rentOre += rentOre;
    this.unallocatedRentOre += rentOre;
  }

  finish(): ProfitabilityRow {
    const what = `Raden ${this.key}`;
    const compensation = checkSafe(this.commissionOre + this.rentOre, what);
    const profit = checkSafe(this.revenueOre - this.costOre - this.feesOre - compensation, what);
    const row: ProfitabilityRow = {
      key: this.key,
      kind: this.kind,
      range: this.range,
      partial: this.partial,
      orders: this.orders,
      pricedOrders: this.pricedOrders,
      unpricedOrders: this.unpricedOrders,
      grossOre: checkSafe(this.grossOre, what),
      vatOre: checkSafe(this.vatOre, what),
      revenueOre: checkSafe(this.revenueOre, what),
      costOre: checkSafe(this.costOre, what),
      feesOre: checkSafe(this.feesOre, what),
      commissionOre: checkSafe(this.commissionOre, what),
      rentOre: checkSafe(this.rentOre, what),
      compensationOre: compensation,
      profitOre: profit,
      marginBp: ratioBp(profit, this.revenueOre),
      unallocatedRentOre: checkSafe(this.unallocatedRentOre, what),
      unpricedRevenueOre: checkSafe(this.unpricedRevenueOre, what),
      unpricedVatOre: checkSafe(this.unpricedVatOre, what),
      unpricedFeesOre: checkSafe(this.unpricedFeesOre, what),
      unpricedCommissionOre: checkSafe(this.unpricedCommissionOre, what),
      unpricedRentOre: checkSafe(this.unpricedRentOre, what),
      unpricedCompensationOre: checkSafe(this.unpricedCommissionOre + this.unpricedRentOre, what),
    };
    return row;
  }
}

const TIME_GROUPS: ReadonlySet<GroupBy> = new Set(["day", "week", "month"]);

/** Tidsnyckel och den del av perioden som nyckeln täcker. */
function timeBucket(
  date: IsoDate,
  groupBy: "day" | "week" | "month",
  period: Period,
): { key: string; range: Period; partial: boolean } {
  if (groupBy === "day") return { key: date, range: { start: date, end: date }, partial: false };
  if (groupBy === "week") {
    const w = weekOf(date);
    const range = { start: maxDate(w.start, period.start), end: minDate(w.end, period.end) };
    return { key: w.key, range, partial: range.start !== w.start || range.end !== w.end };
  }
  const month = date.slice(0, 7);
  const ms = monthStart(month);
  const me = monthEnd(month);
  const range = { start: maxDate(ms, period.start), end: minDate(me, period.end) };
  return { key: month, range, partial: range.start !== ms || range.end !== me };
}

function sortRows(rows: ProfitabilityRow[], groupBy: GroupBy): void {
  const specialRank = (k: RowKind): number =>
    k === "no-machine" || k === "no-store" ? 1 : k === "unallocated" ? 2 : 0;
  rows.sort((a, b) => {
    const ra = specialRank(a.kind);
    const rb = specialRank(b.kind);
    if (ra !== rb) return ra - rb;
    if (!TIME_GROUPS.has(groupBy)) {
      const va = a.revenueOre + a.unpricedRevenueOre;
      const vb = b.revenueOre + b.unpricedRevenueOre;
      if (va !== vb) return vb - va;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}

function summarizeUnpriced(ledger: Ledger, totalNetOre: number): UnpricedSummary {
  const byTitle = new Map<
    string,
    { orders: number; revenueOre: number; first: IsoDate; last: IsoDate }
  >();
  let orders = 0;
  let revenue = 0;
  for (const e of ledger.entries) {
    if (e.priced) continue;
    orders++;
    revenue += e.netRevenueOre;
    const d = e.order.businessDate;
    const t = byTitle.get(e.order.titleId);
    if (t) {
      t.orders++;
      t.revenueOre += e.netRevenueOre;
      if (d < t.first) t.first = d;
      if (d > t.last) t.last = d;
    } else {
      byTitle.set(e.order.titleId, { orders: 1, revenueOre: e.netRevenueOre, first: d, last: d });
    }
  }
  const list: UnpricedTitle[] = [...byTitle.entries()].map(([titleId, t]) => ({
    titleId,
    orders: t.orders,
    revenueOre: t.revenueOre,
    firstDate: t.first,
    lastDate: t.last,
  }));
  list.sort((a, b) =>
    a.revenueOre !== b.revenueOre ? b.revenueOre - a.revenueOre : a.titleId < b.titleId ? -1 : 1,
  );
  return {
    orders,
    revenueOre: checkSafe(revenue, "Intäkt utan pris"),
    shareBp: ratioBp(revenue, totalNetOre) ?? 0,
    titleIds: [...byTitle.keys()].sort(),
    byTitle: list,
  };
}

/** Avdrag som negativt tal, utan −0. */
function deduction(valueOre: number): number {
  return valueOre === 0 ? 0 : -valueOre;
}

function buildWaterfall(
  totals: ProfitabilityRow,
  unpriced: UnpricedSummary,
): ProfitabilityWaterfall {
  return {
    steps: [
      { key: "revenue", label: "Intäkt", valueOre: totals.revenueOre, total: false },
      { key: "cost", label: "Inköp", valueOre: deduction(totals.costOre), total: false },
      { key: "fees", label: "Avgifter", valueOre: deduction(totals.feesOre), total: false },
      {
        key: "compensation",
        label: "Butiksersättning",
        valueOre: deduction(totals.compensationOre),
        total: false,
      },
      { key: "profit", label: "Vinst", valueOre: totals.profitOre, total: true },
    ],
    compensation: { commissionOre: totals.commissionOre, rentOre: totals.rentOre },
    excluded: {
      label: "Intäkt utan inköpspris (ingår inte)",
      orders: unpriced.orders,
      revenueOre: unpriced.revenueOre,
      shareBp: unpriced.shareBp,
    },
  };
}

/**
 * Grupperar en färdig liggare. Använd när samma period ska visas i flera vyer
 * (liggaren byggs då bara en gång).
 */
export function summarizeLedger(
  ledger: Ledger,
  groupBy: GroupBy,
  options: ProfitabilityOptions = {},
): ProfitabilityResult {
  const { period } = ledger;
  const rows = new Map<string, RowAccumulator>();
  const totals = new RowAccumulator(TOTAL_KEY, "total", null, false);
  const isTime = TIME_GROUPS.has(groupBy);

  const getRow = (key: string, kind: RowKind, range: Period | null = null, partial = false) => {
    let acc = rows.get(key);
    if (!acc) {
      acc = new RowAccumulator(key, kind, range, partial);
      rows.set(key, acc);
    }
    return acc;
  };

  const rowForEntry = (e: LedgerEntry): RowAccumulator => {
    switch (groupBy) {
      case "title":
        return getRow(e.order.titleId, "item");
      case "machine":
        return e.order.machineId === null
          ? getRow(NO_MACHINE_KEY, "no-machine")
          : getRow(e.order.machineId, "item");
      case "store":
        return e.storeId === null ? getRow(NO_STORE_KEY, "no-store") : getRow(e.storeId, "item");
      case "day":
      case "week":
      case "month": {
        const b = timeBucket(e.order.businessDate, groupBy, period);
        return getRow(b.key, "time", b.range, b.partial);
      }
    }
  };

  for (const e of ledger.entries) {
    rowForEntry(e).addEntry(e);
    totals.addEntry(e);
  }

  for (const u of ledger.unallocatedRent) {
    let acc: RowAccumulator;
    if (groupBy === "store") acc = getRow(u.storeId, "item");
    else if (groupBy === "month") {
      const b = timeBucket(maxDate(monthStart(u.month), period.start), "month", period);
      acc = getRow(b.key, "time", b.range, b.partial);
    } else acc = getRow(UNALLOCATED_KEY, "unallocated");
    acc.addUnallocatedRent(u.rentOre);
    totals.addUnallocatedRent(u.rentOre);
  }

  if (isTime && options.fillTimeGaps !== false) {
    const g = groupBy as "day" | "week" | "month";
    if (g === "month") {
      for (const m of eachMonth(period.start, period.end)) {
        const b = timeBucket(maxDate(monthStart(m), period.start), "month", period);
        getRow(b.key, "time", b.range, b.partial);
      }
    } else {
      for (const d of eachDay(period.start, period.end)) {
        const b = timeBucket(d, g, period);
        getRow(b.key, "time", b.range, b.partial);
      }
    }
  }

  const finished = [...rows.values()].map((r) => r.finish());
  sortRows(finished, groupBy);
  const totalRow = totals.finish();
  const unpriced = summarizeUnpriced(ledger, totalRow.revenueOre + totalRow.unpricedRevenueOre);

  return {
    calcVersion: CALC_VERSION,
    period,
    groupBy,
    rows: finished,
    totals: totalRow,
    unpriced,
    waterfall: buildWaterfall(totalRow, unpriced),
    storeMonthRent: ledger.storeMonthRent,
    diagnostics: ledger.diagnostics,
  };
}

/**
 * Lönsamhet för perioden, grupperad enligt `groupBy`.
 *
 * Exempel: profitability({ orders, prices, agreements, placements, settings, period }, 'machine')
 * → { rows: [{ key: 'automat-1', revenueOre, costOre, feesOre, compensationOre, profitOre, marginBp, … }],
 *     totals, unpriced: { orders, revenueOre, shareBp, titleIds }, waterfall }
 */
export function profitability(
  input: ProfitabilityInput,
  groupBy: GroupBy,
  options: ProfitabilityOptions = {},
): ProfitabilityResult {
  assertPeriod(input.period);
  return summarizeLedger(buildLedger(input), groupBy, options);
}

/**
 * Flera vyer av samma period på en gång (liggaren byggs en gång).
 * profitabilityViews(input, ['title', 'machine', 'store']).machine.rows …
 */
export function profitabilityViews<G extends GroupBy>(
  input: ProfitabilityInput,
  groupBys: readonly G[],
  options: ProfitabilityOptions = {},
): Record<G, ProfitabilityResult> {
  const ledger = buildLedger(input);
  const out = {} as Record<G, ProfitabilityResult>;
  for (const g of groupBys) out[g] = summarizeLedger(ledger, g, options);
  return out;
}
