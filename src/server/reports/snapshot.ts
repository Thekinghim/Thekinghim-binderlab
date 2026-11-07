/**
 * Rapportens ögonblicksbild (reports.data_snapshot): allt som PDF, e-post, Excel och SIE
 * renderas från. Byggs EN gång när rapporten skapas, med rapportunderlagen i @/reports,
 * och ändras aldrig. Därför kan en skickad rapport alltid visas exakt som den skickades,
 * även om order, priser eller avtal ändras senare (docs/datamodell.md, avsnitt 9).
 *
 * Ren modul utan I/O: indata laddas i ./sources.ts.
 */

import { stockLevels, type StockEventRef } from "@/analytics/lost-sales/stock";
import {
  addMonths,
  CALC_VERSION,
  DomainError,
  monthEnd,
  monthOf,
  monthPeriod,
  parseIsoMonth,
  type IsoDate,
  type IsoMonth,
  type Period,
} from "@/domain";
import {
  buildAccountantReport,
  buildPartnerReport,
  buildStoreReport,
  isWholeMonth,
  sie4Verifications,
  type AccountantReport,
  type LedgerAccount,
  type PartnerOwner,
  type PartnerReport,
  type ReportSources,
  type Sie4Options,
  type StoreReport,
} from "@/reports";

import type { ReportType } from "./kinds";
import type { StoreService } from "./store-service";

export const SNAPSHOT_VERSION = 1;

/** Organisationen som rapporten kommer från. */
export interface SnapshotOrganization {
  readonly id: string;
  readonly name: string;
  readonly orgNumber: string | null;
  readonly timeZone: string;
}

interface SnapshotBase {
  readonly version: typeof SNAPSHOT_VERSION;
  readonly type: ReportType;
  readonly month: IsoMonth;
  readonly period: Period;
  readonly organization: SnapshotOrganization;
  /** När underlaget räknades (ISO 8601). */
  readonly generatedAt: string;
  readonly calcVersion: string;
}

export interface StoreSnapshot extends SnapshotBase {
  readonly type: "butik";
  readonly store: { readonly id: string; readonly name: string };
  readonly report: StoreReport;
  /** Påfyllningar och mest besökt tid (antal, inga belopp). */
  readonly service: StoreService;
}

export interface AccountantSnapshot extends SnapshotBase {
  readonly type: "bokforing";
  readonly report: AccountantReport;
  /** Inställningarna för SIE-exporten (kontoplan och räkenskapsår vid skapandet). */
  readonly sie: Sie4Options;
  /** Konton som behövs för SIE men saknas i kontoplanen; tom = exporten går att skapa. */
  readonly missingAccounts: readonly string[];
  /**
   * Order i perioden vars titel inte är kopplad. De ingår i försäljningen och
   * butiksersättningen men saknar inköpspris. Saknas i äldre ögonblicksbilder.
   */
  readonly ordersWithoutTitle?: number;
  /**
   * Sista verifikationsnumret i SIE-filen (null om filen inte kan skapas). Nästa månads
   * underlag fortsätter numreringen härifrån. Saknas i äldre ögonblicksbilder.
   */
  readonly sieLastNumber?: number | null;
}

export interface PartnerSnapshot extends SnapshotBase {
  readonly type: "delagare";
  readonly report: PartnerReport;
  /** Egen kommentar till delägaren. */
  readonly comment: string | null;
  /** Antal lagerplatser och titlar vars saldo inte var känt vid periodens slut. */
  readonly unknownStock: number;
}

export type ReportSnapshot = StoreSnapshot | AccountantSnapshot | PartnerSnapshot;

/** En lagerhändelse i den form `stockLevels` vill ha. */
export type SnapshotStockEvent = StockEventRef;

export interface SnapshotInput {
  readonly type: ReportType;
  readonly month: IsoMonth;
  /**
   * Eget datum (alla rapporttyper): rapportens dagar. Saknas = hela `month`. `month` är
   * då månaden som intervallet börjar i.
   */
  readonly period?: Period | null;
  readonly organization: SnapshotOrganization;
  /** Order (gärna 13 månader bakåt), priser, avtal, placeringar och namn. */
  readonly sources: ReportSources;
  /** När underlaget räknas (ISO 8601). */
  readonly generatedAt: string;
  /** Butiken (bara butiksrapport). */
  readonly storeId?: string | null;
  /** Personlig hälsning (butiksrapport). */
  readonly greeting?: string | null;
  /** Påfyllningar och mest besökt tid (butiksrapport). */
  readonly storeService?: StoreService;
  /** Egen kommentar (delägarrapport). */
  readonly comment?: string | null;
  /** Ägarandelar som gällde periodens sista dag (delägarrapport). */
  readonly owners?: readonly PartnerOwner[];
  /** Lagerhändelser fram till periodens slut (delägarrapport, lagervärde). */
  readonly stockEvents?: readonly SnapshotStockEvent[] | null;
  /** Första dagen med data. */
  readonly historyStart?: IsoDate | null;
  /** Kontoplanen (bokföringsunderlag). */
  readonly ledgerAccounts?: readonly LedgerAccount[];
  /** Räkenskapsårets första månad, 1–12. Standard 1. */
  readonly fiscalYearStartMonth?: number;
  /** Order i perioden utan kopplad titel (ingår i `sources.orders` med en egen titel). */
  readonly ordersWithoutTitle?: number;
  /** SIE: verifikationsserie och första nummer. Standard "A" och 1. */
  readonly sieSeries?: { readonly series: string; readonly firstNumber: number };
}

/** Konton som SIE-exporten behöver med dagens inställningar. */
export function requiredAccounts(report: AccountantReport): string[] {
  const keys = ["settlement", "sales"];
  if (report.totals.vatOre !== 0) keys.push("vat_out");
  if (report.totals.feesOre !== 0) keys.push("card_fees");
  return keys;
}

/** Räkenskapsåret som innehåller månaden, givet räkenskapsårets första månad (1–12). */
export function fiscalYearOf(month: IsoMonth, startMonth = 1): Period {
  if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
    throw new DomainError("invalid_input", `Räkenskapsårets första månad ska vara 1–12.`);
  }
  const { year, month: m } = parseIsoMonth(month);
  const startYear = m >= startMonth ? year : year - 1;
  const first = `${startYear}-${String(startMonth).padStart(2, "0")}` as IsoMonth;
  return { start: `${first}-01`, end: monthEnd(addMonths(first, 11)) };
}

/** Lager vid månadens slut per titel (se `stockAt`). */
export function stockAtMonthEnd(
  events: readonly SnapshotStockEvent[],
  month: IsoMonth,
): { stock: { titleId: string; quantity: number }[]; unknown: number } {
  return stockAt(events, monthEnd(month));
}

/**
 * Lager vid dagens slut per titel: summan av kända, positiva saldon över alla
 * lagerplatser (automater och alla egna lager). Okända saldon räknas separat.
 */
export function stockAt(
  events: readonly SnapshotStockEvent[],
  date: IsoDate,
): { stock: { titleId: string; quantity: number }[]; unknown: number } {
  const levels = stockLevels(events, date);
  const byTitle = new Map<string, number>();
  let unknown = 0;
  for (const l of levels) {
    if (!l.known) {
      unknown += 1;
      continue;
    }
    if (l.onHand <= 0) continue;
    byTitle.set(l.titleId, (byTitle.get(l.titleId) ?? 0) + l.onHand);
  }
  const stock = [...byTitle.entries()]
    .map(([titleId, quantity]) => ({ titleId, quantity }))
    .sort((a, b) => (a.titleId < b.titleId ? -1 : a.titleId > b.titleId ? 1 : 0));
  return { stock, unknown };
}

/** Kalenderdagen ('ÅÅÅÅ-MM-DD') för en tidpunkt i organisationens tidszon. */
export function localDay(iso: string, timeZone: string): IsoDate {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Sista verifikationsnumret i SIE-filen, eller null om filen inte kan skapas. */
export function lastVerificationNumber(report: AccountantReport, sie: Sie4Options): number | null {
  try {
    const list = sie4Verifications(report, sie);
    const last = list[list.length - 1];
    return last ? last.number : (sie.firstVerificationNumber ?? 1) - 1;
  } catch {
    return null;
  }
}

function cleanText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  const t = value.replace(/\r\n?/g, "\n").trim();
  if (t === "") return null;
  if (t.length > max) {
    throw new DomainError("invalid_input", `Texten får vara högst ${max} tecken.`);
  }
  return t;
}

/**
 * Bygger ögonblicksbilden för en rapport. Kastar `DomainError` vid ogiltig indata
 * (okänd butik, ogiltig månad, otillåten text i butiksrapporten).
 */
export function buildSnapshot(input: SnapshotInput): ReportSnapshot {
  parseIsoMonth(input.month);
  const period = input.period ?? monthPeriod(input.month);
  const custom = !isWholeMonth(period);
  if (custom && monthOf(period.start) !== input.month) {
    throw new DomainError("invalid_input", "Perioden ska börja i rapportens månad.");
  }
  const base = {
    version: SNAPSHOT_VERSION,
    month: input.month,
    period,
    organization: input.organization,
    generatedAt: input.generatedAt,
    calcVersion: CALC_VERSION,
  } as const;

  switch (input.type) {
    case "butik": {
      if (!input.storeId) throw new DomainError("invalid_input", "Välj en butik.");
      const report = buildStoreReport(input.sources, input.storeId, custom ? period : input.month, {
        greeting: cleanText(input.greeting, 1000),
      });
      return {
        ...base,
        type: "butik",
        store: report.store,
        report,
        service: input.storeService ?? {
          refills: { count: 0, last: null },
          busiest: null,
          busiestOrders: 0,
        },
      };
    }
    case "bokforing": {
      const fiscalYear = fiscalYearOf(input.month, input.fiscalYearStartMonth ?? 1);
      if (period.end > fiscalYear.end) {
        throw new DomainError("invalid_input", "Perioden måste ligga inom ett räkenskapsår.");
      }
      const report = buildAccountantReport(input.sources, base.period);
      const ledgerAccounts = [...(input.ledgerAccounts ?? [])];
      const have = new Set(ledgerAccounts.map((a) => a.key));
      const sie: Sie4Options = {
        company: input.organization.name,
        orgNumber: input.organization.orgNumber,
        ledgerAccounts,
        fiscalYear,
        verificationSeries: input.sieSeries?.series ?? "A",
        firstVerificationNumber: input.sieSeries?.firstNumber ?? 1,
        // Dagen då underlaget skapas (#GEN), inte periodens slut.
        generatedOn: localDay(input.generatedAt, input.organization.timeZone),
      };
      return {
        ...base,
        type: "bokforing",
        report,
        sie,
        missingAccounts: requiredAccounts(report).filter((k) => !have.has(k)),
        ordersWithoutTitle: input.ordersWithoutTitle ?? 0,
        sieLastNumber: lastVerificationNumber(report, sie),
      };
    }
    case "delagare": {
      // Eget datum: samma uträkning på intervallets dagar; lagret och ägarandelarna gäller
      // periodens sista dag (en hel månad: månadens sista dag, som förut).
      const stock = input.stockEvents ? stockAt(input.stockEvents, period.end) : null;
      const report = buildPartnerReport(input.sources, custom ? period : input.month, {
        owners: input.owners && input.owners.length > 0 ? input.owners : undefined,
        stock: stock?.stock,
        historyStart: input.historyStart,
        trendMonths: 12,
      });
      return {
        ...base,
        type: "delagare",
        report,
        comment: cleanText(input.comment, 2000),
        unknownStock: stock?.unknown ?? 0,
      };
    }
  }
}

/** Kontrollerar att ett sparat värde är en ögonblicksbild som appen kan rendera. */
export function asSnapshot(value: unknown): ReportSnapshot {
  const v = value as Partial<ReportSnapshot> | null;
  if (
    !v ||
    typeof v !== "object" ||
    v.version !== SNAPSHOT_VERSION ||
    (v.type !== "butik" && v.type !== "bokforing" && v.type !== "delagare") ||
    typeof v.month !== "string" ||
    !v.report
  ) {
    throw new DomainError("invalid_input", "Rapportens underlag har ett okänt format.");
  }
  return v as ReportSnapshot;
}

/** Rapportens slutsats (en mening), samma som överst i PDF:en. */
export function conclusionOf(snapshot: ReportSnapshot): string {
  return snapshot.report.conclusion.text;
}

/** Butiken som en butiksrapport gäller, annars null. */
export function storeIdOf(snapshot: ReportSnapshot): string | null {
  return snapshot.type === "butik" ? snapshot.store.id : null;
}

/**
 * Samma rapport: samma typ och samma uträknade innehåll (allt i `report`). Ett utkast som
 * inte längre är samma som en ny uträkning är inaktuellt (t.ex. rättade inköpspriser,
 * ett testköp eller ett nytt avtal efter att utkastet skapades) och ska inte godkännas.
 */
export function sameReport(a: ReportSnapshot, b: ReportSnapshot): boolean {
  // Den sparade ögonblicksbilden kommer ur jsonb, som ordnar om nycklarna: jämför med
  // sorterade nycklar och utan fält som saknas (undefined sparas inte).
  return a.type === b.type && canonical(a.report) === canonical(b.report);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>)
            .filter(([, x]) => x !== undefined)
            .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)),
        )
      : v,
  );
}

/** Rapportens viktigaste belopp (butiksrapporten: butikens ersättning), annars null. */
export function headlineOreOf(snapshot: ReportSnapshot): number | null {
  return snapshot.type === "butik" ? snapshot.report.compensation.totalOre : null;
}

/** Förfrågan som ger samma rapport igen med dagens underlag. */
export function requestOf(snapshot: ReportSnapshot): {
  type: ReportType;
  month: IsoMonth;
  period: Period | null;
  storeId: string | null;
  greeting: string | null;
  comment: string | null;
} {
  return {
    type: snapshot.type,
    month: snapshot.month,
    period: isWholeMonth(snapshot.period) ? null : snapshot.period,
    storeId: storeIdOf(snapshot),
    greeting: snapshot.type === "butik" ? snapshot.report.greeting : null,
    comment: snapshot.type === "delagare" ? snapshot.comment : null,
  };
}
