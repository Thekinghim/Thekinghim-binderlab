/**
 * Små textbyggare för Hem (affärsdatum och öre till text). Bara format.ts, så att
 * klientkomponenterna kan använda dem utan att dra in beräkningslagret.
 */

import { formatDate, formatPercent, formatSek } from "@/lib/format";

type IsoDate = string;

/** 'ÅÅÅÅ-MM-DD' → Date mitt på dagen (samma kalenderdag i alla tidszoner), för format.ts. */
export function dateOf(date: IsoDate): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
}

/** Belopp i öre som hela kronor: "79 987 kr". */
export function kr(ore: number): string {
  return formatSek(ore / 100);
}

/** Marginal i bp som procent med en decimal: "23,7 %". */
export function marginText(bp: number): string {
  return formatPercent(bp / 10_000, 1);
}

/** "1 nov." (året bara när det inte är samma som i dag). */
export function dayText(date: IsoDate, today: IsoDate): string {
  return formatDate(dateOf(date), { year: "auto", now: dateOf(today) });
}

const WEEKDAYS = ["sön", "mån", "tis", "ons", "tor", "fre", "lör"] as const;

/** "lör 24 okt." */
export function weekdayDayText(date: IsoDate, today: IsoDate): string {
  return `${WEEKDAYS[dateOf(date).getDay()] ?? ""} ${dayText(date, today)}`;
}

/** Lägger till punkt om meningen inte redan slutar med en (t.ex. "24 okt."). */
export function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}
