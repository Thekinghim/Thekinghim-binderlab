/**
 * Orderlistans dagsgrupper ("I dag · 6 order · 924 kr") och korta tider. Rent och
 * klientsäkert: raderna grupperas på affärsdagen i den ordning de står (nyaste först),
 * och antal och summa per dag kommer från servern (hela dagen, även rader som inte är
 * laddade än, utan testköp).
 */

import { addDays, type IsoDate } from "@/domain";

import type { OrderDayTotal, OrderRow } from "./types";

export interface DayGroup {
  readonly date: IsoDate;
  readonly label: string;
  readonly rows: readonly OrderRow[];
  /** Hela dagens antal och summa (servern), eller null om dagen saknas där. */
  readonly total: { readonly count: number; readonly amountOre: number } | null;
}

const WEEKDAYS = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];
const MONTHS = [
  "jan.",
  "feb.",
  "mars",
  "apr.",
  "maj",
  "juni",
  "juli",
  "aug.",
  "sep.",
  "okt.",
  "nov.",
  "dec.",
];

/** "I dag", "I går", "fredag 20 nov." eller med år när det inte är i år. */
export function dayLabel(date: IsoDate, today: IsoDate): string {
  if (date === today) return "I dag";
  if (date === addDays(today, -1)) return "I går";
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const weekday = WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  const year = date.slice(0, 4) === today.slice(0, 4) ? "" : ` ${y}`;
  const text = `${weekday} ${d} ${MONTHS[m - 1] ?? ""}${year}`;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Raderna i följd per affärsdag (en ny grupp varje gång dagen byts). */
export function groupByDay(
  rows: readonly OrderRow[],
  days: readonly OrderDayTotal[],
  today: IsoDate,
): DayGroup[] {
  const totals = new Map(days.map((d) => [d.date, d]));
  const groups: { date: IsoDate; rows: OrderRow[] }[] = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.date === r.businessDate) last.rows.push(r);
    else groups.push({ date: r.businessDate, rows: [r] });
  }
  return groups.map((g) => {
    const t = totals.get(g.date);
    return {
      date: g.date,
      label: dayLabel(g.date, today),
      rows: g.rows,
      total: t ? { count: t.count, amountOre: t.amountOre } : null,
    };
  });
}

/** "11:56" i organisationens tidszon. */
export function timeOf(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return "";
  return new Intl.DateTimeFormat("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(d);
}

/** Chipsets korta namn: delen efter kolon ("One Piece: Romance Dawn" → "Romance Dawn"). */
export function chipName(name: string): string {
  const i = name.indexOf(":");
  const tail = i >= 0 ? name.slice(i + 1).trim() : "";
  return tail || name;
}
