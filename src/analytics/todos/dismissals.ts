/**
 * Avbockning av punkter i Att göra.
 *
 * En avbockning sparas som (nyckel, fingerprint). Den döljer punkten så länge punkten har
 * samma nyckel OCH samma fingerprint. Ändras orsakens tillstånd (t.ex. lagret tog slut,
 * en ny påfyllning registrerades, automaten sålde och tystnade igen, ett nytt utskick
 * misslyckades) får punkten ett nytt fingerprint och visas igen.
 */

import type { TodoDismissal, TodoItem } from "./types";

function dismissalId(key: string, fingerprint: string): string {
  return `${key}\u0000${fingerprint}`;
}

/** Punkterna som ska visas: de som inte har en avbockning med samma nyckel och fingerprint. Ordningen behålls. */
export function applyDismissals(
  todos: readonly TodoItem[],
  dismissals: readonly TodoDismissal[],
): TodoItem[] {
  const dismissed = new Set(dismissals.map((d) => dismissalId(d.key, d.fingerprint)));
  return todos.filter((t) => !dismissed.has(dismissalId(t.key, t.fingerprint)));
}

/**
 * Avbockningar som inte längre döljer något: orsaken är löst (nyckeln saknas) eller har
 * ändrats (annat fingerprint). De kan raderas.
 */
export function obsoleteDismissals(
  todos: readonly TodoItem[],
  dismissals: readonly TodoDismissal[],
): TodoDismissal[] {
  const current = new Set(todos.map((t) => dismissalId(t.key, t.fingerprint)));
  return dismissals.filter((d) => !current.has(dismissalId(d.key, d.fingerprint)));
}
