/**
 * "Vad Binderlab gett dig": påfyllning i tid, sparad tid, marginal och utveckling och de
 * bästa åtgärderna, räknat ur data som redan finns. Rena funktioner; reglerna står i
 * docs/berakningar.md, avsnitt 27.
 */

export {
  PRICE_ACTION_MIN_ORDERS,
  SAVED_SALES_MAX_DAYS,
  TASK_ASSUMPTIONS,
  TREND_MONTHS,
  taskAssumption,
  type AutomationKind,
  type TaskAssumption,
} from "./assumptions";
export {
  refillValue,
  type RefillMonthValue,
  type RefillSeriesValue,
  type RefillValueInput,
  type RefillValueResult,
} from "./refills";
export {
  minutesByMonth,
  timeSaved,
  type AutomationCount,
  type TimeSavedLine,
  type TimeSavedResult,
} from "./time";
export {
  keptOf,
  marginAndTrend,
  type MarginLine,
  type MarginMonth,
  type MarginResult,
  type StoreMarginLine,
} from "./margin";
export {
  bestActions,
  type AssortmentRef,
  type BestAction,
  type BestActionKind,
  type BestActionsInput,
  type LostSeriesRef,
  type TitleKeptRef,
  type UnpricedTitleRef,
} from "./actions";
