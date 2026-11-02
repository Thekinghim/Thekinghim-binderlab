/**
 * Deterministisk generator av seed-orderna (13 okt – 1 nov 2026).
 *
 * Summorna är exakta per konstruktion: varje titel får exakt sina antal och
 * priser (SEED_TITLES), så totalen och summan per titel stämmer på öret
 * oavsett hur orderna fördelas i tiden. Slumpen (seedad) avgör bara tider,
 * vilken titel som säljs när, automat och betalmetod. Bästa dagen styrs till
 * 26 okt med 8 350–8 450 kr genom att titlar byts mellan bästa dagen och
 * andra dagar tills villkoret håller.
 *
 * Inget beror på processens tidszon: svensk tid räknas om till UTC med
 * uttryckliga zoner (src/import/zoned.ts), och dagar räknas med heltal.
 */

import { dayOfWeek, eachDay } from "@/domain/dates";
import { allocateLargestRemainder } from "@/domain/money";
import type { IsoDate } from "@/domain/types";
import { formatInZone, zonedToUtc } from "@/import/zoned";

import {
  AUTUMN_BREAK,
  BEST_DAY,
  BEST_DAY_ORDERS,
  FIRST_ORDER_NO,
  OPEN_HOURS,
  ORDER_COUNT,
  ORGANIZATION_TIMEZONE,
  PAYMENT_METHODS,
  SEED_LAST_ORDERS,
  SEED_MACHINES,
  SEED_PERIOD,
  SEED_TITLES,
} from "./catalog";
import { createRandom, type Random } from "./random";

/** Fröet för generatorn. Ändras det ändras all seed-data (och fixturen). */
export const SEED_RANDOM_SEED = 20_261_101;

/** Generatorns mål för bästa dagen (snävare än facit 8 300–8 500 kr). */
const BEST_DAY_TARGET_ORE = { min: 835_000, max: 845_000 } as const;
const MAX_SWAPS = 50_000;

export interface SeedOrder {
  /** Order No. i Awish. */
  externalId: string;
  /** Awish interna ID (kolumnen ID). */
  awishId: number;
  title: string;
  amountOre: number;
  machineCode: string;
  /** "Order Machine" i Awish. */
  awishMachine: string;
  paymentMethod: string;
  /** Betaltid (UTC, ms sedan epoken). */
  paidAtMs: number;
  /** När ordern skapades i Awish (kolumnen Date), några sekunder före betalningen. */
  createdAtMs: number;
  /** Svenskt affärsdatum. */
  businessDate: IsoDate;
  /** Svensk tid "YYYY-MM-DD HH:mm:ss". */
  stockholmTime: string;
}

/** Svensk lokal tid → UTC-ms. Kastar om tiden är tvetydig eller saknas (sommartid). */
export function stockholmToUtcMs(date: IsoDate, time: string): number {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const t = /^(\d{2}):(\d{2}):(\d{2})$/.exec(time);
  if (!d || !t) {
    throw new RangeError(`Ogiltig tid: ${date} ${time}`);
  }
  const result = zonedToUtc(
    {
      year: Number(d[1]),
      month: Number(d[2]),
      day: Number(d[3]),
      hour: Number(t[1]),
      minute: Number(t[2]),
      second: Number(t[3]),
    },
    ORGANIZATION_TIMEZONE,
  );
  if (result.resolution !== "exact") {
    throw new RangeError(`Tiden ${date} ${time} är inte entydig i svensk tid.`);
  }
  return result.utc.getTime();
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function clock(secondOfDay: number): string {
  const h = Math.floor(secondOfDay / 3600);
  const m = Math.floor((secondOfDay % 3600) / 60);
  const s = secondOfDay % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

function secondsOf(time: string): number {
  const [h = "0", m = "0", s = "0"] = time.split(":");
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

function isAutumnBreak(date: IsoDate): boolean {
  return date >= AUTUMN_BREAK.start && date <= AUTUMN_BREAK.end;
}

/** Vikt per veckodag (1 = måndag … 7 = söndag). Fredag–söndag säljer mest. */
const WEEKDAY_WEIGHT: Readonly<Record<number, number>> = {
  1: 80,
  2: 78,
  3: 88,
  4: 95,
  5: 120,
  6: 150,
  7: 115,
};

/** Timvikter för timmarna 10–19: vardag (topp efter skolan) och helg/lov (topp mitt på dagen). */
const HOUR_WEIGHTS_WEEKDAY = [3, 4, 6, 6, 7, 10, 12, 12, 9, 5] as const;
const HOUR_WEIGHTS_WEEKEND = [5, 8, 10, 11, 11, 11, 10, 8, 6, 4] as const;

/** Antal order per dag: bästa dagen fast, övriga efter veckodag, höstlov och lite slump. */
function ordersPerDay(days: readonly IsoDate[], rng: Random): Map<IsoDate, number> {
  const others = days.filter((d) => d !== BEST_DAY);
  const weights = others.map((d) => {
    let w = WEEKDAY_WEIGHT[dayOfWeek(d)] ?? 100;
    if (isAutumnBreak(d)) {
      w = Math.floor((w * 13) / 10);
    }
    // Svag uppgång under perioden (titlarna blev kända) och ±10 % slump.
    const index = days.indexOf(d);
    w = Math.floor((w * (100 + index)) / 100);
    return Math.floor((w * rng.between(90, 110)) / 100);
  });
  const counts = allocateLargestRemainder(ORDER_COUNT - BEST_DAY_ORDERS, weights);
  const out = new Map<IsoDate, number>();
  others.forEach((d, i) => out.set(d, counts[i] ?? 0));
  out.set(BEST_DAY, BEST_DAY_ORDERS);
  return out;
}

interface Slot {
  date: IsoDate;
  secondOfDay: number;
  ms: number;
  fixed: number | null;
}

/** Unika tider (sekund på dygnet) för dagens order. */
function timesForDay(date: IsoDate, count: number, rng: Random, before: number | null): number[] {
  const weekend = dayOfWeek(date) >= 6 || isAutumnBreak(date);
  const hourWeights = weekend ? HOUR_WEIGHTS_WEEKEND : HOUR_WEIGHTS_WEEKDAY;
  const lastHour = before === null ? OPEN_HOURS.last : Math.floor((before - 1) / 3600);
  const usable = hourWeights.map((w, i) => (OPEN_HOURS.first + i <= lastHour ? w : 0));
  const taken = new Set<number>();
  while (taken.size < count) {
    const hour = OPEN_HOURS.first + rng.weighted(usable);
    const second = hour * 3600 + rng.int(3600);
    if (before !== null && second >= before) {
      continue;
    }
    taken.add(second);
  }
  return [...taken].sort((a, b) => a - b);
}

/** Pris per order: titelns prisschema i tidsordning (orderna är sorterade på tid). */
function pricesFor(titles: readonly string[]): number[] {
  const byName = new Map(SEED_TITLES.map((t) => [t.name, t]));
  const seen = new Map<string, number>();
  return titles.map((name) => {
    const title = byName.get(name);
    if (!title) {
      throw new Error(`Okänd titel: ${name}`);
    }
    let n = seen.get(name) ?? 0;
    seen.set(name, n + 1);
    for (const step of title.prices) {
      if (n < step.count) {
        return step.ore;
      }
      n -= step.count;
    }
    throw new Error(`För många order av ${name}.`);
  });
}

function revenueByDay(slots: readonly Slot[], prices: readonly number[]): Map<IsoDate, number> {
  const out = new Map<IsoDate, number>();
  slots.forEach((s, i) => out.set(s.date, (out.get(s.date) ?? 0) + (prices[i] ?? 0)));
  return out;
}

function bestDayScore(byDay: Map<IsoDate, number>): number {
  const best = byDay.get(BEST_DAY) ?? 0;
  let maxOther = 0;
  for (const [d, v] of byDay) {
    if (d !== BEST_DAY && v > maxOther) {
      maxOther = v;
    }
  }
  const outside =
    best < BEST_DAY_TARGET_ORE.min
      ? BEST_DAY_TARGET_ORE.min - best
      : best > BEST_DAY_TARGET_ORE.max
        ? best - BEST_DAY_TARGET_ORE.max
        : 0;
  return outside + Math.max(0, maxOther - best + 1);
}

/** Genererar alla 460 orderna, sorterade i tidsordning (42321 först). */
export function generateSeedOrders(seed = SEED_RANDOM_SEED): SeedOrder[] {
  const rng = createRandom(seed);
  const days = eachDay(SEED_PERIOD.start, SEED_PERIOD.end);
  const perDay = ordersPerDay(days, rng);

  // Tider. Sista dagen slutar med de fyra fasta orderna.
  const lastDay = SEED_PERIOD.end;
  const fixedSeconds = SEED_LAST_ORDERS.map((o) => {
    if (!o.stockholmTime.startsWith(`${lastDay} `)) {
      throw new Error(`De fasta orderna måste ligga ${lastDay}.`);
    }
    return secondsOf(o.stockholmTime.slice(11));
  });
  const firstFixed = fixedSeconds[0] ?? 0;
  const slots: Slot[] = [];
  for (const date of days) {
    const count = perDay.get(date) ?? 0;
    const isLast = date === lastDay;
    const randomCount = isLast ? count - SEED_LAST_ORDERS.length : count;
    if (randomCount < 0) {
      throw new Error("För få order sista dagen.");
    }
    for (const second of timesForDay(date, randomCount, rng, isLast ? firstFixed : null)) {
      slots.push({
        date,
        secondOfDay: second,
        ms: stockholmToUtcMs(date, clock(second)),
        fixed: null,
      });
    }
    if (isLast) {
      fixedSeconds.forEach((second, i) => {
        slots.push({
          date,
          secondOfDay: second,
          ms: stockholmToUtcMs(date, clock(second)),
          fixed: i,
        });
      });
    }
  }
  if (slots.length !== ORDER_COUNT) {
    throw new Error(`Fel antal order: ${slots.length}`);
  }
  for (let i = 1; i < slots.length; i++) {
    if ((slots[i]?.ms ?? 0) <= (slots[i - 1]?.ms ?? 0)) {
      throw new Error("Tiderna är inte strikt stigande.");
    }
  }

  // Titlar: hela mängden minus de fasta, blandad.
  const pool: string[] = [];
  const remaining = new Map<string, number>();
  for (const t of SEED_TITLES) {
    remaining.set(
      t.name,
      t.prices.reduce((n, p) => n + p.count, 0),
    );
  }
  for (const o of SEED_LAST_ORDERS) {
    const left = remaining.get(o.title);
    if (left === undefined || left <= 0) {
      throw new Error(`Fast order med okänd titel: ${o.title}`);
    }
    remaining.set(o.title, left - 1);
  }
  for (const t of SEED_TITLES) {
    for (let i = 0; i < (remaining.get(t.name) ?? 0); i++) {
      pool.push(t.name);
    }
  }
  const shuffled = rng.shuffle(pool);
  let next = 0;
  const titles = slots.map((s) => {
    if (s.fixed !== null) {
      return SEED_LAST_ORDERS[s.fixed]?.title ?? "";
    }
    return shuffled[next++] ?? "";
  });

  // Bästa dagen: byt titlar mellan bästa dagen och andra dagar tills villkoret håller.
  const bestIdx = slots.flatMap((s, i) => (s.date === BEST_DAY && s.fixed === null ? [i] : []));
  const otherIdx = slots.flatMap((s, i) => (s.date !== BEST_DAY && s.fixed === null ? [i] : []));
  let prices = pricesFor(titles);
  let score = bestDayScore(revenueByDay(slots, prices));
  for (let iter = 0; score > 0; iter++) {
    if (iter >= MAX_SWAPS) {
      throw new Error("Kunde inte styra bästa dagen till målet.");
    }
    const i = bestIdx[rng.int(bestIdx.length)] ?? 0;
    const j = otherIdx[rng.int(otherIdx.length)] ?? 0;
    const ti = titles[i] ?? "";
    const tj = titles[j] ?? "";
    if (ti === tj) {
      continue;
    }
    titles[i] = tj;
    titles[j] = ti;
    const candidate = pricesFor(titles);
    const candidateScore = bestDayScore(revenueByDay(slots, candidate));
    if (candidateScore < score) {
      prices = candidate;
      score = candidateScore;
    } else {
      titles[i] = ti;
      titles[j] = tj;
    }
  }

  // Automat, betalmetod och ordernummer.
  const machineWeights = SEED_MACHINES.map((m) => m.weight);
  const methodWeights = PAYMENT_METHODS.map((m) => m.weight);
  const orders = slots.map((s, i): SeedOrder => {
    const machine = SEED_MACHINES[rng.weighted(machineWeights)];
    const method = PAYMENT_METHODS[rng.weighted(methodWeights)];
    const amountOre = prices[i];
    if (!machine || !method || amountOre === undefined || !Number.isSafeInteger(amountOre)) {
      throw new Error("Ofullständig order.");
    }
    return {
      externalId: String(FIRST_ORDER_NO + i),
      awishId: 880_000 + i,
      title: titles[i] ?? "",
      amountOre,
      machineCode: machine.code,
      awishMachine: machine.awishName,
      paymentMethod: method.name,
      paidAtMs: s.ms,
      createdAtMs: s.ms - rng.between(6, 45) * 1000,
      businessDate: s.date,
      stockholmTime: `${s.date} ${clock(s.secondOfDay)}`,
    };
  });

  // Kontroll: de fasta orderna stämmer exakt.
  SEED_LAST_ORDERS.forEach((expected) => {
    const actual = orders.find((o) => o.externalId === expected.externalId);
    if (
      !actual ||
      actual.title !== expected.title ||
      actual.amountOre !== expected.amountOre ||
      actual.stockholmTime !== expected.stockholmTime
    ) {
      throw new Error(`Order ${expected.externalId} blev inte som facit.`);
    }
  });
  return orders;
}

/** Summering av orderna (för tester och seedens rapport). Belopp i öre. */
export interface SeedOrderSummary {
  orders: number;
  revenueOre: number;
  byTitle: Map<string, { orders: number; revenueOre: number }>;
  byDay: Map<IsoDate, { orders: number; revenueOre: number }>;
  byMachine: Map<string, { orders: number; revenueOre: number }>;
  bestDay: { date: IsoDate; revenueOre: number };
}

export function summarizeSeedOrders(orders: readonly SeedOrder[]): SeedOrderSummary {
  const bump = (
    map: Map<string, { orders: number; revenueOre: number }>,
    key: string,
    ore: number,
  ): void => {
    const cur = map.get(key) ?? { orders: 0, revenueOre: 0 };
    map.set(key, { orders: cur.orders + 1, revenueOre: cur.revenueOre + ore });
  };
  const byTitle = new Map<string, { orders: number; revenueOre: number }>();
  const byDay = new Map<IsoDate, { orders: number; revenueOre: number }>();
  const byMachine = new Map<string, { orders: number; revenueOre: number }>();
  let revenueOre = 0;
  for (const o of orders) {
    revenueOre += o.amountOre;
    bump(byTitle, o.title, o.amountOre);
    bump(byDay, o.businessDate, o.amountOre);
    bump(byMachine, o.machineCode, o.amountOre);
  }
  if (!Number.isSafeInteger(revenueOre)) {
    throw new RangeError("Summan är inte ett säkert heltal.");
  }
  let bestDay = { date: SEED_PERIOD.start as IsoDate, revenueOre: -1 };
  for (const [date, v] of [...byDay].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (v.revenueOre > bestDay.revenueOre) {
      bestDay = { date, revenueOre: v.revenueOre };
    }
  }
  return { orders: orders.length, revenueOre, byTitle, byDay, byMachine, bestDay };
}

/** "YYYY-MM-DD HH:mm:ss" i källans tidszon (Awish). */
export function sourceTime(ms: number, timeZone: string): string {
  return formatInZone(new Date(ms), timeZone);
}
