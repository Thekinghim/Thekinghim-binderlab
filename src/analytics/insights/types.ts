/**
 * Typer för Värt att veta: iakttagelser som räknas fram med regler i kod.
 */

import type { EconomicsSources, Period } from "@/domain";
import type { AnalyticsOrder, Evidence, MachineRef, TitleRef } from "../todos/types";

/** Regeln som gav iakttagelsen. */
export type InsightKind =
  | "loss-title"
  | "stale-machine"
  | "title-up"
  | "title-down"
  | "concentration"
  | "weekday-pattern"
  | "best-day";

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
}

/** Sammanhang för reglerna. */
export interface InsightContext {
  readonly input: InsightInput;
  readonly period: Period;
  readonly compare: Period;
  /** Order i perioden. */
  readonly orders: readonly AnalyticsOrder[];
  /** Order i jämförelseperioden. */
  readonly compareOrders: readonly AnalyticsOrder[];
  readonly titleName: (id: string) => string;
  readonly machineName: (id: string) => string;
}
