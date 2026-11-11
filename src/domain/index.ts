/**
 * Beräkningslagret: rena funktioner utan databas och utan tidszonsberoende.
 * Formler, avrundning och fördelning beskrivs i docs/berakningar.md.
 */

export type {
  Bp,
  CommissionBase,
  EconomicsSources,
  GroupBy,
  IsoDate,
  IsoMonth,
  LossTreatment,
  MachineInvestment,
  OrderLine,
  Ore,
  OwnerShare,
  Period,
  Placement,
  ProfitabilityInput,
  PurchasePrice,
  Settings,
  StoreAgreement,
} from "./types";

export { DomainError, type DomainErrorCode } from "./errors";

export {
  addDays,
  addMonths,
  assertIsoDate,
  assertPeriod,
  compareDates,
  dayOfWeek,
  daysBetween,
  daysInMonth,
  eachDay,
  eachMonth,
  formatIsoDate,
  fromDayNumber,
  inPeriod,
  intersectPeriods,
  isIsoDate,
  isLeapYear,
  isoWeekLabel,
  maxDate,
  minDate,
  monthEnd,
  monthOf,
  monthPeriod,
  monthsElapsed,
  monthStart,
  overlapDays,
  parseIsoDate,
  parseIsoMonth,
  periodDays,
  previousPeriod,
  toDayNumber,
  weekOf,
  weekStart,
  type DateParts,
  type IsoWeek,
} from "./dates";

export {
  allocateLargestRemainder,
  allocateLargestRemainderBig,
  applyBp,
  BP_SCALE,
  ceilDiv,
  floorDiv,
  mulDivRound,
  ratioBp,
  roundHalfUp,
  sumOre,
} from "./money";

export {
  applyPriceChange,
  priceChangeImpact,
  priceHistory,
  PriceIndex,
  priceOn,
  type PriceChange,
  type PriceChangeImpact,
  type PriceHistoryEntry,
} from "./prices";

export { agreementOn, AgreementIndex, PlacementIndex, storeOn } from "./placements";
export { agreementGaps, type AgreementGap } from "./agreement-gaps";

export {
  createEconomicsContext,
  orderEconomics,
  vatOfGross,
  type EconomicsContext,
  type OrderEconomics,
} from "./economics";

export { rentByStoreMonth, type RentSegment, type StoreMonthRent } from "./rent";
export {
  DEFAULT_PROFIT_SHARE_BP,
  VMB_VAT_PERCENT,
  isProfitSplit,
  profitSplit,
  vmbVatOfMargin,
  type ProfitSplitInput,
  type ProfitSplitResult,
} from "./profit-split";

export {
  buildLedger,
  type Ledger,
  type LedgerDiagnostics,
  type LedgerEntry,
  type StoreMonthSplit,
  type UnallocatedRent,
  type VmbMonth,
} from "./ledger";

export {
  VMB_RATE_PERCENT,
  vmbApplies,
  vmbChain,
  vmbVat,
  type VmbInput,
  type VmbMonthInput,
  type VmbResult,
} from "./vmb";

export {
  CALC_VERSION,
  NO_MACHINE_KEY,
  NO_STORE_KEY,
  profitability,
  profitabilityViews,
  summarizeLedger,
  TOTAL_KEY,
  UNALLOCATED_KEY,
  vmbPreliminary,
  type ProfitabilityOptions,
  type ProfitabilityResult,
  type ProfitabilityRow,
  type ProfitabilityWaterfall,
  type RowKind,
  type UnpricedSummary,
  type UnpricedTitle,
  type VmbSummary,
  type WaterfallKey,
  type WaterfallStep,
} from "./profitability";

export {
  averageOrderValueOre,
  cardFees,
  changeBp,
  costOfGoods,
  grossRevenue,
  keyMetrics,
  marginBp,
  orderCount,
  profit,
  revenue,
  storeCompensation,
  topContributor,
  vat,
  type CostOfGoods,
  type KeyMetrics,
  type StoreCompensation,
  type TopContributor,
} from "./metrics";

export { titleEconomics, type TitleEconomics, type TitleEconomicsInput } from "./titles";

export {
  dailyUnits,
  daysOfStockLeft,
  salesVelocity,
  salesVelocitySeries,
  stockoutDate,
  type DailyUnits,
  type SalesVelocity,
  type VelocityWindow,
} from "./velocity";

export {
  depreciation,
  MONTH_LCM,
  unitEconomics,
  type MachineUnitEconomics,
  type UnitEconomicsInput,
} from "./unit-economics";

export { allocateToOwners, type OwnerAllocation } from "./owners";

export { entryProfitOre, storeShareDeducted, storeShareInView } from "./store-share";

export {
  MYSTERY_TOP_UP_WARNING,
  mysteryBatch,
  mysteryBatchesToPack,
  mysteryCapacityShort,
  mysteryCapacityText,
  mysteryEmptyText,
  mysteryNeedsRefill,
  mysteryRefillProblem,
  mysteryRefillQty,
  wholeBatches,
  MYSTERY_PACK_HORIZON_DAYS,
  type MysteryDueSlot,
  type MysteryPackInput,
  type MysteryPackPlan,
  type MysterySlotInput,
} from "./mystery-refill";

export {
  mysteryCostDrifts,
  recipeCost,
  type MysteryCostDrift,
  type MysteryRecipeRef,
  type RecipeCost,
  type RecipeCostItem,
  type RecipeCostLine,
} from "./mystery-cost";

export {
  currentSalePriceDetails,
  currentSalePrices,
  DEFAULT_TARGET_MARGIN_BP,
  isPricePoint,
  MAX_TARGET_MARGIN_BP,
  MIN_TARGET_MARGIN_BP,
  PRICE_ADVICE_WINDOW_DAYS,
  priceAdvice,
  suggestedPriceOre,
  unitMargin,
  type CurrentSalePrice,
  type PriceAdvice,
  type PriceAdviceInput,
  type SalePriceOrder,
  type UnitMargin,
} from "./price-advice";
