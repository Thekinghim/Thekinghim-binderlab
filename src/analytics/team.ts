/**
 * Vem gör vad: ansvarig per automat ("Jag" / "Delägaren" / "Båda") och tilldelning av
 * punkter i Att göra. Rena funktioner utan I/O.
 *
 *   ansvarig   = machines.responsible_user_id; null = Båda (standard)
 *   "Mina"     = automater där jag är ansvarig eller där ingen är vald (Båda)
 *   tilldelad  = todo_assignments (uttrycklig, null = Båda) före automatens ansvariga
 *                (punkter för exakt en automat); annars Båda
 */

/** En person som fyller på (ägare, admin eller påfyllare). */
export interface TeamMember {
  readonly userId: string;
  readonly name: string;
}

/** Ett val i listan: "" = Båda. */
export interface PersonOption {
  readonly value: string;
  readonly label: string;
}

/** Värdet för Båda i formulär (tom sträng, sparas som null). */
export const BOTH = "";

/** Sant när automaten (eller punkten) är min: jag är ansvarig eller ingen är vald. */
export function isMine(responsible: string | null | undefined, me: string): boolean {
  return !responsible || responsible === me;
}

/** "Jag", personens namn, "Delägaren" (namn saknas) eller "Båda". */
export function personLabel(
  userId: string | null | undefined,
  me: string,
  team: readonly TeamMember[],
): string {
  if (!userId) return "Båda";
  if (userId === me) return "Jag";
  const name = team.find((t) => t.userId === userId)?.name.trim();
  return name || "Delägaren";
}

/**
 * Valen i ordningen Jag, övriga (efter namn), Båda. `current` tas med även om personen inte
 * längre fyller på, så att ett sparat val inte försvinner ur listan.
 */
export function personOptions(
  me: string,
  team: readonly TeamMember[],
  current: string | null = null,
): PersonOption[] {
  const others = team
    .filter((t) => t.userId !== me)
    .sort((a, b) => a.name.localeCompare(b.name, "sv") || (a.userId < b.userId ? -1 : 1));
  const out: PersonOption[] = [{ value: me, label: "Jag" }];
  for (const o of others) out.push({ value: o.userId, label: personLabel(o.userId, me, team) });
  if (current && !out.some((o) => o.value === current)) {
    out.push({ value: current, label: personLabel(current, me, team) });
  }
  out.push({ value: BOTH, label: "Båda" });
  return out;
}

/** Hur punkten fick sin ansvariga. */
export type AssigneeSource = "assigned" | "machine" | "none";

export interface Assignee {
  /** null = Båda. */
  readonly userId: string | null;
  readonly source: AssigneeSource;
}

/**
 * Den ansvariga för en punkt: uttrycklig tilldelning först, annars automatens ansvariga
 * när punkten gäller exakt en automat, annars Båda.
 */
export function todoAssignee(
  item: { readonly key: string; readonly machineIds: readonly string[] },
  assignments: ReadonlyMap<string, string | null>,
  responsibles: ReadonlyMap<string, string | null>,
): Assignee {
  if (assignments.has(item.key)) {
    return { userId: assignments.get(item.key) ?? null, source: "assigned" };
  }
  const machines = [...new Set(item.machineIds)];
  if (machines.length === 1) {
    const r = responsibles.get(machines[0] as string) ?? null;
    if (r) return { userId: r, source: "machine" };
  }
  return { userId: null, source: "none" };
}
