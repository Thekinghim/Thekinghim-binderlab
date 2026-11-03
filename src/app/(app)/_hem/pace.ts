/**
 * Dagens takt på Hem ("I dag hittills"): dagens intäkt fram till nu jämfört med samma
 * klockslag samma veckodag de senaste veckorna.
 *
 * Ren funktion utan databas. Intäkten är nettointäkten (betalt minus moms), samma som
 * nyckeltalet Intäkt (keyMetrics), i öre. Klockslaget jämförs som väggtid i tidszonen,
 * så att en dag med sommartidsskifte jämförs på samma klockslag och inte samma antal ms.
 */

import { localParts, tryParseInstant } from "@/analytics/todos/time";
import type { AnalyticsOrder } from "@/analytics/todos";
import {
  addDays,
  dayOfWeek,
  mulDivRound,
  ratioBp,
  roundHalfUp,
  vatOfGross,
  type IsoDate,
} from "@/domain";

export type PaceTone = "up" | "down" | "neutral";

export interface TodayPace {
  /** Klockslaget som jämförs, 'TT:MM' i tidszonen (min av nu och senaste synk). */
  readonly clock: string;
  /** Veckodag enligt ISO (1 = måndag … 7 = söndag). */
  readonly weekday: number;
  /** Dagens intäkt t.o.m. klockslaget (öre). */
  readonly soFarOre: number;
  /** Snittet för jämförelsedagarna t.o.m. samma klockslag (öre). */
  readonly baselineSoFarOre: number;
  /** (soFar − baseline) / baseline i bp. */
  readonly deltaBp: number;
  /** Tonen för ±-etiketten (paceTone). */
  readonly tone: PaceTone;
  /** Prognos för hela dagen: soFar × Σhela dagar / Σhittills (öre). */
  readonly projectionOre: number;
  /** Snittet för jämförelsedagarna, hela dagen (öre). */
  readonly baselineFullOre: number;
  /** Dagens intäkt kumulativt per timme, timme 0 t.o.m. klockslagets timme (öre). */
  readonly todayHourly: number[];
  /** Jämförelsedagarnas snitt kumulativt per timme, 24 värden (öre). */
  readonly baselineHourly: number[];
  readonly comparisonDays: number;
}

export interface TodayPaceInput {
  /** Order med affärsdatum och betaltid; minst today − 7 × weeks t.o.m. today. */
  readonly orders: readonly Pick<AnalyticsOrder, "businessDate" | "amountOre" | "orderedAt">[];
  readonly today: IsoDate;
  /** min(nu, senaste lyckade synk) i ms. */
  readonly cutoffMs: number;
  readonly timeZone: string;
  /** Momssats i bp (inställningarna), för nettointäkten. */
  readonly vatRateBp: number;
  /** Första dagen med data; tidigare jämförelsedagar tas inte med. null = ingen gräns. */
  readonly dataStart: IsoDate | null;
  /** Antal veckor bakåt (standard 8). */
  readonly weeks?: number;
}

/** Veckor bakåt som jämförs (samma veckodag). */
export const PACE_WEEKS = 8;

/** Minst så många jämförelsedagar med order, annars visas inget. */
export const MIN_COMPARISON_DAYS = 3;
const DAY_MINUTES = 24 * 60;

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

interface DayAcc {
  full: number;
  /** Intäkt per minut-på-dygnet, bara order med giltig betaltid. */
  timed: { minute: number; net: number }[];
  /** Antal order (även utan betaltid). */
  orders: number;
}

/**
 * Dagens takt, eller null när den inte går att jämföra: färre än tre jämförelsedagar med
 * order, färre än tre av dem med försäljning före samma klockslag, eller klockslaget inte
 * i dag.
 */
export function todayPace(input: TodayPaceInput): TodayPace | null {
  const { today, cutoffMs, timeZone, vatRateBp, dataStart } = input;
  const weeks = input.weeks ?? PACE_WEEKS;
  if (!Number.isFinite(cutoffMs)) return null;
  const cut = localParts(cutoffMs, timeZone);
  // Senaste synken var före i dag: dagens siffra är inte känd än.
  if (cut.date !== today) return null;
  const cutMinute = minutesOf(cut.time);
  const cutHour = Math.floor(cutMinute / 60);

  const comparison = new Set<IsoDate>();
  for (let w = 1; w <= weeks; w++) {
    const d = addDays(today, -7 * w);
    if (dataStart === null || d >= dataStart) comparison.add(d);
  }

  const days = new Map<IsoDate, DayAcc>();
  let soFar = 0;
  const todayByHour = new Array<number>(24).fill(0);

  for (const o of input.orders) {
    const isToday = o.businessDate === today;
    if (!isToday && !comparison.has(o.businessDate)) continue;
    const net = o.amountOre - vatOfGross(o.amountOre, vatRateBp);
    const ms = o.orderedAt ? tryParseInstant(o.orderedAt) : null;
    if (isToday) {
      if (ms === null || ms > cutoffMs) continue;
      soFar += net;
      const p = localParts(ms, timeZone);
      const hour = p.date < today ? 0 : Math.floor(minutesOf(p.time) / 60);
      todayByHour[Math.min(hour, cutHour)]! += net;
      continue;
    }
    let acc = days.get(o.businessDate);
    if (!acc) {
      acc = { full: 0, timed: [], orders: 0 };
      days.set(o.businessDate, acc);
    }
    acc.full += net;
    acc.orders += 1;
    if (ms !== null) {
      const p = localParts(ms, timeZone);
      // Betaltid på annat datum än affärsdatumet (ska inte förekomma): räkna som dagens början/slut.
      const minute =
        p.date < o.businessDate ? 0 : p.date > o.businessDate ? DAY_MINUTES : minutesOf(p.time);
      acc.timed.push({ minute, net });
    }
  }

  const used = [...days.values()].filter((d) => d.orders > 0);
  const n = used.length;
  if (n < MIN_COMPARISON_DAYS) return null;

  let sumSoFar = 0;
  let sumFull = 0;
  // Jämförelsedagar som hade sålt något vid klockslaget. Färre än tre (t.ex. tidigt på
  // morgonen) ger ett brusigt ±% ("−100 %" på en enda tidig order), så då visas inget.
  let daysSoldSoFar = 0;
  const baseHour = new Array<number>(24).fill(0);
  for (const d of used) {
    sumFull += d.full;
    let soldSoFar = false;
    for (const t of d.timed) {
      if (t.minute <= cutMinute) {
        sumSoFar += t.net;
        soldSoFar = true;
      }
      baseHour[Math.min(23, Math.floor(t.minute / 60))]! += t.net;
    }
    if (soldSoFar) daysSoldSoFar++;
  }
  if (sumSoFar <= 0 || daysSoldSoFar < MIN_COMPARISON_DAYS) return null;
  const baselineSoFar = roundHalfUp(sumSoFar, n);
  const deltaBp = ratioBp(soFar - baselineSoFar, baselineSoFar);
  if (deltaBp === null) return null;

  return {
    clock: cut.time,
    weekday: dayOfWeek(today),
    soFarOre: soFar,
    baselineSoFarOre: baselineSoFar,
    deltaBp,
    tone: paceTone(deltaBp),
    projectionOre: mulDivRound(soFar, sumFull, sumSoFar),
    baselineFullOre: roundHalfUp(sumFull, n),
    todayHourly: cumulative(todayByHour.slice(0, cutHour + 1)),
    baselineHourly: cumulative(baseHour).map((v) => roundHalfUp(v, n)),
    comparisonDays: n,
  };
}

function cumulative(values: readonly number[]): number[] {
  let s = 0;
  return values.map((v) => (s += v));
}

/** Tonen för ±-etiketten: upp vid ≥ +5 %, ned vid ≤ −15 %, annars neutral. */
export function paceTone(deltaBp: number): PaceTone {
  if (deltaBp >= 500) return "up";
  if (deltaBp <= -1500) return "down";
  return "neutral";
}

/** Om perioden innehåller dagens datum (då visas dagens takt). */
export function periodIncludesToday(period: { start: IsoDate; end: IsoDate }, today: IsoDate) {
  return period.start <= today && today <= period.end;
}
