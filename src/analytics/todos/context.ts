/**
 * Gemensamt sammanhang för reglerna i Att göra: dagens affärsdatum, inställningar,
 * namnuppslag och brådskevärdet.
 */

import { CONTRACT_DEFAULTS } from "@/analytics/contracts/contracts";
import { DEFAULT_TARGET_MARGIN_BP, DomainError, type IsoDate } from "@/domain";
import { machineNames, titleNames } from "./common";
import { businessDateAt, DEFAULT_TIME_ZONE, parseInstant } from "./time";
import type { TodoInput, TodoItem, TodoLevel, TodoOptions } from "./types";

/** Standardvärden för reglerna. */
export const TODO_DEFAULTS: Required<TodoOptions> = {
  timeZone: DEFAULT_TIME_ZONE,
  refillWindowDays: 14,
  refillThresholdCentidays: 250,
  staleHours: 48,
  unpricedWindowDays: 30,
  reportDueDay: null,
  contractReminderDays: CONTRACT_DEFAULTS.reminderLeadDays,
  targetMarginBp: DEFAULT_TARGET_MARGIN_BP,
};

/** Dagar framåt som "kronor i risk" räknas över. */
export const HORIZON_DAYS = 7;

/** Övre gräns för kronor i risk i brådskevärdet (öre), så att nivån alltid väger tyngst. */
export const URGENCY_LEVEL_SCALE = 1_000_000_000_000;

const LEVEL_RANK: Record<TodoLevel, number> = { now: 3, soon: 2, later: 1 };

/** Allt en regel behöver. */
export interface TodoContext {
  readonly input: TodoInput;
  readonly nowMs: number;
  /** Dagens affärsdatum i organisationens tidszon. */
  readonly today: IsoDate;
  readonly options: Required<TodoOptions>;
  readonly titleName: (id: string) => string;
  readonly machineName: (id: string) => string;
}

function assertPositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError(
      "invalid_input",
      `${label} måste vara ett positivt heltal, fick ${value}.`,
    );
  }
}

/** Bygger sammanhanget och kontrollerar inställningarna. */
export function createTodoContext(input: TodoInput, now: Date | string | number): TodoContext {
  const options: Required<TodoOptions> = { ...TODO_DEFAULTS, ...stripUndefined(input.options) };
  assertPositiveInteger(options.refillWindowDays, "Fönstret för påfyllning");
  assertPositiveInteger(options.refillThresholdCentidays, "Gränsen för påfyllning");
  assertPositiveInteger(options.staleHours, "Gränsen för stillastående automat");
  assertPositiveInteger(options.unpricedWindowDays, "Fönstret för saknade inköpspriser");
  assertPositiveInteger(options.contractReminderDays, "Påminnelsen för avtal");
  if (options.reportDueDay !== null)
    assertPositiveInteger(options.reportDueDay, "Sista dag för rapporter");
  const nowMs = parseInstant(now);
  return {
    input,
    nowMs,
    today: businessDateAt(nowMs, options.timeZone),
    options,
    titleName: titleNames(input.titles),
    machineName: machineNames(input.machines),
  };
}

function stripUndefined<T extends object>(value: T | undefined): Partial<T> {
  if (!value) return {};
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/**
 * Brådskevärdet: nivå × 10¹² + kronor i risk under 7 dagar (öre, högst 10¹² − 1).
 * Nivån väger alltid tyngst ('now' > 'soon' > 'later'); inom en nivå går större belopp först.
 */
export function urgencyOf(level: TodoLevel, atStakeOre: number | null): number {
  const stake = Math.min(Math.max(atStakeOre ?? 0, 0), URGENCY_LEVEL_SCALE - 1);
  return LEVEL_RANK[level] * URGENCY_LEVEL_SCALE + stake;
}

/**
 * Sorterar efter brådska: högst `urgency` först, sedan minst `daysLeft` (punkter utan
 * tidsgräns sist), sedan nyckeln, så att ordningen alltid är densamma.
 */
export function sortTodos(todos: readonly TodoItem[]): TodoItem[] {
  return [...todos].sort((a, b) => {
    if (a.urgency !== b.urgency) return b.urgency - a.urgency;
    const da = a.daysLeft ?? Number.MAX_SAFE_INTEGER;
    const db = b.daysLeft ?? Number.MAX_SAFE_INTEGER;
    if (da !== db) return da - db;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
}
