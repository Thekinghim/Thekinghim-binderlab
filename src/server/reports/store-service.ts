/**
 * Drift och service för butiksrapporten: påfyllningar och när automaterna används mest.
 * Uppgifterna är antal och tider (inga belopp) och sparas i ögonblicksbilden, så att
 * PDF och e-post visar samma sak. Ren modul.
 */

import type { IsoDate } from "@/domain";

export interface StoreService {
  /**
   * Påfyllningsbesök i butikens automater under månaden: antal dagar med minst en
   * påfyllning (ett besök fyller flera titlar och ibland flera automater).
   */
  readonly refills: { readonly count: number; readonly last: IsoDate | null };
  /** "Lördagar 12–15", eller null om underlaget är för litet (färre än `MIN_ORDERS`). */
  readonly busiest: string | null;
  /** Antal köp som `busiest` bygger på. */
  readonly busiestOrders: number;
}

/** Minsta antal köp för att peka ut en mest besökt tid. */
export const MIN_ORDERS = 20;
/** Fönstrets längd i timmar. */
export const WINDOW_HOURS = 3;

const WEEKDAY_PLURAL = [
  "Söndagar",
  "Måndagar",
  "Tisdagar",
  "Onsdagar",
  "Torsdagar",
  "Fredagar",
  "Lördagar",
];
const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localSlot(iso: string, timeZone: string): { weekday: number; hour: number } | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const weekday = WEEKDAY_INDEX[parts.find((p) => p.type === "weekday")?.value ?? ""];
  const hour = Number(parts.find((p) => p.type === "hour")?.value);
  if (weekday === undefined || !Number.isInteger(hour)) return null;
  return { weekday, hour };
}

/**
 * Den veckodag som har flest köp och, inom den, det fönster om tre hela timmar med flest
 * köp ("Lördagar 12–15" = 12:00–14:59). Lika många: tidigast veckodag (måndag först) och
 * tidigast timme. Under `MIN_ORDERS` köp blir svaret null.
 */
export function busiestWindow(
  orderedAt: readonly string[],
  timeZone: string,
): { text: string | null; orders: number } {
  const counts = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let total = 0;
  for (const iso of orderedAt) {
    const slot = localSlot(iso, timeZone);
    if (!slot) continue;
    counts[slot.weekday]![slot.hour]! += 1;
    total += 1;
  }
  if (total < MIN_ORDERS) return { text: null, orders: total };
  const order = [1, 2, 3, 4, 5, 6, 0];
  let bestDay = order[0]!;
  let bestDayCount = -1;
  for (const d of order) {
    const n = counts[d]!.reduce((a, b) => a + b, 0);
    if (n > bestDayCount) {
      bestDay = d;
      bestDayCount = n;
    }
  }
  let bestHour = 0;
  let bestWindow = -1;
  for (let h = 0; h + WINDOW_HOURS <= 24; h++) {
    let n = 0;
    for (let k = 0; k < WINDOW_HOURS; k++) n += counts[bestDay]![h + k]!;
    if (n > bestWindow) {
      bestWindow = n;
      bestHour = h;
    }
  }
  return {
    text: `${WEEKDAY_PLURAL[bestDay]} ${bestHour}–${bestHour + WINDOW_HOURS}`,
    orders: total,
  };
}

/**
 * Antal påfyllningsbesök och senaste dagen, ur lagerhändelsernas affärsdatum. Ett besök =
 * en dag med påfyllning i butiken, hur många titlar och automater som än fylldes på.
 */
export function refillSummary(dates: readonly IsoDate[]): StoreService["refills"] {
  const days = new Set(dates);
  let last: IsoDate | null = null;
  for (const d of days) if (last === null || d > last) last = d;
  return { count: days.size, last };
}
