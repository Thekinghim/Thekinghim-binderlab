/**
 * Marknadspriser och prissättning: inköpsprisernas utveckling och ovanliga inköp
 * (median + MAD), upptäckta prisändringar, effekten av en prisändring (difference-in-
 * differences med placebo) och förslag på pristester märkta som experiment.
 *
 * Gemensam hjälp för releaser och sortiment (underlag, bidrag per order, robust statistik)
 * finns också här.
 */

export {
  bpOf,
  byDateThenId,
  ceilRatio,
  compareStrings,
  floorRatio,
  hundredthsFixed,
  hundredthsOf,
  intOption,
  listText,
  marketEvidence,
  modalAmount,
  orderContributions,
  pctAbs,
  relativeChangeBp,
  signedTenths,
  tenthsOf,
  tenthsText,
  type MarketEvidence,
} from "./common";
export { MAD_CONSISTENCY_E4, median, medianAbsoluteDeviation, robustZ } from "./robust";
export {
  flagPurchaseAnomalies,
  purchasePriceTrends,
  type AnomalyOptions,
  type MarketPriceInput,
  type MonthlyPurchasePrice,
  type NamedRef,
  type PurchaseAnomaly,
  type PurchaseRecord,
  type SupplierPriceSummary,
  type TitlePriceTrend,
} from "./market";
export {
  detectPriceChanges,
  MAX_PLAUSIBLE_ELASTICITY,
  priceChangeEffect,
  RAMP_DAYS,
  type DetectPriceChangeOptions,
  type PlaceboResult,
  type PriceChangeEffect,
  type PriceChangeEffectInput,
  type PriceChangeEvent,
  type PriceEffectVerdict,
} from "./price-changes";
export {
  proposePriceTests,
  type PriceTestEvaluation,
  type PriceTestInput,
  type PriceTestProposal,
} from "./experiments";
