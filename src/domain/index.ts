/**
 * Beräkningslagret: rena funktioner utan databas och utan tidszonsberoende.
 * Formler, avrundning och fördelning beskrivs i docs/berakningar.md.
 */

export type {
  Bp,
  EconomicsSources,
  GroupBy,
  IsoDate,
  IsoMonth,
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

export {
  createEconomicsContext,
  orderEconomics,
  vatOfGross,
  type EconomicsContext,
  type OrderEconomics,
} from "./economics";

export { rentByStoreMonth, type RentSegment, type StoreMonthRent } from "./rent";

export {
  buildLedger,
  type Ledger,
  type LedgerDiagnostics,
  type LedgerEntry,
  type UnallocatedRent,
} from "./ledger";

export {
  CALC_VERSION,
  NO_MACHINE_KEY,
  NO_STORE_KEY,
  profitability,
  profitabilityViews,
  summarizeLedger,
  TOTAL_KEY,
  UNALLOCATED_KEY,
  type ProfitabilityOptions,
  type ProfitabilityResult,
  type ProfitabilityRow,
  type ProfitabilityWaterfall,
  type RowKind,
  type UnpricedSummary,
  type UnpricedTitle,
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
