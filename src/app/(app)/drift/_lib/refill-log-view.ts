/**
 * Drift → Påfyllning: loggen över registrerade påfyllningar (från Fyll på), uppdelad på i dag
 * och dagarna före, i organisationens tidszon. Ren och klientsäker; testas i
 * refill-log-view.test.ts. Raderna läses i ./refill-log.ts.
 */

import { todayIn, toIsoDate, wallClockIn } from "@/components/shell/period-state";
import { formatInt, formatTime, NBSP } from "@/lib/format";

export interface RefillLogRow {
  readonly clientId: string;
  readonly machineCode: string;
  readonly machineName: string;
  readonly titleName: string;
  readonly quantity: number;
  /** ISO 8601. */
  readonly occurredAt: string;
  /** Den som fyllde på (visningsnamn eller e-post), null om okänd. */
  readonly by: string | null;
}

export interface RefillLogEntry extends RefillLogRow {
  /** "14:05" i tidszonen. */
  readonly time: string;
}

export interface RefillLogDay {
  readonly date: string;
  readonly packs: number;
  readonly entries: RefillLogEntry[];
}

export interface RefillLogView {
  readonly today: RefillLogDay;
  /** Dagarna före, senaste först (bara dagar med påfyllningar). */
  readonly earlier: RefillLogDay[];
  /** Rubriken: "Inget påfyllt i dag." / "36 pack påfyllda i dag." */
  readonly headline: string;
}

/** Affärsdagen (YYYY-MM-DD) för en tidpunkt i tidszonen. */
export function businessDateOf(iso: string, timeZone: string): string {
  return toIsoDate(todayIn(new Date(iso), timeZone));
}

export function refillLogView(
  rows: readonly RefillLogRow[],
  today: string,
  timeZone: string,
): RefillLogView {
  const byDay = new Map<string, RefillLogEntry[]>();
  const sorted = [...rows].sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : -1));
  for (const r of sorted) {
    const date = businessDateOf(r.occurredAt, timeZone);
    const list = byDay.get(date) ?? [];
    list.push({ ...r, time: formatTime(wallClockIn(new Date(r.occurredAt), timeZone)) });
    byDay.set(date, list);
  }
  const day = (date: string): RefillLogDay => {
    const entries = byDay.get(date) ?? [];
    return { date, packs: entries.reduce((n, e) => n + e.quantity, 0), entries };
  };
  const todayDay = day(today);
  const earlier = [...byDay.keys()]
    .filter((d) => d < today)
    .sort()
    .reverse()
    .map(day);
  return {
    today: todayDay,
    earlier,
    headline:
      todayDay.packs === 0
        ? "Inget påfyllt i dag."
        : `${formatInt(todayDay.packs)}${NBSP}${todayDay.packs === 1 ? "pack påfyllt" : "pack påfyllda"} i dag.`,
  };
}
