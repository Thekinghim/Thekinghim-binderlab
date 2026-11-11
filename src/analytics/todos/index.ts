/**
 * Att göra: punkter som beräknas automatiskt ur order, lager, priser, rapporter, avtal och
 * larm.
 *
 * computeTodos(input, now) kör alla regler och sorterar efter brådska. Varje punkt har en
 * stabil nyckel och ett fingerprint (se dismissals.ts) och bär sitt underlag (evidence).
 * Reglerna är rena funktioner utan I/O; `now` är den enda tidskällan.
 */

import { agreementGapTodos, mergeAgreementTodos } from "./agreement-gaps";
import { alertTodos } from "./alerts";
import { createTodoContext, sortTodos } from "./context";
import { contractTodos } from "./contracts";
import { duplicateTitleTodos } from "./duplicates";
import { missingContractTodos } from "./missing-contract";
import { missingPriceTodos } from "./missing-price";
import { mysteryCostTodos, mysteryDrifts, unpricedMysteryTitles } from "./mystery-cost";
import { priceAdviceTodos } from "./price-advice";
import { refillTodos } from "./refill";
import type { WeekShare } from "../sellout";

import { reportReviewTodos } from "./report-review";
import { reportTodos } from "./reports";
import { silentTitleTodos } from "./silent-title";
import { missingSettlementTodos, settlementTodos } from "./settlements";
import { staleMachineTodos } from "./stale-machine";
import { stockCountTodos } from "./stock-count";
import { teamTodos } from "./team";
import type { TodoInput, TodoItem } from "./types";

export interface ComputeTodosOptions {
  /**
   * Veckans form per automat ur laddaren (loadWeekShapes). Alla sidor skickar samma karta, så
   * att samma fack får samma slutdag överallt. Utelämnad: formen räknas ur `input.orders`.
   */
  readonly weekShares?: ReadonlyMap<string, WeekShare> | null;
}

/**
 * Alla punkter i Att göra, sorterade efter brådska (se `sortTodos`).
 * `now` är en tidpunkt (Date, ms eller ISO 8601 med tidszon); dagens affärsdatum räknas i
 * organisationens tidszon (standard Europe/Stockholm).
 */
export function computeTodos(
  input: TodoInput,
  now: Date | string | number,
  opts: ComputeTodosOptions = {},
): TodoItem[] {
  const ctx = createTodoContext(input, now);
  const stale = staleMachineTodos(ctx);
  const staleMachines = new Set(stale.flatMap((t) => t.evidence.machineIds));
  // Med besöksplanens regel: en titel som ska fyllas på senast i dag står under "I dag".
  const refills = refillTodos(ctx, {
    visitDue: true,
    ...(opts.weekShares ? { weekShares: opts.weekShares } : {}),
  });
  const refillStake = new Map(
    refills.map((t) => [t.key.slice("refill:".length), t.atStakeOre ?? 0] as const),
  );
  // En butik utan kontrakt och avtal: en punkt (Skapa kontrakt lägger in avtalet).
  // Ett mystery pack utan inköpspris: en punkt (kalkylens), inte två.
  const drifts = mysteryDrifts(ctx);
  const unpricedMystery = unpricedMysteryTitles(drifts);
  const deals = mergeAgreementTodos(missingContractTodos(ctx), agreementGapTodos(ctx));
  return sortTodos([
    ...refills,
    ...stale,
    ...silentTitleTodos(ctx, staleMachines, refillStake),
    ...alertTodos(ctx, staleMachines),
    ...reportReviewTodos(ctx),
    ...reportTodos(ctx),
    ...settlementTodos(ctx),
    ...missingSettlementTodos(ctx),
    ...deals.agreements,
    ...contractTodos(ctx),
    ...deals.contracts,
    ...missingPriceTodos(ctx).filter(
      (t) => !t.evidence.titleIds.some((id) => unpricedMystery.has(id)),
    ),
    ...mysteryCostTodos(ctx, drifts),
    ...priceAdviceTodos(ctx),
    ...duplicateTitleTodos(ctx),
    ...teamTodos(ctx),
    ...stockCountTodos(ctx),
  ]);
}

export { applyDismissals, obsoleteDismissals } from "./dismissals";
export {
  assortmentKey,
  isRetiredRefill,
  retiredPairs,
  retiredTitles,
  withoutRetiredRefills,
  type SlotPeriod,
} from "./assortment";
export { sortTodos, urgencyOf, TODO_DEFAULTS, HORIZON_DAYS } from "./context";
export {
  compareTitles,
  damerauLevenshtein,
  normalizeTitle,
  type DuplicateReason,
  type TitleComparison,
} from "./similarity";
export {
  businessDateAt,
  clockTimeAt,
  parseInstant,
  startOfBusinessDate,
  tryParseInstant,
  DEFAULT_TIME_ZONE,
} from "./time";
export { mergeProposals } from "./duplicates";
export { ACTION_ALERT_KINDS, alertLink } from "./alerts";
export { contractLink, CONTRACT_NOW_DAYS, CONTRACT_SOON_DAYS } from "./contracts";
export { createContractLink, storeContractLink } from "./missing-contract";
export { LOST_REVENUE_FIGURE, prioritizeByLostSales } from "./lost-sales";
export { reportDeadline } from "./reports";
export { reviewLink } from "./report-review";
export { settlementDue, settlementLink, SETTLEMENT_DUE_DAY } from "./settlements";
export { agreementLink } from "./agreement-gaps";
export { todoInScope, type ScopeMachine, type TodoScope } from "./scope";
export { missingPriceFingerprint } from "./missing-price";
export { mysteryCostLink } from "./mystery-cost";
export { PRICE_ADVICE_LINK, priceAdviceFor } from "./price-advice";
export {
  isFullSlot,
  refillFingerprint,
  VISIT_BUFFER_DAYS,
  withCapacities,
  withSlotAlerts,
} from "./refill";
export { silentTitles, type SilentTitle } from "./silent-title";
export { INVITE_LINK } from "./team";
export {
  STOCK_COUNT_REMINDER_DAYS,
  stockCountAge,
  stockCountLink,
  type StockCountAge,
} from "./stock-count";
export {
  countWithVisits,
  entryLevel,
  groupVisits,
  refillMachineOf,
  visitTitle,
  visitWhen,
  type TodoEntry,
  type TodoVisit,
  type VisitPlanDays,
} from "./visits";
export type * from "./types";
