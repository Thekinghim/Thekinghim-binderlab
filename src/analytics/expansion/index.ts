/**
 * Expansion: enhetsekonomi sida vid sida, likhet mellan butiker, uppskattning för nya
 * platser och expansionspipeline. Allt bygger på src/domain (lönsamhet per butik,
 * enhetsekonomi per automat) och är rena funktioner utan I/O.
 */

export {
  assertNonNegative,
  assertRateBp,
  fig,
  hundredths,
  monthUnits,
  MONTHS_PER_YEAR,
  orderTrail,
  perMachineMonth,
  Ratio,
  scenarioEvidence,
  signedKr,
  signedPct,
  weightedMean,
  type OrderTrail,
  type ScenarioEvidence,
  type ScenarioFigure,
  type ScenarioFigureUnit,
} from "./common";
export {
  DEFAULT_SIMILARITY_WEIGHTS,
  normalizeAttribute,
  numericMatchBp,
  rankBySimilarity,
  storeSimilarity,
  type SimilarityAttribute,
  type SimilarityPart,
  type SimilarityWeights,
  type StoreSimilarity,
} from "./similarity";
export { siteHistories, windowEnding } from "./site-history";
export {
  annualReturnBp,
  estimateConfidence,
  estimateSite,
  listText,
  paybackTenths,
  paybackText,
  SITE_ESTIMATE_DEFAULTS,
  totalInvestment,
  type SiteEstimateArgs,
  type SiteEstimateOptions,
} from "./estimate";
export {
  compareUnitEconomics,
  type UnitEconomicsComparison,
  type UnitEconomicsComparisonRow,
} from "./unit-economics-compare";
export {
  expansionPipeline,
  type ExpansionLead,
  type ExpansionPipelineInput,
  type LeadPotential,
  type LeadStage,
} from "./pipeline";
export type * from "./types";
