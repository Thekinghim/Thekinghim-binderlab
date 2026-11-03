/**
 * Tyst titel: en titel som brukar sälja i en automat men har slutat, fast det finns pack i
 * facket och automaten säljer andra titlar. Ofta ett fastnat fack eller en spiral som
 * inte matar.
 *
 *   tystnadens start = senaste försäljningen av titeln i automaten, eller senaste
 *                      påfyllningen om den kom efter (en tom period räknas inte)
 *   slut             = så långt försäljningen är importerad för automaten (högst nu)
 *   λ                = väntade pack under tystnaden enligt titelns veckomönster (samma
 *                      veckodagar och timmar de 28 dagarna före slutet, fram till tystnaden)
 *   flaggas när        i drift i dag, inte redan tyst automat, saldo > 0, inte utgången,
 *                      minst 10 sålda i mönstret, minst 3 andra pack sålda i automaten
 *                      under tystnaden, minst 24 timmar och P(0 sålda) = e^−λ < 1 %
 *   nivå             = 'now' om P(0) < 0,01 %, annars 'soon'
 *   kronor i risk    = titelns intäkt i automaten de 14 dagarna t.o.m. tystnadens första
 *                      dag / 14 × 7
 *
 * Order utan giltig betaltidpunkt ingår inte i mönstret; de räknas som sålda i slutet av
 * sin affärsdag när tystnadens start bestäms, så att tystnaden hellre underskattas.
 * Ren funktion utan I/O.
 */

import {
  addDays,
  dailyUnits,
  floorDiv,
  mulDivRound,
  revenue,
  salesVelocity,
  type IsoDate,
} from "@/domain";
import { buildHourCalendar, type HourCalendar } from "@/analytics/health/calendar";
import { poissonZero } from "@/analytics/health/poisson";
import { buildWeeklyProfile, expectedSales, type SaleInstant } from "@/analytics/health/profile";
import { assortmentKey, retiredPairs } from "./assortment";
import { evidence, isMachineActive } from "./common";
import { HORIZON_DAYS, urgencyOf, type TodoContext } from "./context";
import { silenceText } from "./stale-machine";
import { plural, tenths } from "./text";
import { HOUR_MS, localParts, startOfBusinessDate, tryParseInstant } from "./time";
import type { AnalyticsOrder, MachineRef, StockLevelRef, TodoInput, TodoItem } from "./types";

/** Veckomönstret räknas på de här dagarna före slutet. */
export const SILENT_TITLE_HISTORY_DAYS = 28;
/** Minst så många sålda pack (med tidpunkt) i mönstret. */
export const SILENT_TITLE_MIN_HISTORY = 10;
/** Minst så många pack av andra titlar sålda i automaten under tystnaden. */
export const SILENT_TITLE_MIN_OTHERS = 3;
/** Minst så lång tystnad. */
export const SILENT_TITLE_MIN_HOURS = 24;
/** Flaggas när P(0 sålda) är under detta. */
export const SILENT_TITLE_ALARM_P = 0.01;
/** 'now' när P(0 sålda) är under detta. */
export const SILENT_TITLE_NOW_P = 0.0001;
/** Fönstret för kronor i risk. */
const STAKE_WINDOW_DAYS = 14;

const DAY_MS = 24 * HOUR_MS;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** En tyst titel i en automat, med talen bakom. */
export interface SilentTitle {
  readonly machine: MachineRef;
  readonly stock: StockLevelRef;
  /** Tystnadens start (ms): senaste försäljningen eller påfyllningen efter den. */
  readonly silenceStartMs: number;
  /** Senaste försäljningen (ms). */
  readonly lastSaleMs: number;
  /** Tystnadens slut (ms): så långt försäljningen är importerad. */
  readonly untilMs: number;
  /** Väntade pack under tystnaden. */
  readonly lambda: number;
  /** P(0 sålda) = e^−λ. */
  readonly zeroProbability: number;
  /** Sålda pack av titeln i mönstret. */
  readonly historyOrders: number;
  /** Pack av andra titlar som automaten sålde under tystnaden. */
  readonly others: number;
  /** Titelns order i automaten (för kronor i risk och underlaget). */
  readonly orders: readonly AnalyticsOrder[];
}

/** Senaste påfyllningen som tidpunkt. Bara ett datum = slutet av den dagen. */
function restockMs(value: string | null | undefined, timeZone: string): number | null {
  if (!value) return null;
  if (DATE_ONLY.test(value)) {
    try {
      return startOfBusinessDate(addDays(value as IsoDate, 1), timeZone);
    } catch {
      return null;
    }
  }
  return tryParseInstant(value);
}

/**
 * Tysta titlar vid `nowMs`. Automater i `skipMachines` (redan tysta automater) hoppas över.
 * Sorterade på automat och titel.
 */
export function silentTitles(
  input: TodoInput,
  nowMs: number,
  options: { readonly timeZone: string; readonly today: IsoDate },
  skipMachines: ReadonlySet<string> = new Set(),
): SilentTitle[] {
  const { timeZone, today } = options;
  const machines = input.machines.filter(
    (m) => isMachineActive(m, today) && !skipMachines.has(m.id),
  );
  if (machines.length === 0 || input.stock.length === 0) return [];
  const machineIds = new Set(machines.map((m) => m.id));
  const retired = retiredPairs(input.slotPeriods ?? [], today);

  const untilByMachine = new Map<string, number>();
  for (const c of input.salesDataUntil ?? []) {
    const ms = c.until ? tryParseInstant(c.until) : null;
    if (ms === null) continue;
    const prev = untilByMachine.get(c.machineId);
    if (prev === undefined || ms > prev) untilByMachine.set(c.machineId, ms);
  }

  // Order per automat, med tidpunkt när den är giltig.
  interface Timed {
    readonly order: AnalyticsOrder;
    readonly ms: number | null;
  }
  const byMachine = new Map<string, Timed[]>();
  for (const o of input.orders) {
    if (o.machineId === null || !machineIds.has(o.machineId) || o.businessDate > today) continue;
    const ms = o.orderedAt !== undefined ? tryParseInstant(o.orderedAt) : null;
    if (ms !== null && ms > nowMs) continue;
    const list = byMachine.get(o.machineId);
    const row = { order: o, ms };
    if (list) list.push(row);
    else byMachine.set(o.machineId, [row]);
  }

  // Kandidater med de billiga villkoren först; veckomönstret räknas bara för dem.
  interface Candidate {
    readonly machine: MachineRef;
    readonly stock: StockLevelRef;
    readonly silenceStartMs: number;
    readonly lastSaleMs: number;
    readonly untilMs: number;
    readonly sales: SaleInstant[];
    readonly orders: AnalyticsOrder[];
    readonly others: number;
  }
  const candidates: Candidate[] = [];
  const endOfDay = new Map<IsoDate, number>();
  const endOf = (d: IsoDate): number => {
    let ms = endOfDay.get(d);
    if (ms === undefined) {
      ms = startOfBusinessDate(addDays(d, 1), timeZone);
      endOfDay.set(d, ms);
    }
    return ms;
  };
  const machineById = new Map(machines.map((m) => [m.id, m]));
  for (const s of input.stock) {
    if (s.onHand <= 0) continue;
    const m = machineById.get(s.machineId);
    if (!m || retired.has(assortmentKey(s.machineId, s.titleId))) continue;
    const rows = byMachine.get(m.id) ?? [];
    const orders: AnalyticsOrder[] = [];
    const sales: SaleInstant[] = [];
    let lastSaleMs = -Infinity;
    let latestMs = -Infinity; // även order utan tidpunkt, räknade till dagens slut
    for (const r of rows) {
      if (r.order.titleId !== s.titleId) continue;
      orders.push(r.order);
      if (r.ms !== null) {
        sales.push({ id: r.order.id, ms: r.ms });
        if (r.ms > lastSaleMs) lastSaleMs = r.ms;
        if (r.ms > latestMs) latestMs = r.ms;
      } else {
        latestMs = Math.max(latestMs, endOf(r.order.businessDate));
      }
    }
    if (sales.length < SILENT_TITLE_MIN_HISTORY) continue;
    const restocked = restockMs(s.lastRestockedAt, timeZone);
    const silenceStartMs = Math.max(latestMs, restocked ?? -Infinity);
    const until = untilByMachine.get(m.id);
    const untilMs = until === undefined ? nowMs : Math.min(until, nowMs);
    if (untilMs - silenceStartMs < SILENT_TITLE_MIN_HOURS * HOUR_MS) continue;
    let others = 0;
    for (const r of rows) {
      if (r.order.titleId === s.titleId || r.ms === null) continue;
      if (r.ms >= silenceStartMs && r.ms <= untilMs) others++;
    }
    if (others < SILENT_TITLE_MIN_OTHERS) continue;
    candidates.push({
      machine: m,
      stock: s,
      silenceStartMs,
      lastSaleMs,
      untilMs,
      sales,
      orders,
      others,
    });
  }
  if (candidates.length === 0) return [];

  // En gemensam timkalender för alla kandidater.
  let fromMs = Infinity;
  let toMs = -Infinity;
  for (const c of candidates) {
    fromMs = Math.min(fromMs, c.untilMs - SILENT_TITLE_HISTORY_DAYS * DAY_MS);
    toMs = Math.max(toMs, c.untilMs);
  }
  let calendar: HourCalendar;
  try {
    calendar = buildHourCalendar(fromMs, toMs + HOUR_MS, timeZone);
  } catch {
    return [];
  }

  const out: SilentTitle[] = [];
  for (const c of candidates) {
    const profile = buildWeeklyProfile(
      calendar,
      c.sales,
      c.untilMs - SILENT_TITLE_HISTORY_DAYS * DAY_MS,
      c.silenceStartMs,
    );
    if (profile.totalOrders < SILENT_TITLE_MIN_HISTORY) continue;
    const { lambda } = expectedSales(profile, calendar, c.silenceStartMs, c.untilMs);
    const zeroProbability = poissonZero(lambda);
    if (!(zeroProbability < SILENT_TITLE_ALARM_P)) continue;
    out.push({
      machine: c.machine,
      stock: c.stock,
      silenceStartMs: c.silenceStartMs,
      lastSaleMs: c.lastSaleMs,
      untilMs: c.untilMs,
      lambda,
      zeroProbability,
      historyOrders: profile.totalOrders,
      others: c.others,
      orders: c.orders,
    });
  }
  return out.sort((a, b) =>
    a.machine.id !== b.machine.id
      ? a.machine.id < b.machine.id
        ? -1
        : 1
      : a.stock.titleId < b.stock.titleId
        ? -1
        : a.stock.titleId > b.stock.titleId
          ? 1
          : 0,
  );
}

/**
 * Punkter för tysta titlar. `skipMachines` = automater som redan står som tysta automater.
 * `refillStakeOre` = kronor i risk på påfyllningen av samma automat och titel
 * ('<automat>:<titel>'); den dras av här så att samma intäkt inte räknas två gånger i
 * "i risk 7 d" (summan blir den största av de två).
 */
export function silentTitleTodos(
  ctx: TodoContext,
  skipMachines: ReadonlySet<string>,
  refillStakeOre: ReadonlyMap<string, number> = new Map(),
): TodoItem[] {
  const { input, nowMs, today, options } = ctx;
  const tz = options.timeZone;
  return silentTitles(input, nowMs, { timeZone: tz, today }, skipMachines).map((s) => {
    const m = s.machine;
    const titleId = s.stock.titleId;
    const startDate = localParts(s.silenceStartMs, tz).date;
    const v = salesVelocity(dailyUnits(s.orders), {
      asOf: startDate,
      days: STAKE_WINDOW_DAYS,
      ...(m.activeFrom !== null ? { activeFrom: m.activeFrom } : {}),
    });
    const windowOrders = s.orders.filter(
      (o) => o.businessDate >= v.start && o.businessDate <= v.end,
    );
    const revenueOre = revenue(windowOrders, input.settings);
    const ownStakeOre = v.days > 0 ? mulDivRound(revenueOre, HORIZON_DAYS, v.days) : 0;
    const atStakeOre = Math.max(0, ownStakeOre - (refillStakeOre.get(`${m.id}:${titleId}`) ?? 0));
    const level = s.zeroProbability < SILENT_TITLE_NOW_P ? "now" : "soon";
    const hours = floorDiv(Math.floor(s.untilMs - s.silenceStartMs), HOUR_MS);
    const lambdaTenths = Math.round(s.lambda * 10);
    const silenceStartIso = new Date(s.silenceStartMs).toISOString();
    return {
      key: `silent-title:${m.id}:${titleId}`,
      fingerprint: silenceStartIso,
      kind: "silent-title",
      level,
      urgency: urgencyOf(level, atStakeOre),
      atStakeOre,
      daysLeft: null,
      title: `${ctx.titleName(titleId)} i ${m.name} har inte sålt på ${silenceText(hours)}`,
      detail: `${plural(s.stock.onHand, "pack", "pack")} i facket · brukar sälja ${tenths(lambdaTenths)} på den tiden · automaten sålde ${plural(s.others, "annan", "andra")}`,
      evidence: evidence({
        rule: `Titeln har pack i automaten men har inte sålt, fast automaten sålt minst ${SILENT_TITLE_MIN_OTHERS} andra pack. Sannolikheten för noll försäljning är under 1 %, räknat på samma veckodagar och timmar de senaste ${SILENT_TITLE_HISTORY_DAYS} dagarna.`,
        period: v.days > 0 ? { start: v.start, end: v.end } : null,
        orderIds: windowOrders.map((o) => o.id),
        dates: [startDate],
        titleIds: [titleId],
        machineIds: [m.id],
        figures: [
          { key: "silentHours", label: "Timmar utan försäljning", value: hours, unit: "hours" },
          { key: "onHand", label: "Pack i facket", value: s.stock.onHand, unit: "packs" },
          {
            key: "expectedTenths",
            label: "Väntade pack under tystnaden",
            value: lambdaTenths,
            unit: "tenths",
          },
          {
            key: "otherPacks",
            label: "Andra pack sålda under tystnaden",
            value: s.others,
            unit: "packs",
          },
          {
            key: "historyOrders",
            label: "Sålda pack i mönstret",
            value: s.historyOrders,
            unit: "count",
          },
          { key: "revenueInWindowOre", label: "Intäkt i fönstret", value: revenueOre, unit: "ore" },
          { key: "atStakeOre", label: "Intäkt i risk 7 dagar", value: atStakeOre, unit: "ore" },
        ],
      }),
      link: `/drift/automat/${encodeURIComponent(m.id)}`,
      action: {
        kind: "open-machine",
        label: "Öppna automaten",
        params: { machineId: m.id, titleId },
      },
    } satisfies TodoItem;
  });
}
