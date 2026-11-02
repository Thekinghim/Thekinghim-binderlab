/**
 * Typer för Värt att veta: iakttagelser som räknas fram med regler i kod.
 */

import type { EconomicsSources, IsoDate, Period } from "@/domain";
import type { AnalyticsOrder, Evidence, MachineRef, TitleRef } from "../todos/types";

/** Regeln som gav iakttagelsen. */
export type InsightKind =
  | "loss-title"
  | "stale-machine"
  | "title-up"
  | "title-down"
  | "concentration"
  | "weekday-pattern"
  | "best-day"
  | "period-summary"
  | "top-title";

/** Hur iakttagelsen ska läsas: bra, dålig eller neutral nyhet. */
export type InsightTone = "positive" | "negative" | "neutral";

/** En iakttagelse. */
export interface Insight {
  /** Stabil nyckel, t.ex. 'concentration:<titel>'. */
  readonly key: string;
  readonly kind: InsightKind;
  /** Urvalspoäng 0–10 000. Högst visas först. */
  readonly score: number;
  readonly tone: InsightTone;
  /** Huvudmeningen, t.ex. "30th Celebration står för 33 % av intäkten". */
  readonly text: string;
  /** Talen bakom, i en mening. */
  readonly detail: string;
  readonly evidence: Evidence;
  readonly link: string;
}

/** Indata till `computeInsights`. */
export interface InsightInput extends EconomicsSources {
  readonly orders: readonly AnalyticsOrder[];
  readonly titles: readonly TitleRef[];
  readonly machines: readonly MachineRef[];
}

/** Inställningar för urvalet. */
export interface InsightOptions {
  /** Högst så många iakttagelser. Standard 4. */
  readonly maxCount?: number;
  /**
   * Minst så många iakttagelser om det finns kandidater: urvalet fyller på med fler
   * kandidater från redan använda regler. Standard 3.
   */
  readonly minCount?: number;
  /**
   * Nu (Date, ms eller ISO 8601 med tidszon). Anges det räknas bara hela dagar t.o.m. i går:
   * en period som sträcker sig in i dag eller framtiden kortas, och en period som börjar
   * i dag eller senare ger inga iakttagelser. Stillastående automat tar hänsyn till order
   * fram till nu. Sidan ska alltid skicka med det.
   */
  readonly now?: Date | string | number;
  /** Organisationens tidszon för `now`. Standard 'Europe/Stockholm'. */
  readonly timeZone?: string;
}

/** Sammanhang för reglerna. */
export interface InsightContext {
  readonly input: InsightInput;
  /** Perioden som räknas: den begärda, kortad till i går om `now` angavs. */
  readonly period: Period;
  /** Jämförelseperioden, kortad på samma sätt. */
  readonly compare: Period;
  /** Den begärda perioden (för texter som "förra veckan"). */
  readonly requestedPeriod: Period;
  /** Den begärda jämförelseperioden. */
  readonly requestedCompare: Period;
  /**
   * Sista dag med känd försäljning: i dag om `now` angavs, annars periodens slut.
   * En automat som sålt efter perioden räknas inte som stillastående.
   */
  readonly dataEnd: IsoDate;
  /** Order i perioden. */
  readonly orders: readonly AnalyticsOrder[];
  /** Order i jämförelseperioden. */
  readonly compareOrders: readonly AnalyticsOrder[];
  readonly titleName: (id: string) => string;
  readonly machineName: (id: string) => string;
}
