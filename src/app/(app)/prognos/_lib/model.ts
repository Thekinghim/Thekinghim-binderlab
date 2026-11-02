/**
 * Sidans vy-modell: PrognosData (från src/server/purchasing) → det komponenterna visar.
 * Bara namn, urval, ordning och text. Alla tal kommer från @/analytics och @/domain; här
 * räknas ingenting nytt utöver summor av redan beräknade tal för visning.
 *
 * Underlagen (PlanEvidence) görs om till EvidenceView här, på servern, så att klienten
 * bara får regeln, talen och länkarna, inte tusentals order-id.
 */

import { approxKr, packs } from "@/analytics/forecast/common";
import type { AccuracyMetrics, ForecastTotal } from "@/analytics/forecast/types";
import type { PurchaseLine, PurchaseLineStatus } from "@/analytics/purchasing/types";
import { daysBetween, dayOfWeek, ratioBp, type IsoDate, type Period } from "@/domain";
import { formatInt, formatPercent, NBSP } from "@/lib/format";
import type {
  PrognosData,
  PurchaseOrderRecord,
  PurchaseOrderStatus,
  SupplierRecord,
} from "@/server/purchasing/types";

import { dateText, periodShort } from "./dates";
import { evidenceView, type EvidenceOptions, type EvidenceView, type NameLookup } from "./evidence";

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

export type Tone = "ok" | "warning" | "critical" | "offline" | "neutral";

export interface Heading {
  readonly title: string;
  readonly aside: string;
}

export interface LostRow {
  readonly key: string;
  readonly titleId: string;
  readonly title: string;
  readonly machine: string;
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly periodText: string;
  /** Slutsålda dagar som kostar, i bp av dag. */
  readonly dayWeightBp: number;
  readonly source: "stock" | "heuristic";
  readonly ongoing: boolean;
  readonly capped: boolean;
  readonly ratePerDayMilli: number;
  readonly rateLowData: boolean;
  readonly lostUnitsMilli: number;
  readonly lostRevenueOre: number;
  readonly lostGrossProfitOre: number | null;
  readonly text: string;
  readonly evidence: EvidenceView;
}

export interface LostModel {
  readonly heading: Heading;
  readonly period: Period;
  readonly periodText: string;
  readonly totalRevenueOre: number;
  readonly totalGrossProfitOre: number;
  readonly totalUnitsMilli: number;
  readonly totalDayWeightBp: number;
  readonly rows: readonly LostRow[];
  readonly months: readonly {
    readonly month: string;
    readonly text: string;
    readonly detail: string;
    readonly lostRevenueOre: number;
    readonly evidence: EvidenceView;
  }[];
  readonly mismatches: number;
  readonly evidence: EvidenceView;
}

export interface WeekValue {
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly unitsMilli: number;
  readonly unitsLowMilli: number;
  readonly unitsHighMilli: number;
  readonly revenueOre: number;
  readonly revenueLowOre: number;
  readonly revenueHighOre: number;
}

export interface ForecastRow {
  readonly key: string;
  readonly name: string;
  /** Andra raden: automat för en serie, antal automater för en titel. */
  readonly sub: string | null;
  readonly weeks: readonly WeekValue[];
  readonly total: WeekValue;
  readonly lowData: boolean;
  readonly explanation: string | null;
  /** Veckodagsfaktorer i bp (mån–sön), för en serie. */
  readonly weekdayFactorsBp: readonly number[] | null;
  readonly text: string;
  readonly evidence: EvidenceView;
}

export interface HistoryPoint {
  readonly start: IsoDate;
  readonly end: IsoDate;
  readonly units: number;
  readonly revenueOre: number;
  /** Backtestens prognos för veckan (summa av serierna), i tusendelar. null = ingen backtest. */
  readonly backtestMilli: number | null;
  /** Backtestens utfall för veckan (dagar med data), i tusendelar. */
  readonly backtestActualMilli: number | null;
}

export interface ForecastModel {
  readonly heading: Heading;
  readonly coverage: string;
  readonly horizon: Period;
  readonly asOf: IsoDate;
  readonly history: readonly HistoryPoint[];
  readonly weeks: readonly WeekValue[];
  readonly total: WeekValue;
  readonly totalText: string;
  /** Prognosen summerad per veckodag (mån–sön) över horisonten. */
  readonly weekdays: readonly {
    readonly weekday: number;
    readonly label: string;
    /** "Lördagarna" */
    readonly plural: string;
    readonly unitsMilli: number;
    readonly revenueOre: number;
  }[];
  readonly byTitle: readonly ForecastRow[];
  readonly byMachine: readonly ForecastRow[];
  readonly bySeries: readonly ForecastRow[];
  readonly lowDataSeries: number;
  readonly ordersWithoutMachine: number;
  readonly evidence: EvidenceView;
}

export interface AccuracyOrigin {
  readonly origin: IsoDate;
  readonly period: Period;
  readonly actualMilli: number;
  readonly forecastMilli: number;
  readonly naiveMilli: number;
  /** (prognos − utfall) / utfall i bp; null när utfallet är 0. */
  readonly errorBp: number | null;
}

export interface AccuracyModel {
  readonly heading: Heading;
  /** Hela meningen från @/analytics (till underlaget). */
  readonly text: string;
  readonly total: AccuracyMetrics;
  readonly series: AccuracyMetrics;
  readonly origins: readonly AccuracyOrigin[];
  /** Varför utfallet här kan vara lägre än veckans försäljning i diagrammet. */
  readonly note: string;
  readonly evidence: EvidenceView;
}

export interface PlanLineView {
  readonly titleId: string;
  readonly title: string;
  readonly status: PurchaseLineStatus;
  readonly statusLabel: string;
  readonly tone: Tone;
  readonly late: boolean;
  readonly supplierId: string | null;
  readonly supplierName: string | null;
  readonly leadTimeDays: number;
  readonly leadTimeSource: PurchaseLine["leadTimeSource"];
  readonly warehouseOnHand: number;
  readonly machineOnHand: number;
  readonly onOrderCounted: number;
  readonly onOrderLater: number;
  readonly demandProtectionMilli: number;
  readonly safetyStockMilli: number;
  readonly targetMilli: number;
  readonly positionPacks: number;
  readonly orderQty: number;
  readonly packSize: number;
  readonly boxes: number;
  readonly minOrderQty: number;
  readonly unitCostOre: number;
  readonly orderValueOre: number;
  readonly expectedArrival: IsoDate;
  readonly coverDays: number | null;
  readonly projectedStockout: IsoDate | null;
  readonly orderBy: IsoDate | null;
  /**
   * Efterfrågan bygger delvis på automater med lite data (under 14 dagar): antal sådana
   * automater av alla och deras andel av prognosen. null = alla automater har nog data.
   */
  readonly lowData: {
    readonly lowDataSeries: number;
    readonly series: number;
    readonly shareBp: number;
  } | null;
  /** Öppna utkast med titeln (räknas inte som beställt). */
  readonly drafts: readonly { readonly number: string; readonly quantity: number }[];
  readonly text: string;
  readonly evidence: EvidenceView;
}

export interface ProposalView {
  readonly supplierId: string;
  readonly supplierName: string;
  readonly totalPacks: number;
  readonly totalOre: number;
  readonly expectedArrival: IsoDate;
  readonly text: string;
  readonly lines: readonly PlanLineView[];
  /** Öppna utkast till leverantören (räknas inte som beställt: beställ eller avbryt dem). */
  readonly drafts: readonly {
    readonly id: string;
    readonly number: string;
    readonly packs: number;
  }[];
  readonly evidence: EvidenceView;
}

export interface PlanModel {
  readonly heading: Heading;
  readonly totalOre: number;
  readonly proposals: readonly ProposalView[];
  readonly lines: readonly PlanLineView[];
  readonly counts: Readonly<Record<PurchaseLineStatus, number>>;
  readonly lateCount: number;
}

export interface PurchaseOrderView {
  readonly id: string;
  readonly number: string;
  readonly supplierId: string;
  readonly supplierName: string;
  readonly status: PurchaseOrderStatus;
  readonly statusLabel: string;
  readonly tone: Tone;
  readonly orderedOn: IsoDate | null;
  readonly expectedOn: IsoDate | null;
  readonly receivedOn: IsoDate | null;
  readonly overdue: boolean;
  /** Utkast som legat längre än `STALE_DRAFT_DAYS` dagar. */
  readonly staleDraft: boolean;
  /** Avslutad med restorder: mottagen men inte allt kom. */
  readonly closedShort: boolean;
  readonly note: string | null;
  readonly createdAt: string;
  readonly totalPacks: number;
  readonly receivedPacks: number;
  readonly totalOre: number;
  readonly lines: readonly {
    readonly id: string;
    readonly titleId: string;
    readonly title: string;
    readonly quantity: number;
    readonly receivedQuantity: number;
    readonly unitCostOre: number;
  }[];
}

export interface PurchaseOrdersModel {
  readonly heading: Heading;
  readonly open: readonly PurchaseOrderView[];
  readonly closed: readonly PurchaseOrderView[];
}

export interface ValuationRow {
  readonly titleId: string;
  readonly title: string;
  readonly warehouseOnHand: number;
  readonly machineOnHand: number;
  readonly onHand: number;
  readonly unitCostOre: number | null;
  readonly costSource: "purchase-price" | "supplier-item" | "none";
  readonly valueOre: number;
  readonly onOrderPacks: number;
  readonly onOrderValueOre: number;
  readonly capitalTiedOre: number;
  readonly shareBp: number | null;
  readonly demandPerDayMilli: number;
  readonly coverDays: number | null;
  readonly negativeStockLocations: number;
  readonly text: string;
  readonly evidence: EvidenceView;
}

export interface ValuationModel {
  readonly heading: Heading;
  readonly valueOre: number;
  readonly warehouseValueOre: number;
  readonly machineValueOre: number;
  readonly onOrderValueOre: number;
  readonly capitalTiedOre: number;
  readonly titlesWithoutCost: readonly string[];
  /** Summorna saknar titlar utan inköpspris. */
  readonly incomplete: boolean;
  readonly rows: readonly ValuationRow[];
  readonly evidence: EvidenceView;
}

export interface SupplierView extends SupplierRecord {
  readonly items: readonly {
    readonly id: string;
    readonly supplierId: string;
    readonly titleId: string;
    readonly title: string;
    readonly packSize: number;
    readonly minOrderQty: number;
    readonly leadTimeDays: number | null;
    readonly unitCostOre: number;
  }[];
  readonly openOrders: number;
}

export interface SuppliersModel {
  readonly heading: Heading;
  readonly suppliers: readonly SupplierView[];
}

export interface PageModel {
  readonly heading: Heading;
  readonly meta: readonly { label: string; value: string }[];
  readonly today: IsoDate;
  readonly asOf: IsoDate;
  readonly canEdit: boolean;
  readonly scoped: boolean;
  readonly hasCentralWarehouse: boolean;
  readonly lost: LostModel;
  readonly forecast: ForecastModel;
  readonly accuracy: AccuracyModel;
  readonly plan: PlanModel;
  readonly orders: PurchaseOrdersModel;
  readonly valuation: ValuationModel;
  readonly suppliers: SuppliersModel;
  readonly titles: readonly { id: string; name: string }[];
}

// ---------------------------------------------------------------------------
// Hjälp
// ---------------------------------------------------------------------------

function lookup(data: PrognosData): NameLookup & { supplier(id: string): string } {
  const titles = new Map(data.titles.map((t) => [t.id, t.name]));
  const machines = new Map(data.machines.map((m) => [m.id, `${m.code} ${m.name}`]));
  const suppliers = new Map(data.suppliers.map((s) => [s.id, s.name]));
  return {
    asOf: data.asOf,
    historyPeriod: data.forecastHistory,
    title: (id) => titles.get(id) ?? "Okänd titel",
    machine: (id) => machines.get(id) ?? "Okänd automat",
    supplier: (id) => suppliers.get(id) ?? "Okänd leverantör",
  };
}

function week(t: ForecastTotal): WeekValue {
  return {
    start: t.period.start,
    end: t.period.end,
    unitsMilli: t.unitsMilli,
    unitsLowMilli: t.unitsLowMilli,
    unitsHighMilli: t.unitsHighMilli,
    revenueOre: t.revenueOre,
    revenueLowOre: t.revenueLowOre,
    revenueHighOre: t.revenueHighOre,
  };
}

/** "16 900–19 900 kr" ur två belopp (analytics avrundning till jämna kronor). */
export function krRangeText(lowOre: number, highOre: number): string {
  const lo = approxKr(lowOre).replace(/^ca\s/, "").replace(/\skr$/, "");
  const hi = approxKr(highOre).replace(/^ca\s/, "");
  return `${lo}–${hi}`;
}

/**
 * En mening som slutar på en förkortning med punkt får ingen extra punkt
 * ("… 1 nov.." → "… 1 nov."). Texterna kommer från @/analytics.
 */
export function tidy(text: string): string {
  return text.replace(/(?<!\.)\.\.(?!\.)/g, ".");
}

const WEEKDAYS = ["Mån", "Tis", "Ons", "Tor", "Fre", "Lör", "Sön"] as const;
const WEEKDAYS_PLURAL = [
  "Måndagarna",
  "Tisdagarna",
  "Onsdagarna",
  "Torsdagarna",
  "Fredagarna",
  "Lördagarna",
  "Söndagarna",
] as const;

function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

const PO_STATUS: Record<PurchaseOrderStatus, { label: string; tone: Tone }> = {
  draft: { label: "Utkast", tone: "neutral" },
  ordered: { label: "Beställd", tone: "ok" },
  partially_received: { label: "Delvis mottagen", tone: "warning" },
  received: { label: "Mottagen", tone: "ok" },
  cancelled: { label: "Avbruten", tone: "offline" },
};

export function purchaseOrderStatusLabel(status: PurchaseOrderStatus): string {
  return PO_STATUS[status].label;
}

function planStatus(line: PurchaseLine): { label: string; tone: Tone } {
  switch (line.status) {
    case "order":
      return line.late ? { label: "Sen", tone: "critical" } : { label: "Beställ", tone: "warning" };
    case "ok":
      return { label: "Räcker", tone: "ok" };
    case "no-supplier":
      return { label: "Leverantör saknas", tone: "warning" };
    case "no-demand":
    default:
      return { label: "Ingen efterfrågan", tone: "neutral" };
  }
}

/** Ett utkast äldre än så här markeras (det räknas inte som beställt och kan vara glömt). */
export const STALE_DRAFT_DAYS = 7;

/** Länken från underlag till avsnittet Inköpsorder. */
const PURCHASE_ORDERS_HREF = "#inkopsorder";
const STOCK_EVIDENCE: EvidenceOptions = {
  centralStock: true,
  historyByTitle: true,
  purchaseOrdersHref: PURCHASE_ORDERS_HREF,
};

/** Kort nummer för en inköpsorder: IO-<första 6 tecknen i id> (id:t är slumpat). */
export function purchaseOrderNumber(id: string): string {
  return `IO‑${id.slice(0, 6).toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Delar
// ---------------------------------------------------------------------------

function lostModel(data: PrognosData, names: NameLookup, now: Date): LostModel {
  const r = data.lostSales;
  const rows: LostRow[] = r.periods.map((p) => ({
    key: p.key,
    titleId: p.titleId,
    title: names.title(p.titleId),
    machine: names.machine(p.machineId),
    start: p.start,
    end: p.end,
    periodText: periodShort({ start: p.start, end: p.end }, now),
    dayWeightBp: p.lostDayWeightBp,
    source: p.source,
    ongoing: p.ongoing,
    capped: p.capped,
    ratePerDayMilli: p.rate.perDayMilli,
    rateLowData: p.rate.lowData,
    lostUnitsMilli: p.lostUnitsMilli,
    lostRevenueOre: p.lostRevenueOre,
    lostGrossProfitOre: p.lostGrossProfitOre,
    text: tidy(p.text),
    evidence: evidenceView(p.evidence, names),
  }));
  const top = [...rows].sort((a, b) => b.lostRevenueOre - a.lostRevenueOre)[0];
  const ongoing = rows.filter((x) => x.ongoing).length;
  let aside: string;
  if (rows.length === 0) aside = "Alla titlar fanns i automaterna enligt lagret och försäljningen.";
  else {
    const parts: string[] = [];
    if (top && top.lostRevenueOre > 0) {
      parts.push(`Störst: ${top.title} i ${top.machine}, ${approxKr(top.lostRevenueOre)}.`);
    }
    if (ongoing > 0) parts.push(`${plural(ongoing, "titel är", "titlar är")} slutsålda nu.`);
    aside = parts.join(" ") || "Kostnaden kan inte räknas: takt eller pris saknas.";
  }
  return {
    heading: { title: tidy(r.total.text), aside: tidy(aside) },
    period: r.period,
    periodText: periodShort(r.period, now),
    totalRevenueOre: r.total.lostRevenueOre,
    totalGrossProfitOre: r.total.lostGrossProfitOre,
    totalUnitsMilli: r.total.lostUnitsMilli,
    totalDayWeightBp: r.total.stockoutDayWeightBp,
    rows,
    months: r.months.map((m) => ({
      month: m.month,
      text: tidy(m.text),
      detail: tidy(m.detail),
      lostRevenueOre: m.lostRevenueOre,
      evidence: evidenceView(m.evidence, names),
    })),
    mismatches: r.mismatches.length,
    evidence: evidenceView(r.total.evidence, names),
  };
}

function forecastModel(
  data: PrognosData,
  names: NameLookup,
): {
  forecast: ForecastModel;
  accuracy: AccuracyModel;
} {
  const f = data.forecast;
  const coverage = "80 %";
  const series = new Map(f.series.map((s) => [s.key, s]));

  const bySeries: ForecastRow[] = f.series
    .map((s) => ({
      key: s.key,
      name: names.title(s.titleId),
      sub: names.machine(s.machineId),
      weeks: s.weeks.map(week),
      total: week(s.total),
      lowData: s.status === "low-data",
      explanation: s.explanation,
      weekdayFactorsBp: s.components.weekdayFactorsBp,
      text: tidy(s.text),
      evidence: evidenceView(s.evidence, names),
    }))
    .sort((a, b) => b.total.revenueOre - a.total.revenueOre || (a.key < b.key ? -1 : 1));

  const byTitle: ForecastRow[] = f.byTitle.map((a) => ({
    key: a.key,
    name: names.title(a.key),
    sub: plural(a.seriesKeys.length, "automat", "automater"),
    weeks: a.weeks.map(week),
    total: week(a.total),
    lowData: a.seriesKeys.every((k) => series.get(k)?.status === "low-data"),
    explanation: null,
    weekdayFactorsBp: null,
    text: tidy(a.text),
    evidence: evidenceView(a.evidence, names),
  }));
  const byMachine: ForecastRow[] = f.byMachine.map((a) => ({
    key: a.key,
    name: names.machine(a.key),
    sub: plural(a.seriesKeys.length, "titel", "titlar"),
    weeks: a.weeks.map(week),
    total: week(a.total),
    lowData: a.seriesKeys.every((k) => series.get(k)?.status === "low-data"),
    explanation: null,
    weekdayFactorsBp: null,
    text: tidy(a.text),
    evidence: evidenceView(a.evidence, names),
  }));

  // Backtest per vecka: summan av seriernas ursprung (samma veckor som historiken).
  const byOrigin = new Map<IsoDate, { period: Period; a: number; f: number; n: number }>();
  for (const b of f.backtests) {
    for (const o of b.origins) {
      const cur = byOrigin.get(o.origin) ?? { period: o.period, a: 0, f: 0, n: 0 };
      cur.a += o.actualMilli;
      cur.f += o.forecastMilli;
      cur.n += o.naiveMilli;
      byOrigin.set(o.origin, cur);
    }
  }
  const origins: AccuracyOrigin[] = [...byOrigin.entries()]
    .sort(([x], [y]) => (x < y ? -1 : 1))
    .map(([origin, v]) => ({
      origin,
      period: v.period,
      actualMilli: v.a,
      forecastMilli: v.f,
      naiveMilli: v.n,
      errorBp: v.a > 0 ? ratioBp(v.f - v.a, v.a) : null,
    }));
  const originByEnd = new Map(origins.map((o) => [o.period.end, o]));

  // Veckor före första försäljningen visas inte (de är inte utfall 0, de saknar data).
  const firstWithData = data.history.findIndex((h) => h.units > 0);
  const shown = firstWithData < 0 ? data.history.slice(-1) : data.history.slice(firstWithData);
  const history: HistoryPoint[] = shown.map((h) => {
    const bt = originByEnd.get(h.period.end);
    return {
      start: h.period.start,
      end: h.period.end,
      units: h.units,
      revenueOre: h.revenueOre,
      backtestMilli: bt ? bt.forecastMilli : null,
      backtestActualMilli: bt ? bt.actualMilli : null,
    };
  });

  const total = week(f.total.total);
  const lowDataSeries = f.series.filter((s) => s.status === "low-data").length;
  const title =
    f.series.length === 0
      ? "Ingen prognos ännu."
      : `${approxKr(total.revenueOre).replace(/^ca/, "Ca")} och ca ${packs(total.unitsMilli)} pack kommande 4 veckor.`;
  const asideParts: string[] = [];
  if (f.series.length > 0) {
    asideParts.push(
      `${coverage}-intervall ${krRangeText(total.revenueLowOre, total.revenueHighOre)}.`,
    );
    const first = byTitle[0];
    if (first) asideParts.push(`Störst: ${first.name}, ${approxKr(first.total.revenueOre)}.`);
  } else {
    asideParts.push("Ingen titel har sålt i någon automat i drift de senaste 8 veckorna.");
  }

  const acc = f.accuracy;
  return {
    forecast: {
      heading: { title, aside: asideParts.join(" ") },
      coverage,
      horizon: f.horizon,
      asOf: f.asOf,
      history,
      weeks: f.total.weeks.map(week),
      total,
      totalText: tidy(f.total.text),
      weekdays: WEEKDAYS.map((label, i) => {
        const days = f.total.days.filter((d) => dayOfWeek(d.date) === i + 1);
        return {
          weekday: i + 1,
          label,
          plural: WEEKDAYS_PLURAL[i]!,
          unitsMilli: days.reduce((sum, d) => sum + d.unitsMilli, 0),
          revenueOre: days.reduce((sum, d) => sum + d.revenueOre, 0),
        };
      }),
      byTitle,
      byMachine,
      bySeries,
      lowDataSeries,
      ordersWithoutMachine: f.ordersWithoutMachine,
      evidence: evidenceView(f.total.evidence, names),
    },
    accuracy: {
      heading: {
        title:
          acc.total.wapeBp === null
            ? "Träffsäkerheten går inte att mäta än."
            : `Prognosen missade i snitt ${formatPercent(acc.total.wapeBp / 10_000, 0)} per dag.`,
        aside: accuracyAside(acc.total, origins.length, tidy(acc.text)),
      },
      text: tidy(acc.text),
      total: acc.total,
      series: acc.series,
      origins,
      note: ACCURACY_NOTE,
      evidence: (() => {
        const ev = evidenceView(acc.evidence, names);
        return { ...ev, rule: `${ev.rule} ${ACCURACY_NOTE}` };
      })(),
    },
  };
}

const ACCURACY_NOTE =
  "Utfallet i testen gäller de serier (titel × automat) som fanns när testveckan började, på dagar då titeln gick att köpa. " +
  "Nya serier och slutsålda dagar testas inte, så utfallet kan vara lägre än veckans försäljning i diagrammet.";

/** Andra delen av rubriken för träffsäkerheten: antal veckor, bias och den enkla jämförelsen. */
function accuracyAside(m: AccuracyMetrics, weeks: number, fallback: string): string {
  if (m.wapeBp === null) return fallback;
  const parts: string[] = [`Mätt på ${plural(weeks, "vecka", "veckor")} som modellen inte sett.`];
  const bias = m.biasBp ?? 0;
  parts.push(
    Math.abs(bias) < 50
      ? "Ingen systematisk avvikelse."
      : `Den låg ${formatPercent(Math.abs(bias) / 10_000, 0)} för ${bias > 0 ? "högt" : "lågt"}.`,
  );
  if (m.naiveWapeBp !== null) {
    parts.push(`Förra veckans snitt hade missat ${formatPercent(m.naiveWapeBp / 10_000, 0)}.`);
  }
  return parts.join(" ");
}

function planModel(data: PrognosData, names: ReturnType<typeof lookup>): PlanModel {
  const p = data.plan;
  const basis = new Map(data.demandBasis.map((b) => [b.titleId, b]));
  // Öppna utkast per titel och per leverantör (räknas inte som beställt i planen).
  const draftOrders = data.purchaseOrders.filter((po) => po.status === "draft");
  const draftsByTitle = new Map<string, { number: string; quantity: number }[]>();
  for (const po of draftOrders) {
    for (const l of po.lines) {
      const list = draftsByTitle.get(l.titleId) ?? [];
      list.push({ number: purchaseOrderNumber(po.id), quantity: l.quantity });
      draftsByTitle.set(l.titleId, list);
    }
  }
  const lineView = (l: PurchaseLine): PlanLineView => {
    const st = planStatus(l);
    const b = basis.get(l.titleId);
    const lowData =
      b && b.lowDataSeries > 0
        ? {
            lowDataSeries: b.lowDataSeries,
            series: b.series,
            shareBp: ratioBp(b.lowDataUnitsMilli, b.unitsMilli) ?? 0,
          }
        : null;
    const ev = evidenceView(l.evidence, names, STOCK_EVIDENCE);
    const extra: { key: string; label: string; value: string }[] = [];
    if (lowData) {
      extra.push({
        key: "lowDataSeries",
        label: "Automater med lite data (under 14 dagar)",
        value: `${formatInt(lowData.lowDataSeries)} av ${formatInt(lowData.series)}, ${formatPercent(lowData.shareBp / 10_000, 0)} av prognosen`,
      });
    }
    const drafts = draftsByTitle.get(l.titleId) ?? [];
    if (drafts.length > 0) {
      extra.push({
        key: "draftPacks",
        label: "I utkast (räknas inte som beställt)",
        value: `${formatInt(drafts.reduce((sum, d) => sum + d.quantity, 0))}${NBSP}pack`,
      });
    }
    return {
      titleId: l.titleId,
      title: names.title(l.titleId),
      status: l.status,
      statusLabel: st.label,
      tone: st.tone,
      late: l.late,
      supplierId: l.supplierId,
      supplierName: l.supplierId ? names.supplier(l.supplierId) : null,
      leadTimeDays: l.leadTimeDays,
      leadTimeSource: l.leadTimeSource,
      warehouseOnHand: l.warehouseOnHand,
      machineOnHand: l.machineOnHand,
      onOrderCounted: l.onOrderCounted,
      onOrderLater: l.onOrderLater,
      demandProtectionMilli: l.demandProtectionMilli,
      safetyStockMilli: l.safetyStockMilli,
      targetMilli: l.targetMilli,
      positionPacks: l.positionPacks,
      orderQty: l.orderQty,
      packSize: l.packSize,
      boxes: l.boxes,
      minOrderQty: l.minOrderQty,
      unitCostOre: l.unitCostOre,
      orderValueOre: l.orderValueOre,
      expectedArrival: l.expectedArrival,
      coverDays: l.coverDays,
      projectedStockout: l.projectedStockout,
      orderBy: l.orderBy,
      lowData,
      drafts,
      text: tidy(l.text),
      evidence: extra.length > 0 ? { ...ev, figures: [...ev.figures, ...extra] } : ev,
    };
  };
  const lines = p.lines.map(lineView);
  const counts: Record<PurchaseLineStatus, number> = {
    order: 0,
    ok: 0,
    "no-supplier": 0,
    "no-demand": 0,
  };
  for (const l of p.lines) counts[l.status] += 1;
  const lateCount = p.lines.filter((l) => l.status === "order" && l.late).length;
  const proposals: ProposalView[] = p.orders.map((o) => ({
    supplierId: o.supplierId,
    supplierName: names.supplier(o.supplierId),
    totalPacks: o.totalPacks,
    totalOre: o.totalOre,
    expectedArrival: o.expectedArrival,
    text: tidy(o.text),
    lines: o.lines.map(lineView),
    drafts: draftOrders
      .filter((po) => po.supplierId === o.supplierId)
      .map((po) => ({
        id: po.id,
        number: purchaseOrderNumber(po.id),
        packs: po.lines.reduce((sum, l) => sum + l.quantity, 0),
      })),
    evidence: evidenceView(o.evidence, names, STOCK_EVIDENCE),
  }));

  let title: string;
  if (counts.order > 0) {
    title = `${plural(counts.order, "titel", "titlar")} att beställa för ${approxKr(p.totalOre)}.`;
  } else if (counts["no-supplier"] > 0) {
    title = `${plural(counts["no-supplier"], "titel behöver", "titlar behöver")} beställas men saknar leverantör.`;
  } else if (lines.length === 0) {
    title = "Inget att planera ännu.";
  } else {
    title = "Lagret räcker till nästa beställningstillfälle.";
  }
  const asideParts: string[] = [];
  if (lateCount > 0) {
    asideParts.push(
      `${plural(lateCount, "titel", "titlar")} hinner ta slut innan leveransen även om du beställer i dag.`,
    );
  }
  if (counts.order > 0 && counts["no-supplier"] > 0) {
    asideParts.push(`${plural(counts["no-supplier"], "titel", "titlar")} till saknar leverantör.`);
  }
  const lowDataOrder = lines.filter((l) => l.status === "order" && l.lowData).length;
  if (lowDataOrder > 0) {
    asideParts.push(
      `${plural(lowDataOrder, "förslag bygger", "förslag bygger")} delvis på automater med lite data: kontrollera antalet.`,
    );
  }
  const draftTitles = lines.filter((l) => l.status === "order" && l.drafts.length > 0).length;
  if (draftTitles > 0) {
    asideParts.push(
      `${plural(draftTitles, "titel", "titlar")} finns redan i ett utkast som inte är beställt.`,
    );
  }
  if (asideParts.length === 0) {
    if (counts.order === 0 && counts["no-supplier"] > 0) {
      asideParts.push(
        `Lägg upp leverantör och artikel för dem; ${plural(counts.ok, "titel räcker", "titlar räcker")} till nästa beställningstillfälle.`,
      );
    } else asideParts.push(tidy(p.text));
  }

  return {
    heading: { title, aside: asideParts.join(" ") },
    totalOre: p.totalOre,
    proposals,
    lines,
    counts,
    lateCount,
  };
}

function orderView(
  po: PurchaseOrderRecord,
  names: ReturnType<typeof lookup>,
  today: IsoDate,
): PurchaseOrderView {
  const st = PO_STATUS[po.status];
  const open = po.status === "ordered" || po.status === "partially_received";
  const overdue = open && po.expectedOn !== null && po.expectedOn < today;
  const totalPacks = po.lines.reduce((s, l) => s + l.quantity, 0);
  const receivedPacks = po.lines.reduce((s, l) => s + l.receivedQuantity, 0);
  const closedShort = po.status === "received" && receivedPacks < totalPacks;
  const created = po.createdAt.slice(0, 10);
  const staleDraft =
    po.status === "draft" &&
    /^\d{4}-\d{2}-\d{2}$/.test(created) &&
    daysBetween(created, today) > STALE_DRAFT_DAYS;
  const label = overdue
    ? { label: "Försenad", tone: "warning" as Tone }
    : closedShort
      ? { label: "Avslutad med restorder", tone: "offline" as Tone }
      : staleDraft
        ? { label: "Gammalt utkast", tone: "warning" as Tone }
        : st;
  return {
    id: po.id,
    number: purchaseOrderNumber(po.id),
    supplierId: po.supplierId,
    supplierName: names.supplier(po.supplierId),
    status: po.status,
    statusLabel: label.label,
    tone: label.tone,
    orderedOn: po.orderedOn,
    expectedOn: po.expectedOn,
    receivedOn: po.receivedOn,
    overdue,
    staleDraft,
    closedShort,
    note: po.note,
    createdAt: po.createdAt,
    totalPacks,
    receivedPacks,
    totalOre: po.lines.reduce((s, l) => s + l.quantity * l.unitCostOre, 0),
    lines: po.lines.map((l) => ({
      id: l.id,
      titleId: l.titleId,
      title: names.title(l.titleId),
      quantity: l.quantity,
      receivedQuantity: l.receivedQuantity,
      unitCostOre: l.unitCostOre,
    })),
  };
}

function ordersModel(
  data: PrognosData,
  names: ReturnType<typeof lookup>,
  now: Date,
): PurchaseOrdersModel {
  const views = data.purchaseOrders.map((po) => orderView(po, names, data.today));
  const isOpen = (v: PurchaseOrderView) =>
    v.status === "draft" || v.status === "ordered" || v.status === "partially_received";
  const open = views.filter(isOpen);
  const closed = views.filter((v) => !isOpen(v));
  const overdue = open.filter((v) => v.overdue).length;
  const drafts = open.filter((v) => v.status === "draft").length;
  const next = open
    .filter((v) => v.expectedOn !== null && v.status !== "draft")
    .sort((a, b) => (a.expectedOn! < b.expectedOn! ? -1 : 1))[0];
  let title: string;
  if (open.length === 0)
    title = views.length === 0 ? "Inga inköpsorder ännu." : "Inga öppna inköpsorder.";
  else title = `${plural(open.length, "öppen inköpsorder", "öppna inköpsorder")}.`;
  const parts: string[] = [];
  if (overdue > 0) parts.push(`${plural(overdue, "är försenad", "är försenade")}.`);
  const stale = open.filter((v) => v.staleDraft).length;
  if (drafts > 0) {
    parts.push(
      `${plural(drafts, "utkast", "utkast")} väntar på att beställas och räknas inte som beställt${stale > 0 ? ` (${formatInt(stale)} äldre än ${STALE_DRAFT_DAYS} dagar)` : ""}.`,
    );
  }
  if (next?.expectedOn)
    parts.push(
      `Nästa leverans väntas ${dateText(next.expectedOn, now)} från ${next.supplierName}.`,
    );
  if (parts.length === 0) {
    parts.push(
      views.length === 0
        ? "Skapa en från förslaget ovan eller manuellt."
        : "Mottagna leveranser syns i lagret som inleverans.",
    );
  }
  return { heading: { title, aside: parts.join(" ") }, open, closed };
}

function valuationModel(data: PrognosData, names: NameLookup): ValuationModel {
  const v = data.valuation;
  const rows: ValuationRow[] = v.titles.map((t) => ({
    titleId: t.titleId,
    title: names.title(t.titleId),
    warehouseOnHand: t.warehouseOnHand,
    machineOnHand: t.machineOnHand,
    onHand: t.onHand,
    unitCostOre: t.unitCostOre,
    costSource: t.costSource,
    valueOre: t.valueOre,
    onOrderPacks: t.onOrderPacks,
    onOrderValueOre: t.onOrderValueOre,
    capitalTiedOre: t.capitalTiedOre,
    shareBp: t.shareBp,
    demandPerDayMilli: t.demandPerDayMilli,
    coverDays: t.coverDays,
    negativeStockLocations: t.negativeStockLocations,
    text: tidy(t.text),
    evidence: evidenceView(t.evidence, names, STOCK_EVIDENCE),
  }));
  const incomplete = v.titlesWithoutCost.length > 0;
  const title =
    v.capitalTiedOre === 0 && rows.length === 0
      ? "Inget lager registrerat."
      : incomplete
        ? `Kapitalbindning minst ${approxKr(v.capitalTiedOre).replace(/^ca\s/, "ca ")}.`
        : `Kapitalbindning ${approxKr(v.capitalTiedOre)}.`;
  const parts = [
    `Lagervärde ${approxKr(v.valueOre)} (centrallager ${approxKr(v.warehouseValueOre)}, automater ${approxKr(v.machineValueOre)}), beställt ${approxKr(v.onOrderValueOre)}.`,
  ];
  if (incomplete) {
    parts.push(
      `Summorna är ofullständiga: ${plural(v.titlesWithoutCost.length, "titel", "titlar")} saknar inköpspris och räknas inte.`,
    );
  }
  return {
    heading: { title, aside: parts.join(" ") },
    valueOre: v.valueOre,
    warehouseValueOre: v.warehouseValueOre,
    machineValueOre: v.machineValueOre,
    onOrderValueOre: v.onOrderValueOre,
    capitalTiedOre: v.capitalTiedOre,
    titlesWithoutCost: v.titlesWithoutCost.map((id) => names.title(id)),
    incomplete,
    rows,
    evidence: evidenceView(v.evidence, names, STOCK_EVIDENCE),
  };
}

function suppliersModel(data: PrognosData, names: NameLookup): SuppliersModel {
  const open = new Map<string, number>();
  for (const po of data.purchaseOrders) {
    if (po.status === "draft" || po.status === "ordered" || po.status === "partially_received") {
      open.set(po.supplierId, (open.get(po.supplierId) ?? 0) + 1);
    }
  }
  const suppliers: SupplierView[] = data.suppliers.map((s) => ({
    ...s,
    items: data.supplierItems
      .filter((i) => i.supplierId === s.id)
      .map((i) => ({ ...i, title: names.title(i.titleId) }))
      .sort((a, b) => a.title.localeCompare(b.title, "sv")),
    openOrders: open.get(s.id) ?? 0,
  }));
  const active = suppliers.filter((s) => !s.archived);
  const covered = new Set(
    data.supplierItems
      .filter((i) => active.some((s) => s.id === i.supplierId))
      .map((i) => i.titleId),
  );
  const withDemand = data.plan.lines.filter((l) => l.status !== "no-demand").map((l) => l.titleId);
  const missing = withDemand.filter((id) => !covered.has(id)).length;
  const title =
    active.length === 0
      ? "Ingen leverantör ännu."
      : `${plural(active.length, "leverantör", "leverantörer")}, ${plural(covered.size, "titel", "titlar")} med artikel.`;
  const aside =
    active.length === 0
      ? "Lägg till leverantörer och vilka titlar de säljer, så kan inköpen föreslås."
      : missing > 0
        ? `${plural(missing, "titel", "titlar")} som säljer saknar leverantör.`
        : "Alla titlar som säljer har en leverantör.";
  return { heading: { title, aside }, suppliers };
}

// ---------------------------------------------------------------------------
// Sidan
// ---------------------------------------------------------------------------

/** Vy-modellen för sidan. `now` styr bara datumtexter (år utelämnas för innevarande år). */
export function buildPageModel(data: PrognosData, now: Date = new Date()): PageModel {
  const names = lookup(data);
  const lost = lostModel(data, names, now);
  const { forecast, accuracy } = forecastModel(data, names);
  const plan = planModel(data, names);
  const orders = ordersModel(data, names, now);
  const valuation = valuationModel(data, names);
  const suppliers = suppliersModel(data, names);

  const answerParts: string[] = [
    `${forecast.coverage}-intervall ${krRangeText(forecast.total.revenueLowOre, forecast.total.revenueHighOre)}.`,
  ];
  if (data.lostSales.total.lostRevenueOre > 0) {
    answerParts.push(
      `Slutsålt kostade ${approxKr(data.lostSales.total.lostRevenueOre)} ${periodShort(data.lostSales.period, now)}.`,
    );
  }
  const scoped = Boolean(data.scope.storeId || data.scope.machineId);
  // Inköpen gäller alltid hela organisationen (centrallagret är gemensamt).
  const orgNote = scoped ? " i hela organisationen" : "";
  if (plan.counts.order > 0) {
    answerParts.push(
      `${plural(plan.counts.order, "titel", "titlar")}${orgNote} bör beställas för ${approxKr(plan.totalOre)}.`,
    );
  } else if (plan.counts["no-supplier"] > 0) {
    answerParts.push(
      `${plural(plan.counts["no-supplier"], "titel", "titlar")}${orgNote} behöver en leverantör.`,
    );
  }

  return {
    heading: {
      title:
        data.forecast.series.length === 0
          ? "Ingen prognos ännu."
          : `${approxKr(forecast.total.revenueOre).replace(/^ca/, "Ca")} kommande 4 veckor.`,
      // tidy: periodtexten kan sluta på en förkortning ("sep."), så att meningen annars får "..".
      aside:
        data.forecast.series.length === 0 ? forecast.heading.aside : tidy(answerParts.join(" ")),
    },
    meta: [
      { label: "Prognos", value: periodShort(forecast.horizon, now) },
      {
        label: "Träffsäkerhet",
        value:
          accuracy.total.wapeBp === null
            ? "–"
            : `${formatPercent(accuracy.total.wapeBp / 10_000, 0)} fel/dag`,
      },
      {
        label: "Att beställa",
        value:
          plan.counts.order > 0
            ? approxKr(plan.totalOre)
            : plan.counts["no-supplier"] > 0
              ? `${plural(plan.counts["no-supplier"], "titel", "titlar")} utan leverantör`
              : "Inget",
      },
      {
        label: "Kapitalbindning",
        value: `${valuation.incomplete ? "minst " : ""}${approxKr(valuation.capitalTiedOre)}`,
      },
    ],
    today: data.today,
    asOf: data.asOf,
    canEdit: data.canEdit,
    scoped,
    hasCentralWarehouse: data.hasCentralWarehouse,
    lost,
    forecast,
    accuracy,
    plan,
    orders,
    valuation,
    suppliers,
    titles: [...data.titles].sort((a, b) => a.name.localeCompare(b.name, "sv")),
  };
}
