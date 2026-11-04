/**
 * Att göra: punkter som beräknas automatiskt ur order, lager, priser, rapporter, avtal och
 * larm.
 *
 * computeTodos(input, now) kör alla regler och sorterar efter brådska. Varje punkt har en
 * stabil nyckel och ett fingerprint (se dismissals.ts) och bär sitt underlag (evidence).
 * Reglerna är rena funktioner utan I/O; `now` är den enda tidskällan.
 */

import { alertTodos } from "./alerts";
import { createTodoContext, sortTodos } from "./context";
import { contractTodos } from "./contracts";
import { duplicateTitleTodos } from "./duplicates";
import { missingContractTodos } from "./missing-contract";
import { missingPriceTodos } from "./missing-price";
import { refillTodos } from "./refill";
import { reportReviewTodos } from "./report-review";
import { reportTodos } from "./reports";
import { silentTitleTodos } from "./silent-title";
import { settlementTodos } from "./settlements";
import { staleMachineTodos } from "./stale-machine";
import { teamTodos } from "./team";
import type { TodoInput, TodoItem } from "./types";

/**
 * Alla punkter i Att göra, sorterade efter brådska (se `sortTodos`).
 * `now` är en tidpunkt (Date, ms eller ISO 8601 med tidszon); dagens affärsdatum räknas i
 * organisationens tidszon (standard Europe/Stockholm).
 */
export function computeTodos(input: TodoInput, now: Date | string | number): TodoItem[] {
  const ctx = createTodoContext(input, now);
  const stale = staleMachineTodos(ctx);
  const staleMachines = new Set(stale.flatMap((t) => t.evidence.machineIds));
  // Med besöksplanens regel: en titel som ska fyllas på senast i dag står under "I dag".
  const refills = refillTodos(ctx, { visitDue: true });
  const refillStake = new Map(
    refills.map((t) => [t.key.slice("refill:".length), t.atStakeOre ?? 0] as const),
  );
  return sortTodos([
    ...refills,
    ...stale,
    ...silentTitleTodos(ctx, staleMachines, refillStake),
    ...alertTodos(ctx, staleMachines),
    ...reportReviewTodos(ctx),
    ...reportTodos(ctx),
    ...settlementTodos(ctx),
    ...contractTodos(ctx),
    ...missingContractTodos(ctx),
    ...missingPriceTodos(ctx),
    ...duplicateTitleTodos(ctx),
    ...teamTodos(ctx),
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
export { todoInScope, type ScopeMachine, type TodoScope } from "./scope";
export { missingPriceFingerprint } from "./missing-price";
export { refillFingerprint, VISIT_BUFFER_DAYS, withSlotAlerts } from "./refill";
export { silentTitles, type SilentTitle } from "./silent-title";
export { INVITE_LINK } from "./team";
export type * from "./types";
