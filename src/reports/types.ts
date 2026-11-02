/**
 * Typer för rapportunderlagen (butik, bokföring, delägare).
 *
 * Rapporterna byggs ovanpå beräkningslagret i `@/domain`: belopp i öre som heltal,
 * procentsatser i baspunkter, affärsdatum 'ÅÅÅÅ-MM-DD'. Varje resultat som visas för
 * användaren bär sitt underlag (`Evidence`): vilken regel som gäller, vilka order
 * (period och filter), vilka dagar/titlar och vilka tal resultatet bygger på.
 */

import type { EconomicsSources, IsoDate, OrderLine, Period } from "@/domain";

/** Något med id och visningsnamn (butik, titel). */
export interface NamedEntity {
  readonly id: string;
  readonly name: string;
}

/** En automat. `code` är t.ex. "BL-001". */
export interface MachineEntity extends NamedEntity {
  readonly code?: string | null;
}

/**
 * Allt rapporterna räknar på. `orders` får innehålla mer än rapportperioden
 * (historik behövs för jämförelser, utveckling och avstämning av nummerserien);
 * varje rapport väljer själv ut de order som hör till perioden.
 */
export interface ReportSources extends EconomicsSources {
  readonly orders: readonly OrderLine[];
  readonly stores: readonly NamedEntity[];
  readonly machines: readonly MachineEntity[];
  readonly titles: readonly NamedEntity[];
}

/** Vilka order ett resultat bygger på: perioden plus eventuella filter. UI länkar hit. */
export interface EvidenceScope {
  readonly period: Period;
  readonly storeId?: string;
  readonly machineId?: string;
  readonly titleId?: string;
}

/** Enhet för ett tal i underlaget. */
export type FigureUnit = "ore" | "bp" | "count" | "days";

/** Ett tal som ett resultat bygger på. */
export interface EvidenceFigure {
  readonly label: string;
  readonly value: number;
  readonly unit: FigureUnit;
}

/**
 * Underlag för ett resultat.
 * - `rule`: regeln i klartext (svenska), t.ex. "Intäkt = Σ belopp exkl. moms".
 * - `scope` + `orderCount`: vilka order som ingår (period och filter).
 * - `figures`: talen som resultatet räknas fram ur.
 * - `externalIds`, `dates`, `titleIds`: utpekade order, dagar och titlar när de är få
 *   och relevanta (t.ex. luckor i nummerserien eller dagen för en prisändring).
 */
export interface Evidence {
  readonly rule: string;
  readonly scope: EvidenceScope;
  readonly orderCount: number;
  readonly figures: readonly EvidenceFigure[];
  readonly externalIds?: readonly string[];
  readonly dates?: readonly IsoDate[];
  readonly titleIds?: readonly string[];
}

/** Rapportens slutsats: en mening, regeln som valdes och dess underlag. */
export interface Conclusion {
  readonly text: string;
  /** Vilken regel som gav meningen, t.ex. "store.growth". */
  readonly ruleId: string;
  readonly evidence: Evidence;
}
