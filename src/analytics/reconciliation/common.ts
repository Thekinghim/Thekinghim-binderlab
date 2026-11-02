/**
 * Gemensam hjälp för ekonomiområdet (avstämning, kassaflöde och avtal).
 *
 * Konventioner som i src/domain: belopp i öre (heltal), andelar i bp, affärsdatum
 * 'ÅÅÅÅ-MM-DD' i Europe/Stockholm, intervall inklusive i båda ändar. Ingen funktion här
 * använder `Date`, så resultatet beror inte på processens tidszon.
 */

import {
  addDays,
  addMonths,
  assertIsoDate,
  assertPeriod,
  daysInMonth,
  DomainError,
  monthPeriod,
  parseIsoDate,
  parseIsoMonth,
  type IsoDate,
  type IsoMonth,
  type Period,
} from "@/domain";
import { evidence, uniqueSorted } from "../todos/common";
import { day } from "../todos/text";
import type { Evidence, EvidenceFigure } from "../todos/types";

export type { EvidenceFigure };

/**
 * Underlag för ett ekonomiresultat. Samma fält som `Evidence` i Att göra och Värt att veta,
 * plus referenser till utbetalningar, avtal, fasta kostnader och inköp, så att UI kan länka dit.
 * Alla listor är sorterade och utan dubbletter.
 */
export interface FinanceEvidence extends Evidence {
  /** Utbetalningarnas referenser (leverantörens verifikations-/utbetalnings-id). */
  readonly payoutReferences: string[];
  readonly contractIds: string[];
  readonly fixedCostIds: string[];
  readonly purchaseIds: string[];
}

/** Indata till `financeEvidence`. Allt utom regeln är valfritt. */
export interface FinanceEvidenceInput {
  readonly rule: string;
  readonly period?: Period | null;
  readonly orderIds?: Iterable<string>;
  readonly dates?: Iterable<IsoDate>;
  readonly titleIds?: Iterable<string>;
  readonly machineIds?: Iterable<string>;
  readonly storeIds?: Iterable<string>;
  readonly payoutReferences?: Iterable<string>;
  readonly contractIds?: Iterable<string>;
  readonly fixedCostIds?: Iterable<string>;
  readonly purchaseIds?: Iterable<string>;
  readonly figures?: EvidenceFigure[];
}

/**
 * Bygger ett underlag: regeln i klartext, perioden och sorterade, unika listor över
 * order, dagar, titlar, automater, butiker, utbetalningar, avtal, kostnader och inköp
 * som resultatet bygger på, samt de tal (öre, bp, antal) som visas.
 */
export function financeEvidence(e: FinanceEvidenceInput): FinanceEvidence {
  return {
    ...evidence({
      rule: e.rule,
      period: e.period ?? null,
      orderIds: e.orderIds,
      dates: e.dates,
      titleIds: e.titleIds,
      machineIds: e.machineIds,
      storeIds: e.storeIds,
      figures: e.figures,
    }),
    payoutReferences: uniqueSorted(e.payoutReferences ?? []),
    contractIds: uniqueSorted(e.contractIds ?? []),
    fixedCostIds: uniqueSorted(e.fixedCostIds ?? []),
    purchaseIds: uniqueSorted(e.purchaseIds ?? []),
  };
}

/** Ett tal i underlaget i öre. */
export function oreFigure(key: string, label: string, value: number): EvidenceFigure {
  return { key, label, value, unit: "ore" };
}

/** Ett antal i underlaget. */
export function countFigure(key: string, label: string, value: number): EvidenceFigure {
  return { key, label, value, unit: "count" };
}

/** En andel i bp i underlaget. */
export function bpFigure(key: string, label: string, value: number): EvidenceFigure {
  return { key, label, value, unit: "bp" };
}

/** Ett antal dagar i underlaget. */
export function daysFigure(key: string, label: string, value: number): EvidenceFigure {
  return { key, label, value, unit: "days" };
}

/**
 * Kontrollerar att ett belopp är ett säkert heltal (öre). Negativa värden tillåts bara
 * med `allowNegative`. Kastar `DomainError('invalid_amount')` med svensk text.
 */
export function assertOre(value: unknown, label: string, allowNegative = false): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new DomainError(
      "invalid_amount",
      `${label} måste vara ett heltal i öre, fick ${String(value)}.`,
    );
  }
  if (!allowNegative && value < 0) {
    throw new DomainError("invalid_amount", `${label} får inte vara negativt, fick ${value}.`);
  }
  return value;
}

/** Kontrollerar ett heltal ≥ 0 (antal, månader, dagar). */
export function assertCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "invalid_input",
      `${label} måste vara ett heltal ≥ 0, fick ${String(value)}.`,
    );
  }
  return value;
}

/** Kontrollerar att en sträng är ett id som inte är tomt. */
export function assertId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DomainError("invalid_input", `${label} saknas.`);
  }
  return value;
}

/** Säker summering av heltal (öre) som kastar vid överslag i stället för att ge fel siffra. */
export function addOre(a: number, b: number): number {
  const s = a + b;
  if (!Number.isSafeInteger(s)) {
    throw new DomainError("overflow", "Summan är för stor för att räknas exakt.");
  }
  return s;
}

/**
 * Flyttar ett datum hela månader framåt (eller bakåt vid negativt tal). Dagen behålls,
 * men kapas till månadens sista dag om månaden är kortare:
 * shiftMonths('2026-01-31', 1) → '2026-02-28', shiftMonths('2027-03-31', -3) → '2026-12-31'.
 * Räkna alltid från samma utgångsdatum (start + k månader), så glider inte dagen.
 *
 * (Beräkningslagret har `addMonths` för månader 'ÅÅÅÅ-MM' men inte för datum.)
 */
export function shiftMonths(date: IsoDate, months: number): IsoDate {
  if (!Number.isSafeInteger(months)) {
    throw new DomainError("invalid_input", `Antal månader måste vara ett heltal, fick ${months}.`);
  }
  const p = parseIsoDate(date);
  const month = addMonths(date.slice(0, 7), months);
  const dayOfMonth = Math.min(p.day, daysInMonth(month));
  return `${month}-${dayOfMonth < 10 ? "0" : ""}${dayOfMonth}`;
}

/**
 * Tolkar en period som antingen en kalendermånad 'ÅÅÅÅ-MM' eller { start, end }.
 * Kastar `DomainError` om perioden är ogiltig.
 */
export function toPeriod(period: Period | IsoMonth, label = "Perioden"): Period {
  if (typeof period === "string") {
    try {
      parseIsoMonth(period);
    } catch {
      throw new DomainError(
        "invalid_period",
        `${label} måste vara en månad ÅÅÅÅ-MM eller { start, end }, fick ${JSON.stringify(period)}.`,
      );
    }
    return monthPeriod(period);
  }
  assertPeriod(period);
  return { start: period.start, end: period.end };
}

/** Datum med år: '2027-03-31' → "31 mars 2027". */
export function dateWithYear(date: IsoDate): string {
  assertIsoDate(date);
  return `${day(date)} ${Number(date.slice(0, 4))}`;
}

/** Dagen före. */
export function dayBefore(date: IsoDate): IsoDate {
  return addDays(date, -1);
}

/** Stabil jämförelse av strängar (för sortering utan locale). */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
