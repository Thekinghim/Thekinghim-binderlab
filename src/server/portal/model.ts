/**
 * Butiksportalens modell: ren logik utan databas och utan Next.
 *
 * Indata är exakt det som portal_*-funktionerna i databasen lämnar ut (butikens
 * försäljning per dag/automat/titel/belopp, butikens avtal och automaternas
 * placeringar i butiken). Inga inköpspriser finns här, och de behövs inte:
 * butikens siffror (försäljning, veckor, topptitlar, ersättning) räknas med
 * `buildStoreReport` i `@/reports`, samma kod som månadsrapporten till butiken,
 * och `assertStoreReportSafe` kontrollerar varje rapport innan den lämnar modellen.
 *
 * Allt som returneras är serialiserbart (tal och strängar) så att det kan
 * skickas till klientkomponenter.
 */

import {
  addMonths,
  compareDates,
  intersectPeriods,
  monthOf,
  monthPeriod,
  periodDays,
  type CommissionBase,
  type IsoDate,
  type IsoMonth,
  type LossTreatment,
  type OrderLine,
  type Period,
} from "@/domain";
import {
  assertStoreReportSafe,
  buildStoreReport,
  type CompensationStep,
  type Evidence,
  type ReportSources,
  type StoreReport,
} from "@/reports";

// ---------------------------------------------------------------------------
// Rader från databasen (portal_*-funktionerna)
// ---------------------------------------------------------------------------

/** En butik där användaren är butiksanvändare (portal_stores). */
export interface PortalStore {
  readonly storeId: string;
  readonly storeName: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly timezone: string;
  readonly vatRateBp: number;
}

/** Försäljning en dag på en automat, för en titel och ett belopp (portal_sales). */
export interface PortalSaleRow {
  readonly businessDate: IsoDate;
  readonly machineId: string | null;
  /** null när ordern ännu inte är kopplad till en titel; då bär titleName källans namn. */
  readonly titleId: string | null;
  readonly titleName: string;
  /** Belopp per order, inklusive eventuell moms, i öre. */
  readonly amountOre: number;
  readonly orderCount: number;
}

/** Butikens avtalsvillkor (portal_agreements). */
export interface PortalAgreementRow {
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
  readonly commissionBp: number | null;
  readonly monthlyRentOre: number | null;
  /** Saknas i äldre rader (före vinstdelning): 'net_excl_vat'. */
  readonly commissionBase?: CommissionBase;
  readonly lossTreatment?: LossTreatment;
  /** Saknas i äldre rader: sant (VMB dras före delningen). */
  readonly vmbBeforeSplit?: boolean;
}

/** En period då en automat stod i butiken (portal_machines). */
export interface PortalMachineRow {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly placedFrom: IsoDate;
  readonly placedTo: IsoDate | null;
}

// ---------------------------------------------------------------------------
// Källor till rapportberäkningen
// ---------------------------------------------------------------------------

/** Titel-id för order utan koppling till en titel: källans namn blir titeln. */
export function unmappedTitleId(name: string): string {
  return `okand:${name}`;
}

/**
 * Bygger rapportkällorna för butiken ur portalens rader. Varje rad blir
 * `orderCount` order med samma belopp (provisionen avrundas per order, så
 * uppdelningen ger exakt samma ersättning som orderna en och en).
 */
export function portalSources(
  store: Pick<PortalStore, "storeId" | "storeName" | "vatRateBp">,
  sales: readonly PortalSaleRow[],
  agreements: readonly PortalAgreementRow[],
  machines: readonly PortalMachineRow[],
): ReportSources {
  const orders: OrderLine[] = [];
  const titles = new Map<string, string>();
  sales.forEach((row, rowIndex) => {
    const titleId = row.titleId ?? unmappedTitleId(row.titleName);
    if (!titles.has(titleId)) titles.set(titleId, row.titleName);
    for (let i = 0; i < row.orderCount; i++) {
      orders.push({
        id: `${row.businessDate}:${rowIndex}:${i}`,
        externalId: "",
        titleId,
        machineId: row.machineId,
        businessDate: row.businessDate,
        amountOre: row.amountOre,
      });
    }
  });
  const machineNames = new Map<string, { code: string; name: string }>();
  for (const m of machines) machineNames.set(m.machineId, { code: m.code, name: m.name });

  return {
    orders,
    prices: [],
    agreements: agreements.map((a) => ({
      storeId: store.storeId,
      validFrom: a.validFrom,
      validTo: a.validTo,
      commissionBp: a.commissionBp,
      monthlyRentOre: a.monthlyRentOre,
      ...(a.commissionBase ? { commissionBase: a.commissionBase } : {}),
      ...(a.lossTreatment ? { lossTreatment: a.lossTreatment } : {}),
      ...(a.vmbBeforeSplit === true ? { vmbBeforeSplit: true } : {}),
    })),
    placements: machines.map((m) => ({
      machineId: m.machineId,
      storeId: store.storeId,
      from: m.placedFrom,
      to: m.placedTo,
    })),
    // Kortavgiften är operatörens kostnad och påverkar inte butikens ersättning.
    settings: { vatRateBp: store.vatRateBp, cardFeeBp: 0 },
    stores: [{ id: store.storeId, name: store.storeName }],
    machines: [...machineNames].map(([id, m]) => ({ id, name: m.name, code: m.code })),
    titles: [...titles].map(([id, name]) => ({ id, name })),
  };
}

// ---------------------------------------------------------------------------
// Månader
// ---------------------------------------------------------------------------

/** Dagens datum i tidszonen ('ÅÅÅÅ-MM-DD'). */
export function todayIn(timeZone: string, now: Date = new Date()): IsoDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}` as IsoDate;
}

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Första månaden butiken har något att visa: första placering eller första försäljning. */
export function firstPortalMonth(
  machines: readonly PortalMachineRow[],
  firstSale: IsoDate | null,
  today: IsoDate,
): IsoMonth {
  let first: IsoDate = today;
  for (const m of machines) if (compareDates(m.placedFrom, first) < 0) first = m.placedFrom;
  if (firstSale && compareDates(firstSale, first) < 0) first = firstSale;
  return monthOf(first);
}

/** Vald månad ur ?manad=ÅÅÅÅ-MM, begränsad till [första, innevarande]. Standard: innevarande. */
export function resolvePortalMonth(
  requested: string | undefined,
  first: IsoMonth,
  current: IsoMonth,
): IsoMonth {
  // Utan val: den senaste hela månaden (som månadsrapporten), inte den som pågår, utom när
  // butiken bara har den pågående månaden.
  const lastFull = addMonths(current, -1);
  const fallback = lastFull >= first ? lastFull : current;
  if (!requested || !MONTH_RE.test(requested)) return fallback;
  const m = requested as IsoMonth;
  if (m > current) return current;
  if (m < first) return first;
  return m;
}

/** Månaderna från `first` till `last`, senaste först. */
export function monthsBetween(first: IsoMonth, last: IsoMonth): IsoMonth[] {
  const out: IsoMonth[] = [];
  for (let m = last; m >= first; m = addMonths(m, -1)) out.push(m);
  return out;
}

// ---------------------------------------------------------------------------
// Översikten
// ---------------------------------------------------------------------------

/** Underlaget till en siffra, serialiserbart (samma form som rapporternas Evidence). */
export type PortalEvidence = Evidence;

/** En månad i trenden. */
export interface PortalTrendMonth {
  readonly month: IsoMonth;
  readonly revenueOre: number;
  readonly orders: number;
  readonly compensationOre: number;
  /**
   * Sant när ersättningen bygger på vinstdelning: portalen ser inga inköpspriser, så
   * andelen står i månadsrapporten och `compensationOre` är bara hyra/provision.
   */
  readonly compensationPending: boolean;
  /** Sant för innevarande månad (inte slut än). */
  readonly partial: boolean;
}

/** Butikens översikt för en månad. */
export interface PortalOverview {
  readonly month: IsoMonth;
  readonly period: Period;
  /** Sant när månaden pågår: siffrorna gäller till och med i dag. */
  readonly partial: boolean;
  readonly today: IsoDate;
  readonly report: StoreReport;
  /** Upp till tolv månader bakåt, äldst först. */
  readonly trend: readonly PortalTrendMonth[];
  /** Summa för trendens hela månader (utan pågående månad). */
  readonly trendTotals: { months: number; revenueOre: number; compensationOre: number };
  /**
   * Dagar automaten hittills stått i butiken i månaden (till och med i dag), per
   * automat. För en hel månad samma som rapportens `placedDays`; för pågående
   * månad räknas inte dagarna efter i dag.
   */
  readonly placedDaysSoFar: Readonly<Record<string, number>>;
}

/**
 * Bygger översikten för månaden. Trenden räknar varje månad med samma
 * rapportberäkning, så att varje stapel stämmer med månadens rapport.
 */
export function buildPortalOverview(
  sources: ReportSources,
  storeId: string,
  month: IsoMonth,
  first: IsoMonth,
  today: IsoDate,
  options: {
    /** Butikens val "Visa detaljer i rapporten". Standard falskt: inga titlar. */
    readonly details?: boolean;
  } = {},
): PortalOverview {
  // Portalen ser inga inköpspriser: en vinstandel visas som "i månadsrapporten".
  const report = buildStoreReport(sources, storeId, month, {
    topTitles: 8,
    pendingSplit: true,
    details: options.details === true,
  });
  assertStoreReportSafe(report);
  const current = monthOf(today);
  const trendStart = maxMonth(first, addMonths(month, -11));
  const trend: PortalTrendMonth[] = monthsBetween(trendStart, month)
    .reverse()
    .map((m) => {
      const r =
        m === month
          ? report
          : buildStoreReport(sources, storeId, m, { topTitles: 0, pendingSplit: true });
      return {
        month: m,
        revenueOre: r.sales.revenueOre,
        orders: r.sales.orders,
        compensationOre: r.compensation.totalOre,
        compensationPending: r.compensation.pending,
        partial: m === current,
      };
    });
  const complete = trend.filter((t) => !t.partial);
  const partial = month === current;
  const period = monthPeriod(month);
  const placedDaysSoFar: Record<string, number> = {};
  for (const m of report.machines) {
    if (!partial) {
      placedDaysSoFar[m.machineId] = m.placedDays;
      continue;
    }
    const soFar = { start: period.start, end: today };
    let days = 0;
    for (const p of sources.placements) {
      if (p.machineId !== m.machineId || p.storeId !== storeId) continue;
      const overlap = intersectPeriods(soFar, { start: p.from, end: p.to ?? today });
      if (overlap) days += periodDays(overlap);
    }
    placedDaysSoFar[m.machineId] = days;
  }
  return {
    month,
    period,
    partial,
    today,
    report,
    trend,
    trendTotals: {
      months: complete.length,
      revenueOre: complete.reduce((s, t) => s + t.revenueOre, 0),
      compensationOre: complete.reduce((s, t) => s + t.compensationOre, 0),
    },
    placedDaysSoFar,
  };
}

function maxMonth(a: IsoMonth, b: IsoMonth): IsoMonth {
  return a > b ? a : b;
}

/** Ersättningens steg som ska visas (steg med 0 kr utan order döljs inte: de förklarar underlaget). */
export function visibleSteps(steps: readonly CompensationStep[]): CompensationStep[] {
  return steps.filter((s) => s.kind !== "total");
}

/** Hämtningsfönstret: från elva månader före vald månad (minst första) till vald månads slut. */
export function salesWindow(month: IsoMonth, first: IsoMonth): Period {
  // En extra månad före trenden: rapporten jämför med förra månaden.
  const start = maxMonth(first, addMonths(month, -12));
  return { start: monthPeriod(start).start, end: monthPeriod(month).end };
}

/** Automater som står i butiken i dag (de som kan felanmälas). */
export function machinesInStoreToday(
  machines: readonly PortalMachineRow[],
  today: IsoDate,
): { machineId: string; code: string; name: string }[] {
  const out = new Map<string, { machineId: string; code: string; name: string }>();
  for (const m of machines) {
    if (
      compareDates(m.placedFrom, today) <= 0 &&
      (!m.placedTo || compareDates(m.placedTo, today) >= 0)
    ) {
      out.set(m.machineId, { machineId: m.machineId, code: m.code, name: m.name });
    }
  }
  return [...out.values()].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}
