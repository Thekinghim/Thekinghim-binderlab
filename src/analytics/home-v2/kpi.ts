/**
 * Små uträkningar för Hem i V2 (byggplanen 2.2 och 3.5). Rena funktioner i öre, inga
 * avrundningar förrän vid visning.
 *
 * Vinst per automat och dag = periodens vinst ÷ automatdagar, där en automatdag är en dag en
 * automat var i drift (isMachineActive: inte arkiverad, activeFrom ≤ dagen ≤ activeTo). Så
 * räknas en automat som kom till mitt i perioden bara för sina dagar.
 */

import { localParts, tryParseInstant } from "@/analytics/todos/time";
import { isMachineActive } from "@/analytics/todos/common";
import type { MachineRef } from "@/analytics/todos";
import { addDays, type IsoDate, type Period } from "@/domain";

/** Dagar i drift för alla automater i perioden (en automat × en dag = 1). */
export function machineDays(machines: readonly MachineRef[], period: Period): number {
  let n = 0;
  for (let d: IsoDate = period.start; d <= period.end; d = addDays(d, 1)) {
    for (const m of machines) if (isMachineActive(m, d)) n++;
  }
  return n;
}

/** Vinst per automatdag (öre), eller null utan automatdagar eller vinst. */
export function profitPerMachineDayOre(
  profitOre: number | null,
  machineDayCount: number,
): number | null {
  if (profitOre === null || machineDayCount <= 0) return null;
  return Math.round(profitOre / machineDayCount);
}

/** Förändringen i bp ((nu − förra) ÷ |förra|), eller null utan jämförelse. */
export function changeBp(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return Math.round(((now - before) * 10_000) / Math.abs(before));
}

/** HomeKpi.delta (andel, 0,12 = +12 %; p.e. för marginalen) till bp för märket. */
export function kpiDeltaBp(delta: number | null, kind: "relative" | "absolute"): number | null {
  if (delta === null || !Number.isFinite(delta)) return null;
  // Relativ: 0,12 → 1 200 bp. Absolut (p.e.): 2,5 p.e. → 250 bp (DeltaBadge "pe").
  return Math.round(kind === "relative" ? delta * 10_000 : delta * 100);
}

/**
 * Pack, vinst och andel per stad (Analys · Vinst per stad). Automaterna grupperas på
 * butikens stad (aktuell placering); utan stad: "Utan stad". Störst vinst först.
 */
export interface CityLineInput {
  readonly machineId: string;
  readonly city: string | null;
  readonly profitOre: number;
  readonly revenueOre: number;
}

export interface CityLine {
  readonly city: string;
  readonly machines: number;
  readonly profitOre: number;
  readonly revenueOre: number;
  /** Vinst per automat (öre). */
  readonly perMachineOre: number;
  /** Andel av all vinst i bp (0 när summan inte är positiv). */
  readonly shareBp: number;
}

export const NO_CITY = "Utan stad";

export function profitByCity(lines: readonly CityLineInput[]): CityLine[] {
  const map = new Map<string, { machines: Set<string>; profit: number; revenue: number }>();
  for (const l of lines) {
    const city = l.city?.trim() || NO_CITY;
    const row = map.get(city) ?? { machines: new Set<string>(), profit: 0, revenue: 0 };
    row.machines.add(l.machineId);
    row.profit += l.profitOre;
    row.revenue += l.revenueOre;
    map.set(city, row);
  }
  const total = [...map.values()].reduce((a, r) => a + r.profit, 0);
  return [...map.entries()]
    .map(([city, r]) => ({
      city,
      machines: r.machines.size,
      profitOre: r.profit,
      revenueOre: r.revenue,
      perMachineOre: Math.round(r.profit / Math.max(1, r.machines.size)),
      shareBp: total > 0 ? Math.round((r.profit * 10_000) / total) : 0,
    }))
    .sort((a, b) => b.profitOre - a.profitOre || a.city.localeCompare(b.city, "sv"));
}

/** Värden per steg ur en kumulativ serie (pace.ts todayHourly → per timme). */
export function perStep(cumulative: readonly number[]): number[] {
  return cumulative.map((v, i) => Math.max(0, v - (i > 0 ? (cumulative[i - 1] ?? 0) : 0)));
}

/**
 * Trenden för en titel på Mest sålda: sålda per dag de senaste 7 dagarna mot hela periodens
 * snitt per dag, i bp (+1 300 = 13 % mer). null utan försäljning i perioden.
 */
export function titleTrendBp(last7: number, all: number, days: number): number | null {
  if (all <= 0 || days <= 0) return null;
  return Math.round(((last7 / 7) * 10_000) / (all / days)) - 10_000;
}

/**
 * "Vinst i dag mot i går" (KPI-bandet, prototypens "I går samma tid"): dagens order fram till
 * klockslaget och gårdagens order fram till SAMMA klockslag (väggtid i tidszonen, som takten i
 * _hem/pace.ts). Order utan betaltid räknas inte (klockslaget är okänt). `hour` är ordern
 * timme i dag (för linjen timme för timme).
 */
export interface TodaySplit<O> {
  readonly today: O[];
  readonly yesterday: O[];
  /** Timme (0–23) per order i `today`, samma ordning. */
  readonly hours: number[];
  /** Klockslagets timme (0–23), eller null när klockslaget inte är i dag. */
  readonly cutHour: number | null;
}

const minutesOf = (time: string): number => {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
};

export function splitTodayYesterday<
  O extends { readonly businessDate: IsoDate; readonly orderedAt?: string },
>(orders: readonly O[], today: IsoDate, cutoffMs: number, timeZone: string): TodaySplit<O> {
  const yesterday = addDays(today, -1);
  const cut = Number.isFinite(cutoffMs) ? localParts(cutoffMs, timeZone) : null;
  if (!cut || cut.date !== today) return { today: [], yesterday: [], hours: [], cutHour: null };
  const cutMinute = minutesOf(cut.time);
  const out: TodaySplit<O> = {
    today: [],
    yesterday: [],
    hours: [],
    cutHour: Math.floor(cutMinute / 60),
  };
  for (const o of orders) {
    if (o.businessDate !== today && o.businessDate !== yesterday) continue;
    const ms = o.orderedAt ? tryParseInstant(o.orderedAt) : null;
    if (ms === null) continue;
    const p = localParts(ms, timeZone);
    // Betaltid på ett annat datum än affärsdatumet: dagens början eller slut.
    const minute =
      p.date < o.businessDate ? 0 : p.date > o.businessDate ? 24 * 60 : minutesOf(p.time);
    if (o.businessDate === today) {
      if (ms > cutoffMs) continue;
      out.today.push(o);
      out.hours.push(Math.min(Math.floor(minute / 60), out.cutHour ?? 23));
    } else if (minute <= cutMinute) {
      out.yesterday.push(o);
    }
  }
  return out;
}

/**
 * Löpande summa timme för timme (prototypens linje för "I dag"): värdet för orderna t.o.m.
 * varje timme, från kl. 6 (eller första timmen med köp om den är tidigare) t.o.m. klockslaget.
 * `valueOf` räknar beloppet för en mängd order (vinsten ur liggaren).
 */
export function hourlyRunning<O>(
  split: Pick<TodaySplit<O>, "today" | "hours" | "cutHour">,
  valueOf: (orders: readonly O[]) => number,
): number[] {
  if (split.cutHour === null || split.today.length === 0) return [];
  const first = Math.min(6, ...split.hours);
  const out: number[] = [];
  for (let h = first; h <= split.cutHour; h++) {
    out.push(valueOf(split.today.filter((_, i) => (split.hours[i] ?? 0) <= h)));
  }
  return out;
}

/** Vinst per automatdag för varje dag i en dagserie (linjen för Vinst/automat/dag). */
export function perMachineDaySeries(
  days: readonly { readonly date: IsoDate; readonly profitOre: number }[],
  machines: readonly MachineRef[],
): number[] {
  return days.map((d) => {
    const n = machineDays(machines, { start: d.date, end: d.date });
    return n > 0 ? Math.round(d.profitOre / n) : 0;
  });
}
