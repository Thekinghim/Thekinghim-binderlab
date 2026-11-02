/**
 * Rapportunderlag: rena funktioner som bygger innehållet i butiks-, bokförings- och
 * delägarrapporten, plus export till SIE 4 och Excel. Renderingen görs i
 * src/components/report.
 */

export type {
  Conclusion,
  Evidence,
  EvidenceFigure,
  EvidenceScope,
  FigureUnit,
  MachineEntity,
  NamedEntity,
  ReportSources,
} from "./types";

export {
  FLAT_CHANGE_BP,
  assertStoreReportSafe,
  buildStoreReport,
  type CompensationModel,
  type CompensationStep,
  type RentPart,
  type StoreComparison,
  type StoreCompensationBreakdown,
  type StoreMachine,
  type StoreReport,
  type StoreReportOptions,
  type StoreSales,
  type StoreTopTitle,
  type StoreWeek,
} from "./store-report";

export {
  buildAccountantReport,
  findOrderNumberGaps,
  gapsText,
  type AccountantDay,
  type AccountantMachineRow,
  type AccountantReport,
  type AccountantStoreRow,
  type AccountantTotals,
  type AccountantUnpricedTitle,
  type OrderNumberGap,
  type OrderNumberRange,
  type Reconciliation,
  type ReconciliationCheck,
  type SalesAmounts,
} from "./accountant-report";

export {
  RECORD_MIN_MONTHS,
  UNPRICED_NOTICE_BP,
  buildPartnerReport,
  totalRevenue,
  type InventoryLine,
  type InventoryValue,
  type OwnerPayout,
  type PartnerComparison,
  type PartnerEvent,
  type PartnerEventKind,
  type PartnerOwner,
  type PartnerReport,
  type PartnerReportOptions,
  type PartnerResult,
  type PartnerRow,
  type PartnerTrendMonth,
  type ProfitSplit,
} from "./partner-report";

export {
  buildSie4Text,
  exportSie4,
  sie4Verifications,
  sieAmount,
  sieString,
  type LedgerAccount,
  type LedgerAccountKey,
  type Sie4Options,
  type Sie4Transaction,
  type Sie4Verification,
} from "./sie4";

export { decodeCp437, encodeCp437 } from "./cp437";
export { buildAccountantWorkbook, COUNT_FORMAT, KRONOR_FORMAT } from "./excel";
export * from "./text";
