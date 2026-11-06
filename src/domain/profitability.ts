/**
 * Lönsamhet för en period, grupperad per titel, automat, butik, dag, vecka eller månad.
 *
 * Huvudregel: en order utan inköpspris räknas INTE in i vinsten. Dess intäkt, moms,
 * kortavgift och provision redovisas separat i `unpriced*`-fälten. Hyran är däremot en
 * fast kostnad som butiken ska ha oavsett vad som såldes, och den dras ALLTID i sin
 * helhet från vinsten. Annars skulle en saknad inköpspris kunna göra vinsten bättre
 * (en enda order utan pris tog tidigare med sig hela butikens månadshyra ur vinsten).
 *
 * Ej fördelad hyra = hyra som inte bärs av någon prissatt order:
 *   - butik-månader med hyra men utan order (på dagar med hyra), och
 *   - den andel av hyran som fördelats på order utan pris.
 * Den dras från vinsten och hamnar på raden med nyckeln 'unallocated' per titel, automat,
 * dag och vecka; per butik på butikens rad; per månad på månadens rad.
 *
 *   betalt (grossOre)   = vatOre + revenueOre + unpricedVatOre + unpricedRevenueOre
 *   vinst före andel    = revenueOre − costOre − feesOre − vmbVatOre
 *   vinst efter andel   = vinst före andel − compensationOre (butikernas andel)
 *   vinst (profitOre)   = före andel som standard i våra vyer; efter andel när
 *                         `Settings.deductStoreShare` inte är false (knappen "Visa butikernas
 *                         andel", vald butik, och alltid i avräkningar och rapporter)
 *   vmbVatOre           = radens del av VMB-momsen (ledger.ts; 0 utan VMB)
 *   compensationOre     = commissionOre + rentOre
 *   all hyra i perioden = Σ rentOre      (ej fördelad hyra, även den på order utan pris, ingår)
 *   unpricedRentOre     = informativt: hyra på radens order utan pris, som redan ingår i
 *                         rentOre via ej fördelad hyra (på samma rad eller på 'unallocated')
 *
 * Identitet: i varje vy är summan av raderna lika med `totals` i varje fält (exakt i öre),
 * och `totals` är desamma oavsett gruppering.
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
import {
  buildLedger,
  type Ledger,
  type LedgerDiagnostics,
  type LedgerEntry,
  type VmbMonth,
} from "./ledger";
import { allocateLargestRemainder, checkSafe, ratioBp } from "./money";
import type { RentSegment, StoreMonthRent } from "./rent";
import { storeShareDeducted } from "./store-share";
import type { GroupBy, IsoDate, Period, ProfitabilityInput } from "./types";
import { vmbApplies } from "./vmb";

/** Version av beräkningsreglerna. Sparas med rapporter (`reports.calc_version`). */
export const CALC_VERSION = "1.3.0";

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
  /** VMB-moms (vinstmarginalbeskattning), prissatta order. 0 utan VMB (`vmbApplies`). */
  readonly vmbVatOre: number;
  /** Provision, prissatta order. */
  readonly commissionOre: number;
  /** Hyra som dras från vinsten: fördelad på prissatta order + ej fördelad hyra. */
  readonly rentOre: number;
  /** Butiksersättning = butikernas andel = provision + hyra. */
  readonly compensationOre: number;
  /**
   * Vår vinst i vyn: före butikernas andel (`profitBeforeShareOre`) eller efter den
   * (`profitAfterShareOre`) enligt `Settings.deductStoreShare` (se store-share.ts).
   */
  readonly profitOre: number;
  /** Marginal i bp = round(vinst × 10 000 / intäkt). `null` när intäkten är 0. */
  readonly marginBp: number | null;
  /** Vinst före butikernas andel = intäkt − inköp − avgifter − VMB-moms. */
  readonly profitBeforeShareOre: number;
  readonly marginBeforeShareBp: number | null;
  /** Vår del = vinst före andel − butikernas andel (`compensationOre`). */
  readonly profitAfterShareOre: number;
  readonly marginAfterShareBp: number | null;
  /**
   * Den del av `rentOre` som inte bärs av någon prissatt order: butik-månader utan order
   * och hyra på order utan pris.
   */
  readonly unallocatedRentOre: number;

  /**
   * Order utan inköpspris: intäkt, moms, avgifter och provision redovisas separat och
   * ingår inte i vinsten.
   */
  readonly unpricedRevenueOre: number;
  readonly unpricedVatOre: number;
  readonly unpricedFeesOre: number;
  readonly unpricedCommissionOre: number;
  /**
   * Hyra som fördelats på radens order utan pris. Informativt: beloppet ingår redan i
   * vinsten som ej fördelad hyra (`unallocatedRentOre`, på denna rad eller på 'unallocated').
   */
  readonly unpricedRentOre: number;
  /** Provision + hyra som hör till order utan pris (provisionen ingår inte i vinsten, hyran gör det). */
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

export type WaterfallKey = "revenue" | "vmb" | "cost" | "fees" | "compensation" | "profit";

/** Ett steg i vattenfallet. Avdrag har negativt värde; summan av stegen före vinsten = vinsten. */
export interface WaterfallStep {
  readonly key: WaterfallKey;
  readonly label: string;
  readonly valueOre: number;
  /** Sant för slutsumman (vinst), som ritas från noll. */
  readonly total: boolean;
}

/**
 * Vattenfall Intäkt → VMB-moms → Inköp → Avgifter → Butiksersättning → Vinst för prissatta
 * order. Steget VMB-moms finns bara med VMB (`vmbApplies`), steget Butiksersättning bara när
 * butikernas andel dras (`storeShareDeducted`). Butiksersättningen innehåller all hyra i
 * perioden (även ej fördelad).
 */
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
  /** Sant när vinsten (`profitOre`) är efter butikernas andel (store-share.ts). */
  readonly storeShareDeducted: boolean;
  readonly rows: ProfitabilityRow[];
  readonly totals: ProfitabilityRow;
  readonly unpriced: UnpricedSummary;
  readonly waterfall: ProfitabilityWaterfall;
  /** VMB-momsen för perioden (samma som `totals.vmbVatOre`), per månad. */
  readonly vmb: VmbSummary;
  /** Hyra per butik och månad, för spårbarhet. */
  readonly storeMonthRent: readonly StoreMonthRent[];
  readonly diagnostics: LedgerDiagnostics;
}

/** VMB-momsen i perioden. */
export interface VmbSummary {
  /** Sant med VMB (`vmbApplies`). */
  readonly applies: boolean;
  readonly vatOre: number;
  /**
   * Sant när perioden bara täcker en del av en månad: momsen är räknad på periodens dagar och
   * är preliminär. Se även `vmbPreliminary` (en månad som inte är slut är också preliminär).
   */
  readonly partial: boolean;
  readonly months: readonly VmbMonth[];
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
  vmbVatOre = 0;
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
      this.vmbVatOre += e.vmbVatOre;
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

  finish(deductStoreShare: boolean): ProfitabilityRow {
    const what = `Raden ${this.key}`;
    const compensation = checkSafe(this.commissionOre + this.rentOre, what);
    const before = checkSafe(this.revenueOre - this.costOre - this.feesOre - this.vmbVatOre, what);
    const after = checkSafe(before - compensation, what);
    const profit = deductStoreShare ? after : before;
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
      vmbVatOre: checkSafe(this.vmbVatOre, what),
      commissionOre: checkSafe(this.commissionOre, what),
      rentOre: checkSafe(this.rentOre, what),
      compensationOre: compensation,
      profitOre: profit,
      marginBp: ratioBp(profit, this.revenueOre),
      profitBeforeShareOre: before,
      marginBeforeShareBp: ratioBp(before, this.revenueOre),
      profitAfterShareOre: after,
      marginAfterShareBp: ratioBp(after, this.revenueOre),
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
  vmbApplies: boolean,
  deductStoreShare: boolean,
): ProfitabilityWaterfall {
  return {
    steps: [
      { key: "revenue", label: "Intäkt", valueOre: totals.revenueOre, total: false },
      ...(vmbApplies
        ? [
            {
              key: "vmb" as const,
              label: "VMB-moms",
              valueOre: deduction(totals.vmbVatOre),
              total: false,
            },
          ]
        : []),
      { key: "cost", label: "Inköp", valueOre: deduction(totals.costOre), total: false },
      { key: "fees", label: "Avgifter", valueOre: deduction(totals.feesOre), total: false },
      ...(deductStoreShare
        ? [
            {
              key: "compensation" as const,
              label: "Butiksersättning",
              valueOre: deduction(totals.compensationOre),
              total: false,
            },
          ]
        : []),
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

  // Ej fördelad hyra: per butik på butikens rad, per månad på månadens rad, per dag och vecka
  // på de dagar den gäller (så att staplarna summerar till totalen), annars 'unallocated'.
  const addRentTo = (acc: RowAccumulator, rentOre: number): void => {
    acc.addUnallocatedRent(rentOre);
  };
  const addUnallocated = (
    storeId: string,
    month: string,
    rentOre: number,
    days: { readonly date: IsoDate } | { readonly segments: readonly RentSegment[] },
  ): void => {
    totals.addUnallocatedRent(rentOre);
    if (groupBy === "store") return addRentTo(getRow(storeId, "item"), rentOre);
    if (groupBy === "month") {
      const b = timeBucket(maxDate(monthStart(month), period.start), "month", period);
      return addRentTo(getRow(b.key, "time", b.range, b.partial), rentOre);
    }
    if (groupBy === "day" || groupBy === "week") {
      const toDay = (date: IsoDate, ore: number) => {
        if (ore === 0) return;
        const b = timeBucket(date, groupBy, period);
        addRentTo(getRow(b.key, "time", b.range, b.partial), ore);
      };
      if ("date" in days) return toDay(days.date, rentOre);
      // Hyran per dag efter avtalets månadshyra den dagen; summan är exakt butik-månadens hyra.
      const dates: IsoDate[] = [];
      const weights: number[] = [];
      for (const seg of days.segments) {
        for (const d of eachDay(seg.start, seg.end)) {
          dates.push(d);
          weights.push(seg.monthlyRentOre);
        }
      }
      if (dates.length > 0 && weights.some((w) => w > 0)) {
        const shares = allocateLargestRemainder(rentOre, weights);
        dates.forEach((d, i) => toDay(d, shares[i]!));
        return;
      }
    }
    addRentTo(getRow(UNALLOCATED_KEY, "unallocated"), rentOre);
  };

  for (const e of ledger.entries) {
    rowForEntry(e).addEntry(e);
    totals.addEntry(e);
    // Hyran på en order utan pris är ändå en kostnad: den dras från vinsten som ej fördelad.
    if (!e.priced && e.rentOre !== 0 && e.storeId !== null) {
      addUnallocated(e.storeId, e.month, e.rentOre, { date: e.order.businessDate });
    }
  }

  for (const u of ledger.unallocatedRent) {
    addUnallocated(u.storeId, u.month, u.rentOre, { segments: u.segments });
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

  const deduct = storeShareDeducted(ledger.settings);
  const finished = [...rows.values()].map((r) => r.finish(deduct));
  sortRows(finished, groupBy);
  const totalRow = totals.finish(deduct);
  const unpriced = summarizeUnpriced(ledger, totalRow.revenueOre + totalRow.unpricedRevenueOre);

  return {
    calcVersion: CALC_VERSION,
    period,
    groupBy,
    storeShareDeducted: deduct,
    rows: finished,
    totals: totalRow,
    unpriced,
    waterfall: buildWaterfall(totalRow, unpriced, vmbApplies(ledger.settings), deduct),
    vmb: {
      applies: vmbApplies(ledger.settings),
      vatOre: totalRow.vmbVatOre,
      partial: ledger.vmb.some((m) => m.partialMonth),
      months: ledger.vmb,
    },
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

/**
 * Sant när periodens VMB-moms är preliminär: perioden täcker bara en del av en månad, eller
 * en månad i perioden är inte slut (`today` = dagens affärsdatum). Momsen för en avslutad
 * hel månad är den som redovisas (Ekonomi → Bokföring, med underskott från tidigare månader).
 */
export function vmbPreliminary(vmb: VmbSummary, today: IsoDate): boolean {
  if (!vmb.applies) return false;
  return vmb.partial || vmb.months.some((m) => monthEnd(m.month) >= today);
}
