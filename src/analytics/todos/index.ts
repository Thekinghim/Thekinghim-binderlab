/**
 * Att göra: punkter som beräknas automatiskt ur order, lager, priser och rapporter.
 *
 * computeTodos(input, now) kör alla regler och sorterar efter brådska. Varje punkt har en
 * stabil nyckel och ett fingerprint (se dismissals.ts) och bär sitt underlag (evidence).
 * Reglerna är rena funktioner utan I/O; `now` är den enda tidskällan.
 */

import { createTodoContext, sortTodos } from "./context";
import { duplicateTitleTodos } from "./duplicates";
import { missingPriceTodos } from "./missing-price";
import { refillTodos } from "./refill";
import { reportTodos } from "./reports";
import { staleMachineTodos } from "./stale-machine";
import type { TodoInput, TodoItem } from "./types";

/**
 * Alla punkter i Att göra, sorterade efter brådska (se `sortTodos`).
 * `now` är en tidpunkt (Date, ms eller ISO 8601 med tidszon); dagens affärsdatum räknas i
 * organisationens tidszon (standard Europe/Stockholm).
 */
export function computeTodos(input: TodoInput, now: Date | string | number): TodoItem[] {
  const ctx = createTodoContext(input, now);
  return sortTodos([
    ...refillTodos(ctx),
    ...staleMachineTodos(ctx),
    ...reportTodos(ctx),
    ...missingPriceTodos(ctx),
    ...duplicateTitleTodos(ctx),
  ]);
}

export { applyDismissals, obsoleteDismissals } from "./dismissals";
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
export { missingPriceFingerprint } from "./missing-price";
export { refillFingerprint } from "./refill";
export type * from "./types";
