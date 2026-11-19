/**
 * Stängda månader: ren logik och texter (ingen databas, inget Next).
 *
 * En månad stängs av appen när den är klar: när sista avräkningen för månaden markeras som
 * betald, eller när bokföringsmånaden markeras som skickad. I en stängd månad stoppar
 * databasen ändringar av inköpspriser, avtal, placeringar, lager, återbetalningar, fasta
 * kostnader, testköp och kortavgift (BL004). Order som kommer in sent sparas ändå och
 * flaggas. Ägaren kan öppna månaden igen, med en anledning.
 */

import type { IsoMonth } from "@/domain";

/** Vad som stängde månaden (sparas i period_closes.snapshot.app.trigger). */
export type CloseTrigger = "settlement_paid" | "bookkeeping_sent" | "manual";

export const CLOSE_TRIGGER_TEXT: Record<CloseTrigger, string> = {
  settlement_paid: "alla avräkningar är betalda",
  bookkeeping_sent: "bokföringen är skickad",
  manual: "stängd för hand",
};

export interface ClosedMonth {
  readonly month: IsoMonth;
  /** ISO-tid. */
  readonly closedAt: string;
  readonly trigger: CloseTrigger;
}

const MONTHS = [
  "januari",
  "februari",
  "mars",
  "april",
  "maj",
  "juni",
  "juli",
  "augusti",
  "september",
  "oktober",
  "november",
  "december",
];

/** "oktober 2026". */
export function monthLong(month: string): string {
  return `${MONTHS[Number(month.slice(5, 7)) - 1] ?? month} ${month.slice(0, 4)}`;
}

const cap = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Var ägaren öppnar månaden igen (står sist i varje besked om en stängd månad). */
export const REOPEN_HINT = "Ägaren kan öppna månaden igen under Butiker → Utbetalning.";

/**
 * Databasens besked "Inköpspriset påverkar en stängd månad (2026-10)." på enkel svenska:
 * "Oktober 2026 är stängd. Inköpspriset kan inte ändras där. Ägaren kan öppna månaden igen
 * under Butiker → Utbetalning." Andra texter lämnas som de är.
 */
export function closedMonthMessage(dbMessage: string): string {
  const m = /^(.+?) påverkar en stängd månad \((\d{4}-\d{2})\)\.?$/.exec(dbMessage.trim());
  if (!m) return dbMessage;
  return `${cap(monthLong(m[2]!))} är stängd. ${m[1]} kan inte ändras där. ${REOPEN_HINT}`;
}

/**
 * Raden som visas där priser, avtal, testköp och återbetalningar ändras:
 * "Stängt till och med oktober 2026. Där ändras inget." (null utan stängda månader).
 * Är månaderna inte i följd räknas de upp.
 */
export function closedMonthsLine(months: readonly string[]): string | null {
  if (months.length === 0) return null;
  const sorted = [...new Set(months)].sort();
  if (sorted.length === 1) return `${cap(monthLong(sorted[0]!))} är stängd. Där ändras inget.`;
  const names = sorted.map(monthLong);
  return `Stängda månader: ${names.slice(0, -1).join(", ")} och ${names[names.length - 1]}. Där ändras inget.`;
}

/** Är dagen (ÅÅÅÅ-MM-DD) i en stängd månad? */
export function isClosedDay(months: readonly string[], day: string): boolean {
  return months.includes(day.slice(0, 7));
}

/** Första månaden som inte är stängd, från och med `from` (t.ex. den här månaden bakåt sett). */
export function firstOpenMonth(months: readonly string[], latestCandidate: IsoMonth): IsoMonth {
  const closed = [...months].sort();
  const last = closed[closed.length - 1];
  if (!last) return latestCandidate;
  const [y, m] = last.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return next as IsoMonth;
}
