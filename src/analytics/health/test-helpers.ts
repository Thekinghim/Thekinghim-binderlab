/**
 * Byggare för testerna i health, alerts och visits. Används bara av testerna.
 */

import { addDays, dayOfWeek, type IsoDate } from "@/domain";
import { HOUR_MS, localParts } from "@/analytics/todos/time";
import type { AnalyticsOrder, MachineRef } from "./types";

/** Tidpunkt (ms) för lokal tid `time` ('TT:MM') dagen `date` i tidszonen. */
export function localMs(date: IsoDate, time: string, timeZone = "Europe/Stockholm"): number {
  const naive = Date.parse(`${date}T${time}:00Z`);
  for (const h of [1, 2, 8, 0]) {
    const ms = naive - h * HOUR_MS;
    const p = localParts(ms, timeZone);
    if (p.date === date && p.time === time) return ms;
  }
  for (let off = -14 * 4; off <= 14 * 4; off++) {
    const ms = naive - off * (HOUR_MS / 4);
    const p = localParts(ms, timeZone);
    if (p.date === date && p.time === time) return ms;
  }
  throw new Error(`Ingen tidpunkt för ${date} ${time}`);
}

/** ISO-sträng (UTC) för lokal tid. */
export function localIso(date: IsoDate, time: string, timeZone = "Europe/Stockholm"): string {
  return new Date(localMs(date, time, timeZone)).toISOString();
}

let seq = 0;

/** En order med tidpunkt (lokal tid i Stockholm). */
export function timedOrder(
  machineId: string,
  date: IsoDate,
  time: string,
  titleId = "t1",
  amountOre = 4_900,
): AnalyticsOrder {
  seq++;
  const id = `o${String(seq).padStart(6, "0")}`;
  return {
    id,
    externalId: id,
    titleId,
    machineId,
    businessDate: date,
    amountOre,
    orderedAt: localIso(date, time),
  };
}

/**
 * Försäljning enligt ett schema: varje dag från `start` i `days` dagar, ordrar vid de lokala
 * klockslagen i `times`. `skipWeekdays` (1 = måndag) hoppar över t.ex. stängda söndagar.
 */
export function scheduleOrders(
  machineId: string,
  start: IsoDate,
  days: number,
  times: readonly string[],
  opts: { skipWeekdays?: readonly number[]; titleId?: string; until?: number } = {},
): AnalyticsOrder[] {
  const out: AnalyticsOrder[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    if (opts.skipWeekdays?.includes(dayOfWeek(date))) continue;
    for (const t of times) {
      const o = timedOrder(machineId, date, t, opts.titleId ?? "t1");
      if (opts.until !== undefined && Date.parse(o.orderedAt as string) >= opts.until) continue;
      out.push(o);
    }
  }
  return out;
}

/** Klockslag var 30:e minut mellan två hela timmar: (10, 20) → 10:15, 10:45 … 19:45. */
export function halfHourly(fromHour: number, toHour: number): string[] {
  const out: string[] = [];
  for (let h = fromHour; h < toHour; h++) {
    const hh = String(h).padStart(2, "0");
    out.push(`${hh}:15`, `${hh}:45`);
  }
  return out;
}

export function machineRef(id: string, name: string, p: Partial<MachineRef> = {}): MachineRef {
  return { id, name, activeFrom: null, activeTo: null, ...p };
}
