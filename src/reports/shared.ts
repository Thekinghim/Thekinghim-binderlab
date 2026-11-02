/**
 * Gemensam hjälp för rapporterna: namnuppslag, underlag (evidence) och urval av order.
 */

import {
  DomainError,
  assertIsoDate,
  monthPeriod,
  parseIsoMonth,
  type IsoDate,
  type IsoMonth,
  type LedgerEntry,
  type Period,
} from "@/domain";
import type {
  Evidence,
  EvidenceFigure,
  EvidenceScope,
  FigureUnit,
  MachineEntity,
  NamedEntity,
  ReportSources,
} from "./types";

/**
 * Namnuppslag för butiker, automater och titlar. Saknas ett namn visas id:t, så att
 * rapporten aldrig visar en tom cell.
 */
export class Catalog {
  private readonly stores = new Map<string, string>();
  private readonly machines = new Map<string, string>();
  private readonly titles = new Map<string, string>();

  constructor(sources: Pick<ReportSources, "stores" | "machines" | "titles">) {
    for (const s of sources.stores) this.stores.set(s.id, s.name);
    for (const m of sources.machines) this.machines.set(m.id, machineLabel(m));
    for (const t of sources.titles) this.titles.set(t.id, t.name);
  }

  store(id: string): string {
    return this.stores.get(id) ?? id;
  }

  machine(id: string): string {
    return this.machines.get(id) ?? id;
  }

  title(id: string): string {
    return this.titles.get(id) ?? id;
  }
}

/** Automatens visningsnamn: "Nordstan (BL-001)", eller bara namnet/koden om bara det finns. */
export function machineLabel(m: MachineEntity): string {
  const code = m.code ?? "";
  if (code === "" || code === m.name) return m.name || m.id;
  if (!m.name) return code;
  return `${m.name} (${code})`;
}

/** Ett tal i underlaget. */
export function fig(label: string, value: number, unit: FigureUnit): EvidenceFigure {
  return { label, value, unit };
}

/**
 * Bygger ett underlag. Listor som är tomma utelämnas så att JSON-ögonblicksbilden
 * hålls liten; listorna sorteras så att resultatet inte beror på indataordningen.
 */
export function evidence(args: {
  rule: string;
  scope: EvidenceScope;
  orderCount: number;
  figures?: readonly EvidenceFigure[];
  externalIds?: readonly string[];
  dates?: readonly IsoDate[];
  titleIds?: readonly string[];
}): Evidence {
  const out: {
    rule: string;
    scope: EvidenceScope;
    orderCount: number;
    figures: readonly EvidenceFigure[];
    externalIds?: readonly string[];
    dates?: readonly IsoDate[];
    titleIds?: readonly string[];
  } = {
    rule: args.rule,
    scope: args.scope,
    orderCount: args.orderCount,
    figures: args.figures ?? [],
  };
  if (args.externalIds && args.externalIds.length > 0) {
    out.externalIds = [...new Set(args.externalIds)].sort(compareExternalIds);
  }
  if (args.dates && args.dates.length > 0) out.dates = [...new Set(args.dates)].sort();
  if (args.titleIds && args.titleIds.length > 0) out.titleIds = [...new Set(args.titleIds)].sort();
  return out;
}

/** Sorterar ordernummer numeriskt när båda är heltal, annars som text. */
export function compareExternalIds(a: string, b: string): number {
  const na = /^\d+$/.test(a);
  const nb = /^\d+$/.test(b);
  if (na && nb && a.length !== b.length) return a.length - b.length;
  if (na !== nb) return na ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Kontrollerar en månad 'ÅÅÅÅ-MM' och ger dess period (hela kalendermånaden). */
export function monthScope(month: IsoMonth): Period {
  parseIsoMonth(month);
  return monthPeriod(month);
}

/** Första affärsdag med en order, eller `null`. */
export function firstOrderDate(orders: ReportSources["orders"]): IsoDate | null {
  let first: IsoDate | null = null;
  for (const o of orders) if (first === null || o.businessDate < first) first = o.businessDate;
  return first;
}

/**
 * Sant om det finns historik för perioden: perioden slutar på eller efter dagen då
 * historiken börjar. `historyStart` = `null` betyder att det inte finns någon data alls.
 */
export function hasHistory(period: Period, historyStart: IsoDate | null): boolean {
  if (historyStart === null) return false;
  assertIsoDate(historyStart, "Historikens start");
  return period.end >= historyStart;
}

/** Summa av ett fält över liggarrader. */
export function sumEntries(
  entries: readonly LedgerEntry[],
  pick: (e: LedgerEntry) => number,
): number {
  let s = 0;
  for (const e of entries) s += pick(e);
  if (!Number.isSafeInteger(s)) throw new DomainError("overflow", "Summan är för stor.");
  return s;
}

/** Sorterar namngivna rader på namn (svensk ordning saknas utan Intl; kodpunktsordning). */
export function byName<T extends NamedEntity>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Kontrollerar att ett beräknat belopp är ett säkert heltal, annars `DomainError("overflow")`.
 * (Motsvarar `checkSafe` i src/domain/money.ts, som inte exporteras från '@/domain'.)
 */
export function safeOre(value: number, what: string): number {
  if (!Number.isSafeInteger(value)) {
    throw new DomainError("overflow", `${what} är för stort för att räknas exakt.`);
  }
  return value;
}
