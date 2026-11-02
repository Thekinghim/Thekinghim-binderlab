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
}

export interface PartnerSnapshot extends SnapshotBase {
  readonly type: "delagare";
  readonly report: PartnerReport;
  /** Egen kommentar till delägaren. */
  readonly comment: string | null;
  /** Antal lagerplatser och titlar vars saldo inte var känt vid månadens slut. */
  readonly unknownStock: number;
}

export type ReportSnapshot = StoreSnapshot | AccountantSnapshot | PartnerSnapshot;

/** En lagerhändelse i den form `stockLevels` vill ha. */
export type SnapshotStockEvent = StockEventRef;

export interface SnapshotInput {
  readonly type: ReportType;
  readonly month: IsoMonth;
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
  /** Ägarandelar som gällde månadens sista dag (delägarrapport). */
  readonly owners?: readonly PartnerOwner[];
  /** Lagerhändelser fram till månadens slut (delägarrapport, lagervärde). */
  readonly stockEvents?: readonly SnapshotStockEvent[] | null;
  /** Första dagen med data. */
  readonly historyStart?: IsoDate | null;
  /** Kontoplanen (bokföringsunderlag). */
  readonly ledgerAccounts?: readonly LedgerAccount[];
  /** Räkenskapsårets första månad, 1–12. Standard 1. */
  readonly fiscalYearStartMonth?: number;
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

/**
 * Lager vid månadens slut per titel: summan av kända, positiva saldon över alla
 * lagerplatser (automater och centrallager). Okända saldon räknas separat.
 */
export function stockAtMonthEnd(
  events: readonly SnapshotStockEvent[],
  month: IsoMonth,
): { stock: { titleId: string; quantity: number }[]; unknown: number } {
  const levels = stockLevels(events, monthEnd(month));
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
  const base = {
    version: SNAPSHOT_VERSION,
    month: input.month,
    period: monthPeriod(input.month),
    organization: input.organization,
    generatedAt: input.generatedAt,
    calcVersion: CALC_VERSION,
  } as const;

  switch (input.type) {
    case "butik": {
      if (!input.storeId) throw new DomainError("invalid_input", "Välj en butik.");
      const report = buildStoreReport(input.sources, input.storeId, input.month, {
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
      const report = buildAccountantReport(input.sources, base.period);
      const ledgerAccounts = [...(input.ledgerAccounts ?? [])];
      const have = new Set(ledgerAccounts.map((a) => a.key));
      const sie: Sie4Options = {
        company: input.organization.name,
        orgNumber: input.organization.orgNumber,
        ledgerAccounts,
        fiscalYear: fiscalYearOf(input.month, input.fiscalYearStartMonth ?? 1),
        verificationSeries: "A",
        firstVerificationNumber: 1,
        generatedOn: base.period.end,
      };
      return {
        ...base,
        type: "bokforing",
        report,
        sie,
        missingAccounts: requiredAccounts(report).filter((k) => !have.has(k)),
      };
    }
    case "delagare": {
      const stock = input.stockEvents ? stockAtMonthEnd(input.stockEvents, input.month) : null;
      const report = buildPartnerReport(input.sources, input.month, {
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
