/**
 * Typer för expansion: butiksprofiler, platshistorik, uppskattningar och leads.
 *
 * Belopp i öre (heltal), andelar i bp, återbetalningstid i tiondels månader
 * (72 = 7,2 månader). Alla uppskattningar är märkta `kind: 'estimate'`.
 */

import type { IsoDate, Period } from "@/domain";
import type { ScenarioEvidence } from "./common";
import type { StoreSimilarity } from "./similarity";

/** Attribut som avgör hur lik en plats är en annan. `null` = okänt. */
export interface StoreAttributes {
  /** Butikstyp, t.ex. "livs", "kiosk", "bensinstation", "köpcentrum". */
  readonly storeType: string | null;
  /** Ort, t.ex. "Malmö". */
  readonly city: string | null;
  /** Öppettimmar per vecka (heltal). */
  readonly openHoursPerWeek: number | null;
  /** Butikens yta i m² (heltal). */
  readonly areaSqm: number | null;
}

/** En befintlig butik med attribut. */
export interface StoreProfile extends StoreAttributes {
  readonly id: string;
  readonly name: string;
}

/**
 * Historiken för en befintlig butik under en period: lönsamheten per butik
 * (`profitability(…, 'store')`) och antalet automatdagar enligt placeringarna.
 */
export interface SiteHistory {
  readonly storeId: string;
  readonly period: Period;
  /** Automater som stod i butiken någon dag i perioden, sorterade. */
  readonly machineIds: string[];
  /** Σ dagar per automat som stod i butiken under perioden. */
  readonly machineDays: number;
  /** Första och sista dag med en automat i butiken under perioden. */
  readonly firstDay: IsoDate | null;
  readonly lastDay: IsoDate | null;
  readonly orders: number;
  readonly unpricedOrders: number;
  /** Nettointäkt, prissatta order. */
  readonly revenueOre: number;
  /** Nettointäkt för order utan inköpspris (ingår inte i vinsten). */
  readonly unpricedRevenueOre: number;
  /** Andel av intäkten som saknar inköpspris, bp. `null` utan intäkt. */
  readonly unpricedShareBp: number | null;
  readonly costOre: number;
  readonly feesOre: number;
  readonly commissionOre: number;
  /** Hyra som dras från vinsten (inklusive ej fördelad). */
  readonly rentOre: number;
  /** Täckningsbidrag före butiksersättning = intäkt − inköp − avgifter. */
  readonly contributionOre: number;
  /** Vinst = täckningsbidrag − provision − hyra (samma som lönsamhetsvyn per butik). */
  readonly profitOre: number;
}

/** Investering för en ny automat. */
export interface InvestmentPlan {
  /** Inköp av automaten. */
  readonly purchaseOre: number;
  /** Installation (frakt, el, montering). */
  readonly installationOre: number;
  /** Övrigt (skyltning, första lager räknas inte hit). */
  readonly otherOre?: number;
}

/**
 * Villkor för den nya platsen. Anges de räknas butiksersättningen med dem; annars
 * används de jämförda platsernas faktiska provision och hyra per automatdag.
 */
export interface SiteTerms {
  readonly commissionBp: number | null;
  readonly monthlyRentOre: number | null;
}

/** Ett intervall: lägsta, förväntat (viktat snitt) och högsta. */
export interface EstimateRange {
  readonly low: number;
  readonly expected: number;
  readonly high: number;
}

/** Återbetalningstid i tiondels månader. `null` = återbetalas inte (vinsten ≤ 0). */
export interface PaybackRange {
  /** Bästa fallet (från högsta vinsten). */
  readonly low: number | null;
  readonly expected: number | null;
  /** Sämsta fallet (från lägsta vinsten). */
  readonly high: number | null;
}

/** En plats som uppskattningen bygger på. */
export interface BasisSite {
  readonly storeId: string;
  readonly name: string;
  readonly similarity: StoreSimilarity;
  readonly machineDays: number;
  readonly machineIds: string[];
  /** Per automat och dag (avrundat för visning; räkningen görs exakt). */
  readonly revenuePerDayOre: number;
  readonly profitPerDayOre: number;
  /** Per automat och månad (365/12 dagar). */
  readonly revenuePerMonthOre: number;
  readonly profitPerMonthOre: number;
  /** Återbetalningstid med denna plats takt, tiondels månader. `null` om vinsten ≤ 0. */
  readonly paybackTenths: number | null;
}

/** Varför en butik inte är med i underlaget. */
export type ExclusionReason =
  "excluded" | "short-history" | "unpriced" | "low-similarity" | "beyond-max";

/** En butik som inte togs med. */
export interface ExcludedSite {
  readonly storeId: string;
  readonly name: string;
  readonly scoreBp: number;
  readonly reason: ExclusionReason;
  /** T.ex. "Butik C: bara 12 automatdagar (minst 28)". */
  readonly text: string;
}

/** Säkerhet i uppskattningen, efter antal platser och hur lika de är. */
export type EstimateConfidence = "low" | "medium" | "high";

/** Uppskattning för en ny automat på en plats. */
export interface SiteEstimate {
  readonly kind: "estimate";
  /** 'ok', eller 'insufficient-data' när ingen befintlig plats är tillräckligt lik. */
  readonly status: "ok" | "insufficient-data";
  readonly target: StoreAttributes;
  readonly targetName: string;
  readonly period: Period;
  readonly basis: BasisSite[];
  readonly excluded: ExcludedSite[];
  /** Per automat och månad. `null` när underlag saknas. */
  readonly revenuePerMonthOre: EstimateRange | null;
  readonly profitPerMonthOre: EstimateRange | null;
  readonly profitPerDayOre: EstimateRange | null;
  readonly investmentOre: number;
  readonly paybackTenths: PaybackRange | null;
  /** Vinst per år / investering, bp. `null` utan investering eller underlag. */
  readonly annualReturnBp: EstimateRange | null;
  readonly confidence: EstimateConfidence | null;
  /** Om villkor för den nya platsen användes i stället för platsernas egna. */
  readonly usesTerms: boolean;
  /** Huvudmeningen, alltid märkt "Uppskattning". */
  readonly text: string;
  /** Hur den räknats, i en mening. */
  readonly detail: string;
  readonly evidence: ScenarioEvidence;
}
