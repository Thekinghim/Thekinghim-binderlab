/**
 * Butiksrapporten: underlag till den månadsrapport som skickas till en butik.
 *
 * Innehåll: butikens intäkt och antal order, jämförelse mot förra månaden, försäljning
 * per vecka, mest sålda titlar, butikens automater, butikens ersättning uträknad steg
 * för steg enligt avtalet, och plats för en hälsning.
 *
 * Sekretess: rapporten får ALDRIG innehålla inköpskostnad, marginal, vinst eller någon
 * annan butiks siffror. Den byggs därför direkt från orderliggarens rader för butiken
 * (aldrig genom att kopiera lönsamhetsrader, som bär inköp och vinst), och
 * `assertStoreReportSafe` kontrollerar hela objektet innan det returneras. Undantag:
 * med ett avtal om vinstdelning ÄR butikens månadssummor för inköp, VMB-moms och vinst
 * underlaget för ersättningen och visas i `compensation.splits` (aldrig per titel).
 *
 * Vinstdelning räknas bara på kompletta underlag: saknar en order inköpspris kastas
 * `DomainError` ('missing_price'), utom med `pendingSplit` (portalen), där andelen då
 * visas som ej räknad.
 *
 * Vilka order hör till butiken? De order vars automat stod i butiken på orderns
 * affärsdag (placeringen avgör, se docs/berakningar.md avsnitt 2). Intäkt = belopp
 * exkl. moms; provision räknas per order på det beloppet; hyran per butik och månad,
 * per dag vid delmånad. Ersättningen blir därmed exakt densamma som i beräkningslagrets
 * `storeCompensation`.
 */

import {
  CALC_VERSION,
  DomainError,
  addDays,
  addMonths,
  applyBp,
  assertPeriod,
  buildLedger,
  eachDay,
  intersectPeriods,
  maxDate,
  minDate,
  monthOf,
  monthPeriod,
  periodDays,
  previousPeriod,
  ratioBp,
  roundHalfUp,
  changeBp,
  isProfitSplit,
  weekOf,
  type IsoDate,
  type IsoMonth,
  type LedgerEntry,
  type LossTreatment,
  type Period,
  type StoreAgreement,
  type StoreMonthRent,
  type StoreMonthSplit,
} from "@/domain";
import { Catalog, evidence, fig, monthScope, sumEntries } from "./shared";
import {
  dateText,
  isWholeMonth,
  krText,
  listText,
  monthNameText,
  monthText,
  ordersText,
  pctText,
  periodText,
  shortDateText,
  signedPctText,
  weekText,
} from "./text";
import type { Conclusion, Evidence, NamedEntity, ReportSources } from "./types";

/** Försäljningen i butiken under månaden. Belopp i öre. */
export interface StoreSales {
  /** Intäkt exkl. moms (det provisionen räknas på). */
  readonly revenueOre: number;
  /** Betalt inkl. moms. */
  readonly grossOre: number;
  readonly vatOre: number;
  readonly orders: number;
  /** Snittorder exkl. moms, `null` utan order. */
  readonly averageOrderOre: number | null;
  readonly evidence: Evidence;
}

/** Jämförelse mot förra månaden (eget datum: lika lång period dagarna före). */
export interface StoreComparison {
  readonly month: IsoMonth;
  /** Jämförelseperioden. Saknas i äldre ögonblicksbilder (= hela `month`). */
  readonly period?: Period;
  readonly revenueOre: number;
  readonly orders: number;
  /** Förändring i intäkt i bp, `null` när förra månaden saknade försäljning. */
  readonly revenueChangeBp: number | null;
  /** Skillnad i antal order (nu − då). */
  readonly ordersDiff: number;
  readonly text: string;
  readonly evidence: Evidence;
}

/** En ISO-vecka (eller den del av den som ligger i månaden). */
export interface StoreWeek {
  /** 'ÅÅÅÅ-Www' */
  readonly key: string;
  readonly week: number;
  /** "v. 45 (2–8 nov.)" */
  readonly label: string;
  readonly range: Period;
  /** Sant om veckan bara delvis ligger i månaden. */
  readonly partial: boolean;
  readonly orders: number;
  readonly revenueOre: number;
  readonly evidence: Evidence;
}

/** En av de mest sålda titlarna. */
export interface StoreTopTitle {
  readonly titleId: string;
  readonly name: string;
  readonly orders: number;
  readonly revenueOre: number;
  /** Andel av butikens intäkt i bp. */
  readonly shareBp: number;
  readonly evidence: Evidence;
}

/** En automat i butiken. */
export interface StoreMachine {
  readonly machineId: string;
  readonly name: string;
  /** Dagar i månaden som automaten stod i butiken. */
  readonly placedDays: number;
  readonly orders: number;
  readonly revenueOre: number;
  readonly evidence: Evidence;
}

/** Ersättningsmodell enligt avtalen som gällde under månaden. */
export type CompensationModel =
  "profit_split" | "profit_split_and_rent" | "commission" | "rent" | "commission_and_rent" | "none";

/** Ett steg i uträkningen av butikens ersättning. */
export interface CompensationStep {
  /**
   * `commission`: provision enligt ett avtal. `no_commission`: order när avtalet bara hade
   * hyra (0 kr). `no_agreement`: order på dagar utan avtal (0 kr). Stegens underlag summerar
   * därmed alltid till månadens intäkt exkl. moms.
   */
  readonly kind: "share" | "commission" | "no_commission" | "no_agreement" | "rent" | "total";
  /** Kort rubrik, t.ex. "Provision 10 % (1–30 nov.)". */
  readonly label: string;
  /** Uträkningen i klartext, t.ex. "10 % av 30 400 kr = 3 040 kr". */
  readonly calculation: string;
  readonly amountOre: number;
  readonly evidence: Evidence;
}

/** Ett hyresavsnitt: den del av månaden då en viss månadshyra gällde. */
export interface RentPart {
  readonly monthlyRentOre: number;
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly days: number;
}

/**
 * Vinstdelningen under ett avtal i månaden: summorna som andelen räknas på.
 * vinst = försäljning − VMB-moms − inköp − kortavgifter; andel = vinst × andel (0 vid förlust
 * med förlusthantering 'zero').
 */
export interface StoreProfitSplit {
  /** Avtalets startdag. */
  readonly validFrom: IsoDate;
  /** Dagarna i månaden då avtalet gällde. */
  readonly range: Period;
  readonly orders: number;
  readonly shareBp: number;
  readonly lossTreatment: LossTreatment;
  /** Avtalets val: VMB-moms dras före delningen (saknas i ögonblicksbilder före 1.3.0 = sant). */
  readonly vmbBeforeSplit?: boolean;
  /** Försäljning inkl. moms. */
  readonly salesInclVatOre: number;
  /** Återbetalningar till kunder (saknas i ögonblicksbilder före 1.2.0 = 0). */
  readonly refundsOre?: number;
  readonly vmbVatOre: number;
  readonly purchasesOre: number;
  readonly cardFeesOre: number;
  readonly profitOre: number;
  /** Butikens andel; 0 när `pending`. */
  readonly storeShareOre: number;
  /** Operatörens andel = vinst − butikens andel. */
  readonly operatorShareOre: number;
  /** Sant när underlaget saknar inköpspriser (bara portalen): andelen är inte räknad. */
  readonly pending: boolean;
  readonly evidence: Evidence;
}

/** Butikens ersättning, uträknad steg för steg. */
export interface StoreCompensationBreakdown {
  readonly model: CompensationModel;
  /** Avtalet i klartext, t.ex. "Provision 10 % på försäljningen exkl. moms och hyra 1 000 kr per månad". */
  readonly modelText: string;
  readonly steps: readonly CompensationStep[];
  readonly rentParts: readonly RentPart[];
  readonly daysInMonth: number;
  /** Vinstdelning per avtal (tom utan vinstdelning). */
  readonly splits: readonly StoreProfitSplit[];
  /** Butikens andel av vinsten (Σ splits). */
  readonly shareOre: number;
  readonly commissionOre: number;
  readonly rentOre: number;
  /** Andel + provision + hyra. */
  readonly totalOre: number;
  /** Sant när en vinstandel inte kunde räknas (saknade inköpspriser, bara portalen). */
  readonly pending: boolean;
  readonly evidence: Evidence;
}

/** Hela butiksrapporten. */
export interface StoreReport {
  readonly kind: "store";
  readonly calcVersion: string;
  readonly month: IsoMonth;
  readonly period: Period;
  readonly store: NamedEntity;
  readonly conclusion: Conclusion;
  /** Plats för en personlig hälsning; `null` = ingen. */
  readonly greeting: string | null;
  readonly sales: StoreSales;
  readonly comparison: StoreComparison;
  readonly weeks: readonly StoreWeek[];
  readonly topTitles: readonly StoreTopTitle[];
  readonly machines: readonly StoreMachine[];
  readonly compensation: StoreCompensationBreakdown;
  /**
   * "Visa detaljer i rapporten" (butikens val när rapporten räknades). Sant: rapporten
   * visar också titlarna och service. Falskt: bara uträkningen, och `topTitles` är tom.
   * Saknas i ögonblicksbilder från före valet fanns (se `storeDetailsOf`).
   */
  readonly details?: boolean;
}

/** Inställningar för butiksrapporten. */
export interface StoreReportOptions {
  /** Antal titlar i topplistan. Standard 5. */
  readonly topTitles?: number;
  /** Hälsning till butiken. */
  readonly greeting?: string | null;
  /**
   * Butikens val "Visa detaljer i rapporten". Standard falskt: inga titlar i rapporten
   * (varken i `topTitles` eller i slutsatsen).
   */
  readonly details?: boolean;
  /**
   * Saknade inköpspriser under vinstdelning: `false` (standard) stoppar rapporten med
   * `DomainError('missing_price')`; `true` visar andelen som ej räknad (portalen, som inte
   * ser inköpspriser).
   */
  readonly pendingSplit?: boolean;
}

/**
 * Vinstdelningarna i en ersättning. Sparade ögonblicksbilder från före vinstdelningen
 * (beräkningsversion 1.1.0) saknar fältet; då är listan tom.
 */
export function splitsOf(c: StoreCompensationBreakdown): readonly StoreProfitSplit[] {
  return (c as Partial<StoreCompensationBreakdown>).splits ?? [];
}

/** Början på felmeddelandet när vinstdelningen saknar inköpspriser. */
export const MISSING_PRICES_MESSAGE = "Butiksrapporten kan inte räknas:";

/** Förändring under 2 % (200 bp) räknas som "i nivå med". */
export const FLAT_CHANGE_BP = 200;

/**
 * Bygger butiksrapporten för en kalendermånad.
 *
 * Regler:
 * - Butikens order = order vars automat stod i butiken orderns dag.
 * - Intäkt = Σ belopp exkl. moms; snittorder = round(intäkt / antal order).
 * - Förändring mot förra månaden = round((nu − då) × 10 000 / då) bp; saknas när då = 0.
 * - Veckor följer ISO 8601; veckor som bara delvis ligger i månaden markeras.
 * - Topptitlar sorteras på intäkt, sedan antal order, sedan namn.
 * - Provision = Σ per order round(belopp exkl. moms × sats); hyra = round(Σ månadshyra ×
 *   dagar / dagar i månaden), samma som `storeCompensation` i beräkningslagret.
 *
 * Kastar `DomainError` om butiken är okänd (saknar namn och har varken avtal, placering
 * eller order), så att en rapport aldrig skickas till fel mottagare av misstag.
 */
export function buildStoreReport(
  sources: ReportSources,
  storeId: string,
  monthOrPeriod: IsoMonth | Period,
  options: StoreReportOptions = {},
): StoreReport {
  if (typeof monthOrPeriod !== "string") {
    assertPeriod(monthOrPeriod);
    if (!isWholeMonth(monthOrPeriod)) {
      return buildRangeStoreReport(sources, storeId, monthOrPeriod, options);
    }
  }
  const month = typeof monthOrPeriod === "string" ? monthOrPeriod : monthOf(monthOrPeriod.start);
  const period = monthScope(month);
  const prevMonth = addMonths(month, -1);
  const prevPeriod = monthPeriod(prevMonth);
  const catalog = new Catalog(sources);
  const topN = options.topTitles ?? 5;
  if (!Number.isSafeInteger(topN) || topN < 0) {
    throw new DomainError(
      "invalid_input",
      `Antalet topptitlar måste vara ett heltal ≥ 0, fick ${topN}.`,
    );
  }

  // En liggare för förra och denna månad: hyra per butik-månad och provision per order
  // blir desamma som om månaderna räknades var för sig.
  const ledger = buildLedger({ ...sources, period: { start: prevPeriod.start, end: period.end } });
  const ctx = ledger.context;
  const known =
    sources.stores.some((s) => s.id === storeId) ||
    ctx.agreements.agreementsFor(storeId).length > 0 ||
    ctx.placements
      .machineIds()
      .some((m) => ctx.placements.placementsFor(m).some((p) => p.storeId === storeId));
  if (!known) {
    throw new DomainError("invalid_input", `Butiken ${storeId} är okänd.`);
  }
  const store: NamedEntity = { id: storeId, name: catalog.store(storeId) };

  const entries = ledger.entries.filter((e) => e.storeId === storeId && e.month === month);
  const prevEntries = ledger.entries.filter((e) => e.storeId === storeId && e.month === prevMonth);
  const scope = { period, storeId };

  // Försäljning.
  const revenueOre = sumEntries(entries, (e) => e.netRevenueOre);
  const grossOre = sumEntries(entries, (e) => e.grossOre);
  const vatOre = sumEntries(entries, (e) => e.vatOre);
  const sales: StoreSales = {
    revenueOre,
    grossOre,
    vatOre,
    orders: entries.length,
    averageOrderOre: entries.length === 0 ? null : roundHalfUp(revenueOre, entries.length),
    evidence: evidence({
      rule: "Intäkt = Σ belopp exkl. moms för order från automater som stod i butiken orderns dag.",
      scope,
      orderCount: entries.length,
      figures: [
        fig("Intäkt exkl. moms", revenueOre, "ore"),
        fig("Moms", vatOre, "ore"),
        fig("Betalt inkl. moms", grossOre, "ore"),
        fig("Antal order", entries.length, "count"),
      ],
    }),
  };

  // Jämförelse.
  const prevRevenue = sumEntries(prevEntries, (e) => e.netRevenueOre);
  const revenueChange = changeBp(revenueOre, prevRevenue);
  const prevName = sameYear(month, prevMonth) ? monthNameText(prevMonth) : monthText(prevMonth);
  const comparison: StoreComparison = {
    month: prevMonth,
    revenueOre: prevRevenue,
    orders: prevEntries.length,
    revenueChangeBp: revenueChange,
    ordersDiff: entries.length - prevEntries.length,
    text:
      revenueChange === null
        ? `Ingen försäljning i ${prevName} att jämföra med.`
        : `${signedPctText(revenueChange)} mot ${prevName} (${krText(prevRevenue)} på ${ordersText(prevEntries.length)}).`,
    evidence: evidence({
      rule: "Förändring = round((intäkt nu − intäkt förra månaden) × 10 000 / intäkt förra månaden) bp.",
      scope: { period: prevPeriod, storeId },
      orderCount: prevEntries.length,
      figures: [
        fig("Intäkt denna månad", revenueOre, "ore"),
        fig("Intäkt förra månaden", prevRevenue, "ore"),
        ...(revenueChange === null ? [] : [fig("Förändring", revenueChange, "bp")]),
      ],
    }),
  };

  const weeks = buildWeeks(entries, period, storeId);
  const details = options.details === true;
  // Utan detaljer finns inga titlar i rapporten: varken listan eller slutsatsen nämner dem.
  const allTitles = details ? rankTitles(entries, revenueOre, period, storeId, catalog) : [];
  const topTitles = allTitles.slice(0, topN);
  const machines = buildMachines(entries, period, storeId, ledger.context.placements, catalog);
  const splits = ledger.profitSplits.filter((x) => x.storeId === storeId && x.month === month);
  if (!options.pendingSplit) {
    const unpriced = splits.reduce((n, x) => n + x.unpricedOrders, 0);
    if (unpriced > 0) {
      const titles = [...new Set(splits.flatMap((x) => x.unpricedTitleIds))].map((id) =>
        catalog.title(id),
      );
      throw new DomainError(
        "missing_price",
        `${MISSING_PRICES_MESSAGE} ${ordersText(unpriced)} saknar inköpspris (${listText(titles)}). Lägg in priserna under Inköpspriser.`,
      );
    }
  }
  const compensation = buildCompensation(
    entries,
    ledger.storeMonthRent.filter((r) => r.storeId === storeId && r.month === month),
    storeId,
    period,
    ctx.agreements.agreementsFor(storeId),
    splits,
  );

  const report: StoreReport = {
    kind: "store",
    calcVersion: CALC_VERSION,
    month,
    period,
    store,
    conclusion: storeConclusion({
      periodName: monthText(month),
      prevName,
      sales,
      comparison,
      titles: allTitles,
      compensation,
      scope,
    }),
    greeting: options.greeting ?? null,
    sales,
    comparison,
    weeks,
    topTitles,
    machines,
    compensation,
    details,
  };
  assertStoreReportSafe(report);
  return report;
}

/**
 * Butiksrapporten för ett eget datumintervall (t.ex. 15–31 okt.), högst ett år.
 *
 * Samma regler som månadsrapporten, med tre skillnader:
 * - Jämförelsen görs mot lika många dagar närmast före (`previousPeriod`).
 * - Hyran räknas per kalendermånad för dagarna i intervallet (ett steg per månad).
 * - Vinstdelningen räknas per kalendermånad och avtal på intervallets dagar, som i
 *   liggaren (Butiker, Lönsamhet): förlusthanteringen och avrundningen gäller varje månad
 *   för sig, och över ett månadsskifte står ett andelssteg per månad.
 */
function buildRangeStoreReport(
  sources: ReportSources,
  storeId: string,
  range: Period,
  options: StoreReportOptions,
): StoreReport {
  const period: Period = { start: range.start, end: range.end };
  const month = monthOf(period.start);
  const prevPeriod = previousPeriod(period);
  const catalog = new Catalog(sources);
  const topN = options.topTitles ?? 5;
  if (!Number.isSafeInteger(topN) || topN < 0) {
    throw new DomainError(
      "invalid_input",
      `Antalet topptitlar måste vara ett heltal ≥ 0, fick ${topN}.`,
    );
  }
  // Egna liggare för intervallet och jämförelsen: hyra och vinstdelning räknas bara på
  // intervallets dagar.
  const ledger = buildLedger({ ...sources, period });
  const prevLedger = buildLedger({ ...sources, period: prevPeriod });
  const ctx = ledger.context;
  const known =
    sources.stores.some((s) => s.id === storeId) ||
    ctx.agreements.agreementsFor(storeId).length > 0 ||
    ctx.placements
      .machineIds()
      .some((m) => ctx.placements.placementsFor(m).some((p) => p.storeId === storeId));
  if (!known) {
    throw new DomainError("invalid_input", `Butiken ${storeId} är okänd.`);
  }
  const store: NamedEntity = { id: storeId, name: catalog.store(storeId) };
  const entries = ledger.entries.filter((e) => e.storeId === storeId);
  const prevEntries = prevLedger.entries.filter((e) => e.storeId === storeId);
  const scope = { period, storeId };
  const name = periodText(period);
  const prevName = periodText(prevPeriod);

  const revenueOre = sumEntries(entries, (e) => e.netRevenueOre);
  const grossOre = sumEntries(entries, (e) => e.grossOre);
  const vatOre = sumEntries(entries, (e) => e.vatOre);
  const sales: StoreSales = {
    revenueOre,
    grossOre,
    vatOre,
    orders: entries.length,
    averageOrderOre: entries.length === 0 ? null : roundHalfUp(revenueOre, entries.length),
    evidence: evidence({
      rule: "Intäkt = Σ belopp exkl. moms för order från automater som stod i butiken orderns dag.",
      scope,
      orderCount: entries.length,
      figures: [
        fig("Intäkt exkl. moms", revenueOre, "ore"),
        fig("Moms", vatOre, "ore"),
        fig("Betalt inkl. moms", grossOre, "ore"),
        fig("Antal order", entries.length, "count"),
      ],
    }),
  };

  const prevRevenue = sumEntries(prevEntries, (e) => e.netRevenueOre);
  const revenueChange = changeBp(revenueOre, prevRevenue);
  const comparison: StoreComparison = {
    month: monthOf(prevPeriod.start),
    period: prevPeriod,
    revenueOre: prevRevenue,
    orders: prevEntries.length,
    revenueChangeBp: revenueChange,
    ordersDiff: entries.length - prevEntries.length,
    text:
      revenueChange === null
        ? `Ingen försäljning ${prevName} att jämföra med.`
        : `${signedPctText(revenueChange)} mot ${prevName} (${krText(prevRevenue)} på ${ordersText(prevEntries.length)}).`,
    evidence: evidence({
      rule: "Förändring = round((intäkt nu − intäkt lika många dagar före) × 10 000 / intäkt då) bp.",
      scope: { period: prevPeriod, storeId },
      orderCount: prevEntries.length,
      figures: [
        fig("Intäkt i perioden", revenueOre, "ore"),
        fig("Intäkt perioden före", prevRevenue, "ore"),
        ...(revenueChange === null ? [] : [fig("Förändring", revenueChange, "bp")]),
      ],
    }),
  };

  const weeks = buildWeeks(entries, period, storeId);
  const details = options.details === true;
  const allTitles = details ? rankTitles(entries, revenueOre, period, storeId, catalog) : [];
  const machines = buildMachines(entries, period, storeId, ctx.placements, catalog);
  const splits = ledger.profitSplits.filter((x) => x.storeId === storeId);
  if (!options.pendingSplit) {
    const unpriced = splits.reduce((n, x) => n + x.unpricedOrders, 0);
    if (unpriced > 0) {
      const titles = [...new Set(splits.flatMap((x) => x.unpricedTitleIds))].map((id) =>
        catalog.title(id),
      );
      throw new DomainError(
        "missing_price",
        `${MISSING_PRICES_MESSAGE} ${ordersText(unpriced)} saknar inköpspris (${listText(titles)}). Lägg in priserna under Inköpspriser.`,
      );
    }
  }
  const compensation = buildCompensation(
    entries,
    ledger.storeMonthRent.filter((r) => r.storeId === storeId),
    storeId,
    period,
    ctx.agreements.agreementsFor(storeId),
    splits,
  );
  const report: StoreReport = {
    kind: "store",
    calcVersion: CALC_VERSION,
    month,
    period,
    store,
    conclusion: storeConclusion({
      periodName: name,
      prevName: `perioden före (${prevName})`,
      sales,
      comparison,
      titles: allTitles,
      compensation,
      scope,
    }),
    greeting: options.greeting ?? null,
    sales,
    comparison,
    weeks,
    topTitles: allTitles.slice(0, topN),
    machines,
    compensation,
    details,
  };
  assertStoreReportSafe(report);
  return report;
}

function sameYear(a: IsoMonth, b: IsoMonth): boolean {
  return a.slice(0, 4) === b.slice(0, 4);
}

function buildWeeks(entries: readonly LedgerEntry[], period: Period, storeId: string): StoreWeek[] {
  const acc = new Map<
    string,
    { range: Period; week: number; partial: boolean; orders: number; revenue: number }
  >();
  for (const d of eachDay(period.start, period.end)) {
    const w = weekOf(d);
    if (acc.has(w.key)) continue;
    const range = { start: maxDate(w.start, period.start), end: minDate(w.end, period.end) };
    acc.set(w.key, {
      range,
      week: w.week,
      partial: range.start !== w.start || range.end !== w.end,
      orders: 0,
      revenue: 0,
    });
  }
  for (const e of entries) {
    const a = acc.get(weekOf(e.order.businessDate).key)!;
    a.orders++;
    a.revenue += e.netRevenueOre;
  }
  return [...acc.entries()].map(([key, a]) => {
    const rangeText =
      a.range.start === a.range.end
        ? shortDateText(a.range.start)
        : `${Number(a.range.start.slice(8))}–${shortDateText(a.range.end)}`;
    return {
      key,
      week: a.week,
      label: `${weekText(a.range.start)} (${rangeText})`,
      range: a.range,
      partial: a.partial,
      orders: a.orders,
      revenueOre: a.revenue,
      evidence: evidence({
        rule: "Veckans intäkt = Σ belopp exkl. moms för butikens order i veckan (ISO-vecka, måndag–söndag), inom månaden.",
        scope: { period: a.range, storeId },
        orderCount: a.orders,
        figures: [
          fig("Intäkt exkl. moms", a.revenue, "ore"),
          fig("Antal order", a.orders, "count"),
        ],
      }),
    };
  });
}

function rankTitles(
  entries: readonly LedgerEntry[],
  totalRevenue: number,
  period: Period,
  storeId: string,
  catalog: Catalog,
): StoreTopTitle[] {
  const acc = new Map<string, { orders: number; revenue: number }>();
  for (const e of entries) {
    const a = acc.get(e.order.titleId);
    if (a) {
      a.orders++;
      a.revenue += e.netRevenueOre;
    } else acc.set(e.order.titleId, { orders: 1, revenue: e.netRevenueOre });
  }
  const rows = [...acc.entries()].map(([titleId, a]) => {
    const shareBp = ratioBp(a.revenue, totalRevenue) ?? 0;
    const name = catalog.title(titleId);
    return {
      titleId,
      name,
      orders: a.orders,
      revenueOre: a.revenue,
      shareBp,
      evidence: evidence({
        rule: "Andel = round(titelns intäkt × 10 000 / butikens intäkt) bp.",
        scope: { period, storeId, titleId },
        orderCount: a.orders,
        figures: [
          fig("Titelns intäkt", a.revenue, "ore"),
          fig("Butikens intäkt", totalRevenue, "ore"),
          fig("Andel", shareBp, "bp"),
        ],
        titleIds: [titleId],
      }),
    };
  });
  rows.sort((a, b) =>
    a.revenueOre !== b.revenueOre
      ? b.revenueOre - a.revenueOre
      : a.orders !== b.orders
        ? b.orders - a.orders
        : a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : a.titleId < b.titleId
              ? -1
              : 1,
  );
  return rows;
}

function buildMachines(
  entries: readonly LedgerEntry[],
  period: Period,
  storeId: string,
  placements: ReturnType<typeof buildLedger>["context"]["placements"],
  catalog: Catalog,
): StoreMachine[] {
  const placed = new Map<string, number>();
  for (const machineId of placements.machineIds()) {
    let days = 0;
    for (const p of placements.placementsFor(machineId)) {
      if (p.storeId !== storeId) continue;
      const overlap = intersectPeriods(period, { start: p.from, end: p.to ?? period.end });
      if (overlap) days += periodDays(overlap);
    }
    if (days > 0) placed.set(machineId, days);
  }
  const acc = new Map<string, { orders: number; revenue: number }>();
  for (const id of placed.keys()) acc.set(id, { orders: 0, revenue: 0 });
  for (const e of entries) {
    const id = e.order.machineId!;
    const a = acc.get(id) ?? { orders: 0, revenue: 0 };
    a.orders++;
    a.revenue += e.netRevenueOre;
    acc.set(id, a);
  }
  return [...acc.entries()]
    .map(([machineId, a]) => ({
      machineId,
      name: catalog.machine(machineId),
      placedDays: placed.get(machineId) ?? 0,
      orders: a.orders,
      revenueOre: a.revenue,
      evidence: evidence({
        rule: "Automatens intäkt i butiken = Σ belopp exkl. moms för order de dagar automaten stod i butiken.",
        scope: { period, storeId, machineId },
        orderCount: a.orders,
        figures: [
          fig("Intäkt exkl. moms", a.revenue, "ore"),
          fig("Antal order", a.orders, "count"),
          fig("Dagar i butiken", placed.get(machineId) ?? 0, "days"),
        ],
      }),
    }))
    .sort((a, b) =>
      a.revenueOre !== b.revenueOre
        ? b.revenueOre - a.revenueOre
        : a.name < b.name
          ? -1
          : a.name > b.name
            ? 1
            : 0,
    );
}

interface CommissionSegment {
  agreement: StoreAgreement | null;
  range: Period;
  orders: number;
  base: number;
  /** Σ belopp inkl. moms. */
  gross: number;
  commission: number;
  dates: IsoDate[];
}

/**
 * Butikens ersättning steg för steg.
 *
 * Provision: ett steg per avtal med provision som gällde någon dag i månaden, med
 * underlaget (belopp exkl. moms för order de dagarna). Provisionen avrundas per order,
 * så summan kan skilja något öre från "sats × underlag"; då står det i uträkningen.
 * Order under ett avtal utan provision (bara hyra) visas som ett steg per sådant avtal, och
 * order på dagar utan avtal som ett steg per sammanhängande följd av dagar utan avtal; båda
 * ger 0 kr. Stegens underlag summerar därför alltid till månadens intäkt exkl. moms.
 *
 * Hyra: round(Σ månadshyra × dagar / dagar i månaden), avrundad en gång per månad.
 */
function buildCompensation(
  entries: readonly LedgerEntry[],
  /** Butikens hyra per kalendermånad inom perioden (en rad för en månadsrapport). */
  rentRows: readonly StoreMonthRent[],
  storeId: string,
  period: Period,
  agreements: readonly StoreAgreement[],
  profitSplits: readonly StoreMonthSplit[],
): StoreCompensationBreakdown {
  const inMonth = agreements.filter(
    (a) => intersectPeriods(period, { start: a.validFrom, end: a.validTo ?? period.end }) !== null,
  );
  // Ett segment per avtal som gällde någon dag i perioden (med eller utan provision).
  // Vinstdelning räknas per kalendermånad (berakningar.md 4): eget datum över ett
  // månadsskifte ger ett segment per avtal och månad, samma andel som månadsrapporterna.
  const segments = new Map<string, CommissionSegment>();
  for (const a of inMonth) {
    const range = intersectPeriods(period, { start: a.validFrom, end: a.validTo ?? period.end })!;
    for (const part of isProfitSplit(a) ? byMonth(range) : [range]) {
      segments.set(segmentKey(a, part.start), {
        agreement: a,
        range: part,
        orders: 0,
        base: 0,
        gross: 0,
        commission: 0,
        dates: [],
      });
    }
  }
  // Ett segment per sammanhängande följd av dagar utan avtal.
  const gaps: CommissionSegment[] = [];
  for (const day of eachDay(period.start, period.end)) {
    if (agreementOn(inMonth, day)) continue;
    const last = gaps[gaps.length - 1];
    if (last && addDays(last.range.end, 1) === day)
      last.range = { start: last.range.start, end: day };
    else
      gaps.push({
        agreement: null,
        range: { start: day, end: day },
        orders: 0,
        base: 0,
        gross: 0,
        commission: 0,
        dates: [],
      });
  }
  for (const e of entries) {
    const date = e.order.businessDate;
    const a = agreementOn(inMonth, date);
    const seg = a
      ? segments.get(segmentKey(a, date))!
      : gaps.find((g) => g.range.start <= date && date <= g.range.end)!;
    seg.orders++;
    seg.base += e.netRevenueOre;
    seg.gross += e.grossOre;
    seg.commission += e.commissionOre;
    if (!seg.dates.includes(date)) seg.dates.push(date);
  }
  for (const seg of [...segments.values(), ...gaps]) seg.dates.sort();

  const steps: CompensationStep[] = [];
  const byStart = (x: CommissionSegment, y: CommissionSegment): number =>
    x.range.start < y.range.start ? -1 : x.range.start > y.range.start ? 1 : 0;
  const splits: StoreProfitSplit[] = [];
  for (const seg of [...segments.values()].sort(byStart)) {
    if (isProfitSplit(seg.agreement)) {
      const month = monthOf(seg.range.start);
      const ms = profitSplits.find(
        (x) => x.validFrom === seg.agreement!.validFrom && x.month === month,
      );
      const split = profitSplitRow(seg, ms ?? null, storeId);
      splits.push(split);
      steps.push(shareStep(split, storeId, period));
      continue;
    }
    const bp = seg.agreement!.commissionBp ?? 0;
    if (bp === 0) {
      if (seg.orders === 0) continue;
      steps.push({
        kind: "no_commission",
        label: `Avtal utan provision (${periodText(seg.range)})`,
        calculation: `${ordersText(seg.orders)} (${krText(seg.base, "always")} exkl. moms) såldes när avtalet bara hade hyra och ger ingen provision`,
        amountOre: 0,
        evidence: evidence({
          rule: "Avtalet som gällde orderns dag har ingen provisionssats; ersättningen är bara hyra.",
          scope: { period: seg.range, storeId },
          orderCount: seg.orders,
          figures: [fig("Underlag exkl. moms", seg.base, "ore"), fig("Provisionssats", 0, "bp")],
          dates: seg.dates,
        }),
      });
      continue;
    }
    const exact = applyBp(seg.base, bp);
    const roundingNote =
      exact === seg.commission
        ? ""
        : ` (avrundat per order; ${pctText(bp, 1)} av summan vore ${krText(exact, "always")})`;
    steps.push({
      kind: "commission",
      label: `Provision ${pctText(bp, bp % 100 === 0 ? 0 : 1)} (${periodText(seg.range)})`,
      calculation: `${pctText(bp, bp % 100 === 0 ? 0 : 1)} av ${krText(seg.base, "always")} exkl. moms (${ordersText(seg.orders)}) = ${krText(seg.commission, "always")}${roundingNote}`,
      amountOre: seg.commission,
      evidence: evidence({
        rule: "Provision = Σ per order round(belopp exkl. moms × provisionssats / 10 000), enligt avtalet som gällde orderns dag.",
        scope: { period: seg.range, storeId },
        orderCount: seg.orders,
        figures: [
          fig("Underlag exkl. moms", seg.base, "ore"),
          fig("Provisionssats", bp, "bp"),
          fig("Provision", seg.commission, "ore"),
        ],
      }),
    });
  }
  for (const gap of gaps) {
    if (gap.orders === 0) continue;
    steps.push({
      kind: "no_agreement",
      label: `Order utan avtal (${periodText(gap.range)})`,
      calculation: `${ordersText(gap.orders)} (${krText(gap.base, "always")}) såldes dagar utan avtal och ger ingen provision`,
      amountOre: 0,
      evidence: evidence({
        rule: "Order på dagar då butiken saknade avtal ger ingen provision. Perioden är en sammanhängande följd av dagar utan avtal.",
        scope: { period: gap.range, storeId },
        orderCount: gap.orders,
        figures: [fig("Belopp exkl. moms", gap.base, "ore")],
        dates: gap.dates,
      }),
    });
  }

  // Hyran avrundas en gång per kalendermånad. Eget datum över flera månader ger ett
  // hyressteg per månad; summan är periodens hyra.
  const rentOre = rentRows.reduce((n, r) => n + r.rentOre, 0);
  const dim = rentRows.length === 1 ? rentRows[0]!.daysInMonth : periodDays(period);
  const rentParts: RentPart[] = rentRows.flatMap((r) =>
    r.segments.map((s) => ({
      monthlyRentOre: s.monthlyRentOre,
      start: s.start,
      end: s.end,
      days: s.days,
    })),
  );
  for (const sm of rentRows) {
    const smParts = sm.segments.map((s) => ({
      monthlyRentOre: s.monthlyRentOre,
      start: s.start,
      end: s.end,
      days: s.days,
    }));
    const smDim = sm.daysInMonth;
    const several = rentRows.length > 1;
    const single = smParts.length === 1 ? smParts[0]! : null;
    let calculation: string;
    if (single && single.days === smDim) {
      calculation = `${krText(single.monthlyRentOre, "always")} per månad, hela månaden = ${krText(sm.rentOre, "always")}`;
    } else if (single) {
      calculation = `${krText(single.monthlyRentOre, "always")} per månad × ${single.days} av ${smDim} dagar (${periodText({ start: single.start, end: single.end })}) = ${krText(sm.rentOre, "always")}`;
    } else {
      const terms = smParts
        .map((p) => `${krText(p.monthlyRentOre, "always")} × ${p.days} dagar`)
        .join(" + ");
      calculation = `(${terms}) / ${smDim} dagar = ${krText(sm.rentOre, "always")}`;
    }
    steps.push({
      kind: "rent",
      label: several
        ? `Hyra (${periodText({ start: smParts[0]!.start, end: smParts[smParts.length - 1]!.end })})`
        : smParts.length === 1 && smParts[0]!.days === smDim
          ? "Hyra"
          : "Hyra (delmånad)",
      calculation,
      amountOre: sm.rentOre,
      evidence: evidence({
        rule: "Hyra = round(Σ månadshyra × dagar med hyran / dagar i månaden), avrundad en gång per butik och månad.",
        scope: {
          period: several
            ? { start: smParts[0]!.start, end: smParts[smParts.length - 1]!.end }
            : period,
          storeId,
        },
        orderCount: 0,
        figures: [
          ...smParts.flatMap((p) => [
            fig("Månadshyra", p.monthlyRentOre, "ore"),
            fig("Dagar", p.days, "days"),
          ]),
          fig("Dagar i månaden", smDim, "days"),
          fig("Hyra", sm.rentOre, "ore"),
        ],
      }),
    });
  }

  const commissionOre = steps.reduce((s, x) => s + (x.kind === "commission" ? x.amountOre : 0), 0);
  const shareOre = splits.reduce((s, x) => s + x.storeShareOre, 0);
  const pending = splits.some((x) => x.pending);
  const totalOre = shareOre + commissionOre + rentOre;
  // Hyran nämns bara när ett avtal i månaden har hyra (eller en hyra ändå räknats).
  const hasRent = inMonth.some((a) => (a.monthlyRentOre ?? 0) > 0);
  const showRent = rentOre !== 0 || hasRent;
  const parts = [
    ...(splits.length > 0 ? [`andel ${krText(shareOre, "always")}`] : []),
    ...(commissionOre !== 0 || splits.length === 0
      ? [`provision ${krText(commissionOre, "always")}`]
      : []),
    ...(rentOre !== 0 || (splits.length === 0 && hasRent)
      ? [`hyra ${krText(rentOre, "always")}`]
      : []),
  ];
  const capitalized = parts.join(" + ").replace(/^./, (c) => c.toUpperCase());
  steps.push({
    kind: "total",
    label: splits.length > 0 ? "Er ersättning" : "Ersättning totalt",
    calculation:
      parts.length === 1 ? capitalized : `${capitalized} = ${krText(totalOre, "always")}`,
    amountOre: totalOre,
    evidence: evidence({
      rule: `Butiksersättning = ${[
        ...(splits.length > 0 ? ["andel av vinsten"] : []),
        "provision",
        ...(showRent ? ["hyra"] : []),
      ].join(" + ")}.`,
      scope: { period, storeId },
      orderCount: entries.length,
      figures: [
        ...(splits.length > 0 ? [fig("Andel", shareOre, "ore")] : []),
        fig("Provision", commissionOre, "ore"),
        ...(showRent ? [fig("Hyra", rentOre, "ore")] : []),
        fig("Ersättning", totalOre, "ore"),
      ],
    }),
  });

  const hasSplit = inMonth.some((a) => isProfitSplit(a));
  const hasCommission = inMonth.some((a) => !isProfitSplit(a) && (a.commissionBp ?? 0) > 0);
  const model: CompensationModel = hasSplit
    ? hasRent
      ? "profit_split_and_rent"
      : "profit_split"
    : hasCommission && hasRent
      ? "commission_and_rent"
      : hasCommission
        ? "commission"
        : hasRent
          ? "rent"
          : "none";
  return {
    model,
    modelText: modelText(inMonth, period),
    steps,
    rentParts,
    daysInMonth: dim,
    splits,
    shareOre,
    commissionOre,
    rentOre,
    totalOre,
    pending,
    evidence: evidence({
      rule: "Ersättningen följer de avtal som gällde i butiken under månaden.",
      scope: { period, storeId },
      orderCount: entries.length,
      figures: [
        fig("Provision", commissionOre, "ore"),
        ...(showRent ? [fig("Hyra", rentOre, "ore")] : []),
        fig("Ersättning", totalOre, "ore"),
      ],
      dates: inMonth.map((a) => a.validFrom),
    }),
  };
}

/** Vinstdelningen för ett avtalssegment ur liggarens uträkning. */
function profitSplitRow(
  seg: CommissionSegment,
  ms: StoreMonthSplit | null,
  storeId: string,
): StoreProfitSplit {
  const a = seg.agreement!;
  const shareBp = a.commissionBp ?? 0;
  const lossTreatment: LossTreatment = a.lossTreatment ?? "zero";
  const r = ms?.result;
  const pending = (ms?.unpricedOrders ?? 0) > 0;
  const salesInclVatOre = pending ? seg.gross : (r?.salesInclVatOre ?? 0);
  const storeShareOre = pending ? 0 : (r?.storeShareOre ?? 0);
  const profitOre = pending ? 0 : (r?.profitOre ?? 0);
  return {
    validFrom: a.validFrom,
    range: seg.range,
    orders: seg.orders,
    shareBp,
    lossTreatment,
    vmbBeforeSplit: a.vmbBeforeSplit === true,
    salesInclVatOre,
    refundsOre: pending ? 0 : (r?.refundsOre ?? 0),
    vmbVatOre: pending ? 0 : (r?.vmbVatOre ?? 0),
    purchasesOre: pending ? 0 : (r?.purchasesOre ?? 0),
    cardFeesOre: pending ? 0 : (r?.cardFeesOre ?? 0),
    profitOre,
    storeShareOre,
    operatorShareOre: profitOre - storeShareOre,
    pending,
    evidence: evidence({
      rule:
        a.vmbBeforeSplit !== true
          ? "Vinst = försäljning inkl. moms − återbetalningar − inköp − kortavgifter (avtalet drar inte VMB-moms före delningen). Butikens andel = round(vinst × andel / 10 000), 0 vid förlust om inte avtalet delar förlusten."
          : "Vinst = försäljning inkl. moms − återbetalningar − VMB-moms (20 % av försäljning − återbetalningar − inköp, om positiv) − inköp − kortavgifter. Butikens andel = round(vinst × andel / 10 000), 0 vid förlust om inte avtalet delar förlusten.",
      scope: { period: seg.range, storeId },
      orderCount: seg.orders,
      figures: pending
        ? [fig("Försäljning inkl. moms", salesInclVatOre, "ore"), fig("Andel", shareBp, "bp")]
        : [
            fig("Försäljning inkl. moms", r?.salesInclVatOre ?? 0, "ore"),
            fig("Återbetalningar", r?.refundsOre ?? 0, "ore"),
            fig("VMB-moms", r?.vmbVatOre ?? 0, "ore"),
            fig("Inköp", r?.purchasesOre ?? 0, "ore"),
            fig("Kortavgifter", r?.cardFeesOre ?? 0, "ore"),
            fig("Vinst", profitOre, "ore"),
            fig("Andel", shareBp, "bp"),
            fig("Butikens andel", storeShareOre, "ore"),
          ],
    }),
  };
}

/** Steget "Butikens andel 50 % av vinsten" i uträkningen. */
function shareStep(split: StoreProfitSplit, storeId: string, period: Period): CompensationStep {
  const pct = pctText(split.shareBp, split.shareBp % 100 === 0 ? 0 : 1);
  const calculation = split.pending
    ? "Räknas i månadsrapporten"
    : split.profitOre < 0 && split.storeShareOre === 0
      ? `Ingen vinst (${krText(split.profitOre, "always")}), andelen blir 0 kr`
      : `${pct} av ${krText(split.profitOre, "always")} = ${krText(split.storeShareOre, "always")}`;
  return {
    kind: "share",
    label: `Er andel ${pct}${split.range.start === period.start && split.range.end === period.end ? "" : ` (${periodText(split.range)})`}`,
    calculation,
    amountOre: split.storeShareOre,
    evidence: { ...split.evidence, scope: { period: split.range, storeId } },
  };
}

/** Segmentets nyckel: avtalet, och för vinstdelning även kalendermånaden. */
function segmentKey(a: StoreAgreement, date: IsoDate): string {
  return isProfitSplit(a) ? `${a.validFrom}|${monthOf(date)}` : a.validFrom;
}

/** Perioden delad per kalendermånad. */
function byMonth(range: Period): Period[] {
  const out: Period[] = [];
  let start = range.start;
  while (start <= range.end) {
    const m = monthPeriod(monthOf(start));
    const end = m.end < range.end ? m.end : range.end;
    out.push({ start, end });
    start = addDays(end, 1);
  }
  return out;
}

/** Avtalet som gällde en viss dag, eller `null` om butiken saknade avtal den dagen. */
function agreementOn(agreements: readonly StoreAgreement[], date: IsoDate): StoreAgreement | null {
  return (
    agreements.find((a) => a.validFrom <= date && (a.validTo === null || date <= a.validTo)) ?? null
  );
}

/** Avtalens villkor i klartext; flera avtal under månaden räknas upp med sina datum. */
function modelText(agreements: readonly StoreAgreement[], period: Period): string {
  if (agreements.length === 0) return "Inget avtal gällde under månaden.";
  const terms = (a: StoreAgreement): string => {
    const parts: string[] = [];
    if (isProfitSplit(a)) {
      const bp = a.commissionBp ?? 0;
      parts.push(
        `${pctText(bp, bp % 100 === 0 ? 0 : 1)} av vinsten efter kostnader${a.vmbBeforeSplit === true ? " (VMB-moms dras före delning)" : ""}`,
      );
    } else if ((a.commissionBp ?? 0) > 0) {
      const bp = a.commissionBp!;
      parts.push(`provision ${pctText(bp, bp % 100 === 0 ? 0 : 1)} på försäljningen exkl. moms`);
    }
    if ((a.monthlyRentOre ?? 0) > 0) parts.push(`hyra ${krText(a.monthlyRentOre!)} per månad`);
    if (parts.length === 0) parts.push("ingen ersättning");
    return listText(parts);
  };
  const capital = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
  if (agreements.length === 1) {
    const a = agreements[0]!;
    const range = intersectPeriods(period, { start: a.validFrom, end: a.validTo ?? period.end })!;
    const whole = range.start === period.start && range.end === period.end;
    if (isProfitSplit(a)) return `${capital(terms(a))}, giltigt från ${dateText(a.validFrom)}.`;
    return `${capital(terms(a))}${whole ? "" : ` (${periodText(range)})`}.`;
  }
  return (
    agreements
      .map((a) => {
        const range = intersectPeriods(period, {
          start: a.validFrom,
          end: a.validTo ?? period.end,
        })!;
        return `${periodText(range)}: ${terms(a)}`;
      })
      .map(capital)
      .join(". ") + "."
  );
}

/**
 * Slutsatsen överst i butiksrapporten, en mening. Reglerna i ordning:
 * 1. Ingen försäljning → "Ingen försäljning i november 2026" (+ ersättningen om den är > 0).
 * 2. Ingen försäljning förra månaden → intäkt och antal order, utan jämförelse.
 * 3. |förändring| < 2 % → "i nivå med".
 * 4. Annars "ökade/minskade X % till Y".
 * Har butiken sålt minst två titlar läggs den mest sålda titeln och dess andel till.
 */
function storeConclusion(args: {
  /** "november 2026" eller "15–31 okt. 2026". */
  periodName: string;
  prevName: string;
  sales: StoreSales;
  comparison: StoreComparison;
  titles: readonly StoreTopTitle[];
  compensation: StoreCompensationBreakdown;
  scope: { period: Period; storeId: string };
}): Conclusion {
  const { periodName, prevName, sales, comparison, titles, compensation, scope } = args;
  const top = titles[0];
  const figures = [
    fig("Intäkt exkl. moms", sales.revenueOre, "ore"),
    fig("Antal order", sales.orders, "count"),
    fig("Intäkt förra månaden", comparison.revenueOre, "ore"),
  ];
  const ev = (
    rule: string,
    extra: ReturnType<typeof fig>[] = [],
    titleIds: string[] = [],
  ): Evidence =>
    evidence({ rule, scope, orderCount: sales.orders, figures: [...figures, ...extra], titleIds });

  if (sales.orders === 0) {
    const tail =
      compensation.totalOre > 0 ? `; ersättningen blir ${krText(compensation.totalOre)}` : "";
    return {
      text: `Ingen försäljning i ${periodName}${tail}.`,
      ruleId: "store.no_sales",
      evidence: ev("Inga order från butikens automater under månaden.", [
        fig("Ersättning", compensation.totalOre, "ore"),
      ]),
    };
  }
  const topClause =
    titles.length >= 2 && top
      ? `, och ${top.name} stod för ${pctText(top.shareBp)} av intäkten`
      : "";
  const topFigures = titles.length >= 2 && top ? [fig(`Andel ${top.name}`, top.shareBp, "bp")] : [];
  const topIds = titles.length >= 2 && top ? [top.titleId] : [];
  const change = comparison.revenueChangeBp;
  if (change === null) {
    return {
      text: `Försäljningen blev ${krText(sales.revenueOre)} på ${ordersText(sales.orders)}${topClause}; i ${prevName} fanns ingen försäljning att jämföra med.`,
      ruleId: "store.first",
      evidence: ev(
        "Förra månaden saknade försäljning, så ingen förändring räknas.",
        topFigures,
        topIds,
      ),
    };
  }
  if (Math.abs(change) < FLAT_CHANGE_BP) {
    return {
      text: `Försäljningen låg i nivå med ${prevName}: ${krText(sales.revenueOre)} på ${ordersText(sales.orders)}${topClause}.`,
      ruleId: "store.flat",
      evidence: ev(
        `Förändringen ${signedPctText(change, 1)} är mindre än ${pctText(FLAT_CHANGE_BP)}.`,
        [fig("Förändring", change, "bp"), ...topFigures],
        topIds,
      ),
    };
  }
  const verb = change > 0 ? "ökade" : "minskade";
  return {
    text: `Försäljningen ${verb} ${pctText(Math.abs(change))} till ${krText(sales.revenueOre)} jämfört med ${prevName}${topClause}.`,
    ruleId: change > 0 ? "store.up" : "store.down",
    evidence: ev(
      "Förändring = round((nu − förra månaden) × 10 000 / förra månaden) bp.",
      [fig("Förändring", change, "bp"), ...topFigures],
      topIds,
    ),
  };
}

/** Nycklar som aldrig får finnas i en butiksrapport (inköp, marginal, vinst, saknade priser). */
const FORBIDDEN_KEY = /cost|margin|profit|unpriced|inkop|inköp|vinst|marginal|purchase|owner/i;
/** Ord som aldrig får förekomma i butiksrapportens texter. */
const FORBIDDEN_TEXT = /inköp|vinst|marginal|lönsam|ägar/i;

/**
 * Kontrollerar att butiksrapporten inte innehåller inköp, marginal, vinst eller andra
 * butikers data: inga förbjudna nycklar eller ord någonstans (även nästlat; vid
 * vinstdelning är ersättningsdelen, `compensation`, undantagen), och varje
 * `storeId` i underlagen är butikens egen. Namn (butik, automat, titel) och hälsning skrivs
 * av människor och undantas från ordkontrollen, även där de citeras i andra texter: en titel
 * som heter "Vinsttröja" stoppar alltså inte rapporten, men ordet "vinst" utanför ett namn
 * gör det. Kastar `DomainError` vid fynd.
 */
export function assertStoreReportSafe(report: StoreReport): void {
  const own = report.store.id;
  const isHumanText = (path: string): boolean =>
    path.endsWith(".name") || path.endsWith(".greeting");
  // Namn och hälsning i rapporten, längst först så att ett kort namn inte delar ett långt.
  const names = new Set<string>();
  const collect = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (isHumanText(path) && value.length > 0) names.add(value);
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => collect(v, `${path}[${i}]`));
    } else if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) collect(v, `${path}.${k}`);
    }
  };
  collect(report, "rapport");
  const humanTexts = [...names].sort((a, b) => b.length - a.length);
  const withoutNames = (text: string): string =>
    humanTexts.reduce((t, n) => t.split(n).join(" "), text);

  // Vinstdelning: avtalet bygger på butikens månadssummor för inköp och vinst, så de får
  // stå i ersättningsdelen (aldrig per titel, automat eller dag).
  const openBook = splitsOf(report.compensation).length > 0;
  const isSettlement = (path: string): boolean =>
    openBook && (path === "rapport.compensation" || path.startsWith("rapport.compensation."));
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (!isHumanText(path) && !isSettlement(path) && FORBIDDEN_TEXT.test(withoutNames(value))) {
        throw new DomainError(
          "invalid_input",
          `Butiksrapporten innehåller otillåten text i ${path}.`,
        );
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((v, i) => walk(v, `${path}[${i}]`));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        if (FORBIDDEN_KEY.test(k) && !isSettlement(`${path}.${k}`)) {
          throw new DomainError(
            "invalid_input",
            `Butiksrapporten innehåller otillåtet fält ${path}.${k}.`,
          );
        }
        if (k === "storeId" && v !== own) {
          throw new DomainError(
            "invalid_input",
            `Butiksrapporten innehåller en annan butik i ${path}.`,
          );
        }
        walk(v, `${path}.${k}`);
      }
    }
  };
  walk(report, "rapport");
}
