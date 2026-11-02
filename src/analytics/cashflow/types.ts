/**
 * Typer för kassaflöde och fasta kostnader.
 *
 * Belopp i öre (heltal), affärsdatum 'ÅÅÅÅ-MM-DD', perioder inklusive i båda ändar.
 * Utflöden anges som positiva belopp; riktningen står i fältet (in/ut).
 */

import type {
  EconomicsSources,
  IsoDate,
  IsoMonth,
  OrderLine,
  Period,
  ProfitabilityInput,
} from "@/domain";
import type { FinanceEvidence } from "../reconciliation/common";
import type { Payout } from "../reconciliation/types";

// ---------------------------------------------------------------------------
// Fasta kostnader
// ---------------------------------------------------------------------------

/** Hur ofta en fast kostnad betalas. */
export type FixedCostInterval = "month" | "quarter" | "year";

/**
 * En fast kostnad (försäkring, bokföringsprogram, lagerhyra …). Betalas i förskott med
 * `amountOre` på `start` och sedan var månad/kvartal/år på samma dag (kapad till månadens
 * sista dag), till och med `end`.
 */
export interface FixedCost {
  readonly id: string;
  readonly name: string;
  /** Belopp per tillfälle (per månad, kvartal eller år), i öre. */
  readonly amountOre: number;
  readonly interval: FixedCostInterval;
  /** Första betalningen och början på första intervallet. */
  readonly start: IsoDate;
  /** Sista dagen kostnaden gäller (inklusive), `null` = tills vidare. */
  readonly end: IsoDate | null;
  /** Bärs helt av en automat (t.ex. automatens försäkring). Utelämnat = delas av alla automater. */
  readonly machineId?: string | null;
}

/** Ett betalningstillfälle för en fast kostnad. */
export interface FixedCostOccurrence {
  readonly costId: string;
  /** Betalningsdagen. */
  readonly date: IsoDate;
  readonly amountOre: number;
  /** Dagarna som betalningen avser (från betalningsdagen till dagen före nästa, högst `end`). */
  readonly coverage: Period;
}

/** En fast kostnads del av en period (periodiserad per dag). */
export interface AccruedFixedCost {
  readonly costId: string;
  readonly name: string;
  readonly machineId: string | null;
  readonly accruedOre: number;
  readonly occurrences: readonly FixedCostOccurrence[];
}

/** Resultatet av `accrueFixedCosts`. */
export interface FixedCostAccrual {
  readonly period: Period;
  readonly totalOre: number;
  /** Delas av alla automater. */
  readonly sharedOre: number;
  /** Bärs av en viss automat. */
  readonly directOre: number;
  readonly byCost: AccruedFixedCost[];
  readonly evidence: FinanceEvidence;
}

/** Hur gemensamma fasta kostnader fördelas på automaterna. */
export type FixedCostAllocationMethod = "revenue" | "equal";

/** En rad i lönsamheten efter fasta kostnader. */
export interface FixedCostRow {
  /** Automatens id, eller en särskild nyckel ('no-machine', 'unallocated', 'fixed-unallocated'). */
  readonly key: string;
  readonly kind: "machine" | "no-machine" | "unallocated" | "fixed-unallocated";
  /** Nettointäkt (alla order, även utan inköpspris) – vikten vid fördelning efter intäkt. */
  readonly revenueOre: number;
  /** Vinst enligt lönsamheten (före fasta kostnader). */
  readonly profitOre: number;
  readonly sharedFixedOre: number;
  readonly directFixedOre: number;
  readonly fixedCostOre: number;
  readonly profitAfterFixedOre: number;
  /** Marginal efter fasta kostnader: round(vinst × 10 000 / intäkt för prissatta order). */
  readonly marginAfterFixedBp: number | null;
  /** Andel av de gemensamma fasta kostnaderna i bp. */
  readonly shareBp: number | null;
  readonly evidence: FinanceEvidence;
}

/** Resultatet av `profitabilityWithFixedCosts`. */
export interface FixedCostAllocation {
  readonly period: Period;
  readonly method: FixedCostAllocationMethod;
  readonly accrual: FixedCostAccrual;
  readonly rows: FixedCostRow[];
  readonly totals: {
    readonly revenueOre: number;
    readonly profitOre: number;
    readonly fixedCostOre: number;
    readonly profitAfterFixedOre: number;
    readonly marginAfterFixedBp: number | null;
  };
  readonly summary: string;
  readonly evidence: FinanceEvidence;
}

/** Indata till `profitabilityWithFixedCosts`. */
export interface FixedCostAllocationInput extends ProfitabilityInput {
  readonly fixedCosts: readonly FixedCost[];
  /** Automater som ska bära kostnader även utan försäljning och placering. */
  readonly machineIds?: readonly string[];
  /** Namn för texterna. */
  readonly machines?: readonly { readonly id: string; readonly name: string }[];
}

// ---------------------------------------------------------------------------
// Kassaflöde
// ---------------------------------------------------------------------------

/** Ett inköp (inköpsorder eller faktura). */
export interface Purchase {
  readonly id: string;
  /** Betaldag (betald) eller planerad betaldag (planerad). */
  readonly date: IsoDate;
  readonly amountOre: number;
  readonly status: "paid" | "planned";
  /** T.ex. leverantörens namn. */
  readonly label?: string;
}

/** En faktisk betalning till en butik (provision och hyra). */
export interface StorePayment {
  readonly id: string;
  readonly storeId: string;
  readonly paidOn: IsoDate;
  readonly amountOre: number;
  /**
   * Månaden ('ÅÅÅÅ-MM') vars ersättning betalningen avser. Utelämnad: den månad vars
   * ersättning förfaller samma kalendermånad som betalningen (med standardfördröjningen
   * 1 månad: betalt 10 nov. → oktober). Ange den för sena betalningar.
   */
  readonly month?: IsoMonth | null;
}

/** Tidsindelning. */
export type CashGranularity = "month" | "week";

/** Utbetalningarnas rytm: kalendermånad, ISO-vecka eller ett fast antal dagar. */
export type PayoutCycle = "month" | "week" | { readonly days: number };

/** Typ av flöde. */
export type CashFlowKind = "payout" | "purchase" | "store-compensation" | "fixed-cost";

/** Faktiskt (har hänt, datum ≤ i dag) eller prognos. */
export type CashPhase = "actual" | "forecast";

/** Ett enskilt flöde. */
export interface CashItem {
  /** Stabil nyckel, t.ex. 'payout:U-11', 'fixed:c1:2026-11-01'. */
  readonly key: string;
  readonly kind: CashFlowKind;
  readonly direction: "in" | "out";
  readonly date: IsoDate;
  /** Alltid ≥ 0 för utflöden; inflöden kan vara negativa (negativ utbetalning). */
  readonly amountOre: number;
  readonly phase: CashPhase;
  /**
   * Sant för en väntad utbetalning, ett planerat inköp eller en butiksersättning vars datum
   * redan passerat utan att den registrerats. Den ligger då som prognos i morgon.
   */
  readonly overdue: boolean;
  /**
   * Det ursprungliga datumet (förfallodag eller väntad betaldag) för en försenad post, som
   * ligger på `date` = i morgon. Saknas när posten inte är försenad.
   */
  readonly dueDate?: IsoDate;
  readonly label: string;
  readonly evidence: FinanceEvidence;
}

/** Summor för en bucket. Utflöden som positiva belopp. */
export interface CashLines {
  readonly payoutsOre: number;
  readonly purchasesOre: number;
  readonly storeCompensationOre: number;
  readonly fixedCostsOre: number;
  readonly inOre: number;
  readonly outOre: number;
  /** In − ut. */
  readonly netOre: number;
}

/** En månad eller vecka. */
export interface CashBucket {
  /** 'ÅÅÅÅ-MM' eller 'ÅÅÅÅ-Www'. */
  readonly key: string;
  readonly range: Period;
  /** Sant om bucketen bara delvis ligger i intervallet. */
  readonly partial: boolean;
  readonly phase: "actual" | "forecast" | "mixed";
  readonly actual: CashLines;
  readonly forecast: CashLines;
  readonly total: CashLines;
  /** Saldo vid bucketens början och slut, om ingående saldo angavs. */
  readonly openingBalanceOre: number | null;
  readonly closingBalanceOre: number | null;
  readonly itemKeys: string[];
  readonly summary: string;
  readonly evidence: FinanceEvidence;
}

/** Inställningar för kassaflödet. Alla har standardvärden. */
export interface CashflowOptions {
  /** Fönster för snittförsäljningen som prognosen bygger på. Standard 28 dagar. */
  readonly forecastWindowDays?: number;
  /** Utbetalningsrytm. Standard: samma som den senaste utbetalningens period, annars månad. */
  readonly payoutCycle?: PayoutCycle;
  /** Dagar från periodens slut till utbetalning. Standard: som den senaste utbetalningen, annars 0. */
  readonly payoutLagDays?: number;
  /** Avgift i bp. Standard: inställningens `cardFeeBp`. */
  readonly feeBp?: number;
  /** Fast avgift per order i öre. Standard 0. */
  readonly fixedFeePerOrderOre?: number;
  /** Butiksersättningen för månad M betalas månaden M + detta. Standard 1. */
  readonly storeCompensationLagMonths?: number;
  /** Dag i månaden då butiksersättningen betalas. `null` = månadens sista dag. Standard `null`. */
  readonly storeCompensationDueDay?: number | null;
  /** Saldo på kontot vid intervallets början. `null` = visa inget saldo. */
  readonly openingBalanceOre?: number | null;
}

/** Indata till `cashflow`. */
export interface CashflowInput extends EconomicsSources {
  readonly orders: readonly OrderLine[];
  readonly payouts: readonly Payout[];
  readonly purchases: readonly Purchase[];
  readonly fixedCosts: readonly FixedCost[];
  /**
   * Faktiska betalningar till butiker. Saknas listan antas butiksersättningen betald enligt
   * avtal på förfallodagen. Anges den (även tom) ersätter varje betalning beräkningen för sin
   * butik och månad, och en förfallen ersättning utan betalning läggs som försenad i morgon.
   */
  readonly storePayments?: readonly StorePayment[];
  /** I dag. Flöden med datum ≤ i dag är faktiska, senare är prognos. */
  readonly asOf: IsoDate;
  /** Intervallet som visas, t.ex. 3 månader bakåt och 3 framåt. */
  readonly range: Period;
  readonly granularity: CashGranularity;
  readonly options?: CashflowOptions;
}

/** Underlaget för prognosen. */
export interface CashForecastBasis {
  /** Fönstret som snittet räknas på (kortat om försäljningen startade senare). */
  readonly window: Period | null;
  readonly windowDays: number;
  readonly windowOrders: number;
  readonly windowSalesOre: number;
  readonly windowCommissionOre: number;
  readonly payoutCycle: PayoutCycle;
  readonly payoutLagDays: number;
}

/** Resultatet av `cashflow`. */
export interface CashflowResult {
  readonly range: Period;
  readonly asOf: IsoDate;
  readonly granularity: CashGranularity;
  readonly buckets: CashBucket[];
  readonly items: CashItem[];
  readonly totals: {
    readonly actual: CashLines;
    readonly forecast: CashLines;
    readonly total: CashLines;
  };
  readonly basis: CashForecastBasis;
  /** Antagandena i klartext, för "Så räknas prognosen". */
  readonly assumptions: string[];
  /** Lägsta saldo (om ingående saldo angavs). */
  readonly lowestBalance: { readonly bucketKey: string; readonly balanceOre: number } | null;
  readonly summary: string;
  readonly evidence: FinanceEvidence;
}
