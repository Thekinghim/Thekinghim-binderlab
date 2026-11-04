/**
 * Sortimentet per automat: vilka titlar som har gått ur sortimentet (utgångna titlar).
 *
 * Ett par (automat, titel) är utgånget när det har perioder i sortimentet
 * (`machine_slots`, läst via RPC:n `lager_slot_periods`), ingen av dem gäller i dag och
 * ingen börjar senare. En utgången titel fylls inte på: den säljs ut. Ett par utan
 * perioder räknas aldrig som utgånget (sortimentet är inte registrerat).
 *
 * Samma regel gäller Lager (matrisen och packlistan), Drift (besöksplanen) och Att göra
 * (påfyllningspunkterna och menyns räknare), så att de aldrig är oense om vad som ska
 * fyllas på. Ren modul utan I/O.
 */

import type { IsoDate } from "@/domain";

import type { TodoItem } from "./types";

/** En period i sortimentet för en titel i en automat. */
export interface SlotPeriod {
  readonly machineId: string;
  readonly titleId: string;
  readonly validFrom: IsoDate;
  /** Sista dagen, eller null (tills vidare). */
  readonly validTo: IsoDate | null;
}

/** Nyckeln för ett par (automat, titel) i mängden från `retiredPairs`. */
export function assortmentKey(machineId: string, titleId: string): string {
  return `${machineId}\u0000${titleId}`;
}

/** Par (automat, titel) som har gått ur sortimentet i dag, som `assortmentKey`. */
export function retiredPairs(periods: readonly SlotPeriod[], today: IsoDate): Set<string> {
  const current = new Set<string>();
  const seen = new Set<string>();
  for (const p of periods) {
    const k = assortmentKey(p.machineId, p.titleId);
    seen.add(k);
    if (p.validTo === null || p.validTo >= today) current.add(k);
  }
  return new Set([...seen].filter((k) => !current.has(k)));
}

/**
 * Titlar som gått ur sortimentet i alla automater där de funnits (samma regel som
 * `retiredPairs`): minst en period, ingen som gäller i dag eller senare i någon automat.
 * De köps inte in och får ingen prognos; pack hemma "ligger still".
 */
export function retiredTitles(periods: readonly SlotPeriod[], today: IsoDate): Set<string> {
  const current = new Set<string>();
  const seen = new Set<string>();
  for (const p of periods) {
    seen.add(p.titleId);
    if (p.validTo === null || p.validTo >= today) current.add(p.titleId);
  }
  return new Set([...seen].filter((t) => !current.has(t)));
}

/**
 * Är punkten en påfyllning (eller en tyst titel) av en utgången titel? En utgången titel
 * säljs ut och ska varken fyllas på eller larma när den slutar sälja.
 */
export function isRetiredRefill(item: TodoItem, retired: ReadonlySet<string>): boolean {
  if ((item.kind !== "refill" && item.kind !== "silent-title") || retired.size === 0) return false;
  const machineId = item.evidence.machineIds[0];
  const titleId = item.evidence.titleIds[0];
  return (
    machineId !== undefined &&
    titleId !== undefined &&
    retired.has(assortmentKey(machineId, titleId))
  );
}

/** Tar bort påfyllningar av utgångna titlar. */
export function withoutRetiredRefills<T extends TodoItem>(
  items: readonly T[],
  retired: ReadonlySet<string>,
): T[] {
  return retired.size === 0 ? [...items] : items.filter((t) => !isRetiredRefill(t, retired));
}
