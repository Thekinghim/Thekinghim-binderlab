/**
 * Avtal att säga upp eller omförhandla: påminnelserna från @/analytics/contracts
 * (`contractReminders`, samma regel som sidan Avtal) som punkter i Att göra.
 *
 * Bara avtal som kräver något nu (`due`): påminnelsen har kommit (standard 90 dagar före
 * sista uppsägningsdag), eller uppsägningstiden har passerat för ett avtal som inte
 * förlängs. Ett avtal som redan har ett efterföljande avtal utan lucka tas inte med.
 *
 *   dagar kvar = till sista uppsägningsdag ('due') eller till avtalets slut (passerad)
 *   nivå       = 'now' ≤ 7 dagar, 'soon' ≤ 30 dagar, annars 'later'
 *   nyckel     = 'contract:<avtal>:<slut>' och fingerprint från påminnelsen (ändras med
 *                status, slut, uppsägningsdag och efterföljande avtal)
 */

import { contractReminders } from "@/analytics/contracts/contracts";
import type { Contract, ContractReminder } from "@/analytics/contracts/types";
import { DomainError } from "@/domain";
import { evidence } from "./common";
import { urgencyOf, type TodoContext } from "./context";
import type { TodoItem, TodoLevel } from "./types";

/** Dagar kvar då punkten blir 'now' respektive 'soon'. */
export const CONTRACT_NOW_DAYS = 7;
export const CONTRACT_SOON_DAYS = 30;

/** Länk till avtalet på sidan Avtal. */
export function contractLink(contractId: string): string {
  return `/avtal#avtal-${encodeURIComponent(contractId)}`;
}

function remindersOf(ctx: TodoContext, contracts: readonly Contract[]): ContractReminder[] {
  const run = (list: readonly Contract[]) =>
    contractReminders({
      contracts: list,
      asOf: ctx.today,
      stores: ctx.input.stores ?? [],
      options: { reminderLeadDays: ctx.options.contractReminderDays },
    }).due;
  try {
    return run(contracts);
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    // Ett felaktigt avtal får inte dölja påminnelserna för de andra: ett i taget.
    const out: ContractReminder[] = [];
    for (const c of contracts) {
      try {
        out.push(...run([c]));
      } catch (inner) {
        if (!(inner instanceof DomainError)) throw inner;
      }
    }
    return out;
  }
}

/** Punkter för avtal att säga upp eller omförhandla. */
export function contractTodos(ctx: TodoContext): TodoItem[] {
  const contracts = ctx.input.contracts ?? [];
  if (contracts.length === 0) return [];
  return remindersOf(ctx, contracts).map((r): TodoItem => {
    const days = r.status === "due" ? r.daysToDeadline : r.daysToEnd;
    const level: TodoLevel =
      days === null || days <= CONTRACT_NOW_DAYS
        ? "now"
        : days <= CONTRACT_SOON_DAYS
          ? "soon"
          : "later";
    return {
      key: r.key,
      fingerprint: r.fingerprint,
      kind: "contract",
      level,
      urgency: urgencyOf(level, null),
      atStakeOre: null,
      daysLeft: days,
      title: r.title,
      detail: r.detail,
      evidence: evidence({
        rule: r.evidence.rule,
        period: r.evidence.period,
        dates: r.evidence.dates,
        storeIds: r.evidence.storeIds,
        machineIds: r.evidence.machineIds,
        figures: r.evidence.figures,
      }),
      link: contractLink(r.contractId),
      action: {
        kind: "open-contract",
        label: "Öppna avtalet",
        params: { contractId: r.contractId },
      },
    };
  });
}
