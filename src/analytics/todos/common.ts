/**
 * Gemensam hjälp för Att göra och Värt att veta: namn, länkar och underlag.
 */

import { compareDates, type IsoDate, type Period } from "@/domain";
import type { Evidence, EvidenceFigure, MachineRef, TitleRef } from "./types";

/** Sorterade unika strängar. */
export function uniqueSorted<T extends string>(values: Iterable<T>): T[] {
  return [...new Set(values)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Bygger ett underlag med sorterade, unika listor. Tomma listor om inget anges. */
export function evidence(e: {
  rule: string;
  period?: Period | null;
  orderIds?: Iterable<string>;
  dates?: Iterable<IsoDate>;
  titleIds?: Iterable<string>;
  machineIds?: Iterable<string>;
  storeIds?: Iterable<string>;
  recipientIds?: Iterable<string>;
  figures?: EvidenceFigure[];
}): Evidence {
  return {
    rule: e.rule,
    period: e.period ?? null,
    orderIds: uniqueSorted(e.orderIds ?? []),
    dates: uniqueSorted(e.dates ?? []).sort(compareDates),
    titleIds: uniqueSorted(e.titleIds ?? []),
    machineIds: uniqueSorted(e.machineIds ?? []),
    storeIds: uniqueSorted(e.storeIds ?? []),
    recipientIds: uniqueSorted(e.recipientIds ?? []),
    figures: e.figures ?? [],
  };
}

/** Namnuppslag med id som reserv, så att en saknad titel aldrig ger tom text. */
export function nameLookup(items: readonly { id: string; name: string }[]): (id: string) => string {
  const map = new Map(items.map((i) => [i.id, i.name.trim() || i.id]));
  return (id) => map.get(id) ?? id;
}

/** Titelnamn per id. */
export function titleNames(titles: readonly TitleRef[]): (id: string) => string {
  return nameLookup(titles);
}

/** Automatnamn per id. */
export function machineNames(machines: readonly MachineRef[]): (id: string) => string {
  return nameLookup(machines);
}

/**
 * Sant om automaten är i drift dagen `date`: inte arkiverad, `activeFrom` ≤ dagen
 * (eller okänd) och `activeTo` ≥ dagen (eller öppen).
 */
export function isMachineActive(machine: MachineRef, date: IsoDate): boolean {
  if (machine.archived) return false;
  if (machine.activeFrom !== null && machine.activeFrom > date) return false;
  if (machine.activeTo !== null && machine.activeTo < date) return false;
  return true;
}

function query(params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return q ? `?${q}` : "";
}

/** Länkar till sidorna i panelen. Samlade här så att adresserna kan ändras på ett ställe. */
export const links = {
  stock: (machineId: string, titleId: string) =>
    `/lager${query({ automat: machineId, titel: titleId })}`,
  purchasePrices: (titleId?: string) => `/inkopspriser${titleId ? query({ titel: titleId }) : ""}`,
  mergeTitles: (fromId: string, intoId: string) =>
    `/titlar${query({ slaihop: fromId, med: intoId })}`,
  machine: (machineId: string, period?: Period) =>
    `/automater/${encodeURIComponent(machineId)}${period ? query({ fran: period.start, till: period.end }) : ""}`,
  reports: (month: string, recipientId: string) =>
    `/rapporter${query({ period: month, mottagare: recipientId })}`,
  title: (titleId: string, period: Period) =>
    `/titlar/${encodeURIComponent(titleId)}${query({ fran: period.start, till: period.end })}`,
  profitabilityByTitle: (period: Period) =>
    `/lonsamhet${query({ grupp: "titel", fran: period.start, till: period.end })}`,
  salesDay: (date: IsoDate) => `/forsaljning${query({ fran: date, till: date })}`,
  salesWeekdays: (period: Period) =>
    `/forsaljning${query({ fran: period.start, till: period.end, vy: "veckodag" })}`,
};
