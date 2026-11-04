/**
 * Försäljningsprognos per titel × automat: veckodagsjusterat, viktat glidande medel med
 * trend, osäkerhetsintervall från backtestens residualer och träffsäkerhet (WAPE, MAPE, bias).
 * Varje prognos returnerar sina komponenter och sitt underlag.
 */

export {
  BIAS_MIN_FACTOR_BP,
  biasCorrectionBp,
  explainComponents,
  FORECAST_DEFAULTS,
  forecastHistoryPeriod,
  forecastSales,
  horizonText,
  overallAccuracy,
  resolveForecastOptions,
  Z_BY_COVERAGE_BP,
} from "./forecast";
export {
  fitModel,
  predictDay,
  type DailyHistory,
  type DayPrediction,
  type ModelSettings,
} from "./model";
export {
  accuracyMetrics,
  backtestHistory,
  residualVariance,
  type BacktestSettings,
} from "./backtest";
export {
  approxKr,
  isqrtRound,
  MILLI,
  packs,
  packsOneDecimal,
  type PlanEvidence,
  type PlanFigure,
  type PlanFigureUnit,
} from "./common";
export type * from "./types";
