/**
 * Sortiment: försäljning per fack och vecka, likhet mellan automater, rekommendation per
 * automat (titlar och antal fack med väntad effekt i kr/vecka) och uppföljning före/efter.
 */

export {
  similarMachines,
  slotKey,
  slotPerformance,
  type MachineLevel,
  type MachineSimilarity,
  type SlotAssignment,
  type SlotPerformance,
  type SlotPerformanceInput,
  type SlotPerformanceResult,
} from "./performance";
export {
  recommendAssortment,
  type AssortmentChange,
  type AssortmentInput,
  type AssortmentLine,
  type AssortmentOptions,
  type MachineAssortmentRecommendation,
} from "./recommend";
export {
  assortmentFollowUp,
  type AssortmentFollowUp,
  type AssortmentFollowUpControl,
  type AssortmentFollowUpInput,
} from "./follow-up";
