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
 * `assertStoreReportSafe` kontrollerar hela objektet innan det returneras.
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
  addMonths,
  applyBp,
  buildLedger,
  eachDay,
  intersectPeriods,
  maxDate,
  minDate,
  monthPeriod,
  periodDays,
  ratioBp,
  roundHalfUp,
  changeBp,
  weekOf,
  type IsoDate,
  type IsoMonth,
  type LedgerEntry,
  type Period,
  type StoreAgreement,
} from "@/domain";
import { Catalog, evidence, fig, monthScope, sumEntries } from "./shared";
import {
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

/** Jämförelse mot förra månaden. */
export interface StoreComparison {
  readonly month: IsoMonth;
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
export type CompensationModel = "commission" | "rent" | "commission_and_rent" | "none";

/** Ett steg i uträkningen av butikens ersättning. */
export interface CompensationStep {
  readonly kind: "commission" | "no_agreement" | "rent" | "total";
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

/** Butikens ersättning, uträknad steg för steg. */
export interface StoreCompensationBreakdown {
  readonly model: CompensationModel;
  /** Avtalet i klartext, t.ex. "Provision 10 % på försäljningen exkl. moms och hyra 1 000 kr per månad". */
  readonly modelText: string;
  readonly steps: readonly CompensationStep[];
  readonly rentParts: readonly RentPart[];
  readonly daysInMonth: number;
  readonly commissionOre: number;
  readonly rentOre: number;
  readonly totalOre: number;
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
}

/** Inställningar för butiksrapporten. */
export interface StoreReportOptions {
  /** Antal titlar i topplistan. Standard 5. */
  readonly topTitles?: number;
  /** Hälsning till butiken. */
  readonly greeting?: string | null;
}

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
  month: IsoMonth,
  options: StoreReportOptions = {},
): StoreReport {
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
  const allTitles = rankTitles(entries, revenueOre, period, storeId, catalog);
  const topTitles = allTitles.slice(0, topN);
  const machines = buildMachines(entries, period, storeId, ledger.context.placements, catalog);
  const compensation = buildCompensation(
    entries,
    ledger.storeMonthRent,
    storeId,
    month,
    period,
    ctx.agreements.agreementsFor(storeId),
  );

  const report: StoreReport = {
    kind: "store",
    calcVersion: CALC_VERSION,
    month,
    period,
    store,
    conclusion: storeConclusion({
      month,
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
  commission: number;
  dates: IsoDate[];
}

/**
 * Butikens ersättning steg för steg.
 *
 * Provision: ett steg per avtal med provision som gällde någon dag i månaden, med
 * underlaget (belopp exkl. moms för order de dagarna). Provisionen avrundas per order,
 * så summan kan skilja något öre från "sats × underlag"; då står det i uträkningen.
 * Order på dagar utan avtal ger ingen provision och visas som ett eget steg.
 *
 * Hyra: round(Σ månadshyra × dagar / dagar i månaden), avrundad en gång per månad.
 */
function buildCompensation(
  entries: readonly LedgerEntry[],
  storeMonthRent: ReturnType<typeof buildLedger>["storeMonthRent"],
  storeId: string,
  month: IsoMonth,
  period: Period,
  agreements: readonly StoreAgreement[],
): StoreCompensationBreakdown {
  const inMonth = agreements.filter(
    (a) => intersectPeriods(period, { start: a.validFrom, end: a.validTo ?? period.end }) !== null,
  );
  const segments = new Map<string, CommissionSegment>();
  for (const a of inMonth) {
    if ((a.commissionBp ?? 0) === 0) continue;
    const range = intersectPeriods(period, { start: a.validFrom, end: a.validTo ?? period.end })!;
    segments.set(a.validFrom, {
      agreement: a,
      range,
      orders: 0,
      base: 0,
      commission: 0,
      dates: [],
    });
  }
  let noAgreement: CommissionSegment | null = null;
  for (const e of entries) {
    const date = e.order.businessDate;
    const a =
      inMonth.find((x) => x.validFrom <= date && (x.validTo === null || date <= x.validTo)) ?? null;
    if (a === null) {
      noAgreement ??= {
        agreement: null,
        range: { start: date, end: date },
        orders: 0,
        base: 0,
        commission: 0,
        dates: [],
      };
      noAgreement.range = {
        start: minDate(noAgreement.range.start, date),
        end: maxDate(noAgreement.range.end, date),
      };
      noAgreement.orders++;
      noAgreement.base += e.netRevenueOre;
      noAgreement.dates.push(date);
      continue;
    }
    const seg = segments.get(a.validFrom);
    if (!seg) continue; // avtal utan provision: ingen provision (e.commissionOre är 0)
    seg.orders++;
    seg.base += e.netRevenueOre;
    seg.commission += e.commissionOre;
  }

  const steps: CompensationStep[] = [];
  for (const seg of [...segments.values()].sort((x, y) =>
    x.range.start < y.range.start ? -1 : 1,
  )) {
    const bp = seg.agreement!.commissionBp!;
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
  if (noAgreement) {
    steps.push({
      kind: "no_agreement",
      label: "Order utan avtal",
      calculation: `${ordersText(noAgreement.orders)} (${krText(noAgreement.base, "always")}) såldes dagar utan avtal och ger ingen provision`,
      amountOre: 0,
      evidence: evidence({
        rule: "Order på dagar då butiken saknade avtal ger ingen provision.",
        scope: { period: noAgreement.range, storeId },
        orderCount: noAgreement.orders,
        figures: [fig("Belopp exkl. moms", noAgreement.base, "ore")],
        dates: noAgreement.dates,
      }),
    });
  }

  const sm = storeMonthRent.find((r) => r.storeId === storeId && r.month === month) ?? null;
  const rentOre = sm?.rentOre ?? 0;
  const dim = sm?.daysInMonth ?? periodDays(period);
  const rentParts: RentPart[] = (sm?.segments ?? []).map((s) => ({
    monthlyRentOre: s.monthlyRentOre,
    start: s.start,
    end: s.end,
    days: s.days,
  }));
  if (sm) {
    const single = rentParts.length === 1 ? rentParts[0]! : null;
    let calculation: string;
    if (single && single.days === dim) {
      calculation = `${krText(single.monthlyRentOre, "always")} per månad, hela månaden = ${krText(rentOre, "always")}`;
    } else if (single) {
      calculation = `${krText(single.monthlyRentOre, "always")} per månad × ${single.days} av ${dim} dagar (${periodText({ start: single.start, end: single.end })}) = ${krText(rentOre, "always")}`;
    } else {
      const terms = rentParts
        .map((p) => `${krText(p.monthlyRentOre, "always")} × ${p.days} dagar`)
        .join(" + ");
      calculation = `(${terms}) / ${dim} dagar = ${krText(rentOre, "always")}`;
    }
    steps.push({
      kind: "rent",
      label: rentParts.length === 1 && rentParts[0]!.days === dim ? "Hyra" : "Hyra (delmånad)",
      calculation,
      amountOre: rentOre,
      evidence: evidence({
        rule: "Hyra = round(Σ månadshyra × dagar med hyran / dagar i månaden), avrundad en gång per butik och månad.",
        scope: { period, storeId },
        orderCount: 0,
        figures: [
          ...rentParts.flatMap((p) => [
            fig("Månadshyra", p.monthlyRentOre, "ore"),
            fig("Dagar", p.days, "days"),
          ]),
          fig("Dagar i månaden", dim, "days"),
          fig("Hyra", rentOre, "ore"),
        ],
      }),
    });
  }

  const commissionOre = steps.reduce((s, x) => s + (x.kind === "commission" ? x.amountOre : 0), 0);
  const totalOre = commissionOre + rentOre;
  steps.push({
    kind: "total",
    label: "Ersättning totalt",
    calculation: `Provision ${krText(commissionOre, "always")} + hyra ${krText(rentOre, "always")} = ${krText(totalOre, "always")}`,
    amountOre: totalOre,
    evidence: evidence({
      rule: "Butiksersättning = provision + hyra.",
      scope: { period, storeId },
      orderCount: entries.length,
      figures: [
        fig("Provision", commissionOre, "ore"),
        fig("Hyra", rentOre, "ore"),
        fig("Ersättning", totalOre, "ore"),
      ],
    }),
  });

  const hasCommission = inMonth.some((a) => (a.commissionBp ?? 0) > 0);
  const hasRent = inMonth.some((a) => (a.monthlyRentOre ?? 0) > 0);
  const model: CompensationModel =
    hasCommission && hasRent
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
    commissionOre,
    rentOre,
    totalOre,
    evidence: evidence({
      rule: "Ersättningen följer de avtal som gällde i butiken under månaden.",
      scope: { period, storeId },
      orderCount: entries.length,
      figures: [
        fig("Provision", commissionOre, "ore"),
        fig("Hyra", rentOre, "ore"),
        fig("Ersättning", totalOre, "ore"),
      ],
      dates: inMonth.map((a) => a.validFrom),
    }),
  };
}

/** Avtalens villkor i klartext; flera avtal under månaden räknas upp med sina datum. */
function modelText(agreements: readonly StoreAgreement[], period: Period): string {
  if (agreements.length === 0) return "Inget avtal gällde under månaden.";
  const terms = (a: StoreAgreement): string => {
    const parts: string[] = [];
    if ((a.commissionBp ?? 0) > 0) {
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
  month: IsoMonth;
  prevName: string;
  sales: StoreSales;
  comparison: StoreComparison;
  titles: readonly StoreTopTitle[];
  compensation: StoreCompensationBreakdown;
  scope: { period: Period; storeId: string };
}): Conclusion {
  const { month, prevName, sales, comparison, titles, compensation, scope } = args;
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
      text: `Ingen försäljning i ${monthText(month)}${tail}.`,
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
 * butikers data: inga förbjudna nycklar eller ord någonstans (även nästlat), och varje
 * `storeId` i underlagen är butikens egen. Namn och hälsning (som skrivs av människor)
 * undantas från ordkontrollen. Kastar `DomainError` vid fynd.
 */
export function assertStoreReportSafe(report: StoreReport): void {
  const own = report.store.id;
  const walk = (value: unknown, path: string): void => {
    if (typeof value === "string") {
      if (!path.endsWith(".name") && !path.endsWith(".greeting") && FORBIDDEN_TEXT.test(value)) {
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
        if (FORBIDDEN_KEY.test(k)) {
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
