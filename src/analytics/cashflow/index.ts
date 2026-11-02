/**
 * Kassaflöde och fasta kostnader (fas 9).
 *
 * cashflow(input) ger faktiskt och prognostiserat kassaflöde per månad eller vecka.
 * accrueFixedCosts och profitabilityWithFixedCosts visar hur fasta kostnader räknas in i
 * lönsamheten (fördelade per automat efter intäkt eller lika).
 */

export {
  cashflow,
  inferPayoutCycle,
  storePaymentMonth,
  sumCashItems,
  CASHFLOW_DEFAULTS,
  CASH_FLOW_KINDS,
  EMPTY_CASH_LINES,
} from "./cashflow";
export {
  accrueFixedCosts,
  assertFixedCost,
  fixedCostLabel,
  fixedCostOccurrences,
  profitabilityWithFixedCosts,
  FIXED_UNALLOCATED_KEY,
  INTERVAL_MONTHS,
} from "./fixed-costs";
export type {
  AccruedFixedCost,
  CashBucket,
  CashFlowKind,
  CashflowInput,
  CashflowOptions,
  CashflowResult,
  CashForecastBasis,
  CashGranularity,
  CashItem,
  CashLines,
  CashPhase,
  FixedCost,
  FixedCostAccrual,
  FixedCostAllocation,
  FixedCostAllocationInput,
  FixedCostAllocationMethod,
  FixedCostInterval,
  FixedCostOccurrence,
  FixedCostRow,
  PayoutCycle,
  Purchase,
  StorePayment,
} from "./types";
