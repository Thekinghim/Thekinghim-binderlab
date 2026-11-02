/**
 * Automater som inte sålt på över 48 timmar (bara automater i drift i dag).
 *
 *   tyst tid      = nu − senaste orderns betaltidpunkt (orderedAt)
 *   flaggas när     tyst tid > gränsen (standard 48 h)
 *   kronor i risk = automatens intäkt per dag de 14 dagarna t.o.m. senaste försäljningsdag × 7
 *   nivå          = alltid 'now' (en tyst automat är ofta trasig eller tom)
 *
 * Order utan betaltidpunkt räknas på affärsdatum: om automatens senaste affärsdatum är senare
 * än den senaste tidpunkten används datumet, och automaten flaggas först när det gått fler än
 * tak(gräns / 24) hela dagar sedan dess (för 48 h: ingen försäljning i förrgår, i går eller i dag).
 * En automat utan några order flaggas om den varit i drift i fler än så många dagar.
 */

import {
  ceilDiv,
  dailyUnits,
  daysBetween,
  floorDiv,
  mulDivRound,
  revenue,
  salesVelocity,
  type IsoDate,
} from "@/domain";
import { evidence, isMachineActive, links } from "./common";
import { HORIZON_DAYS, urgencyOf, type TodoContext } from "./context";
import { HOUR_MS, localParts, parseInstant } from "./time";
import { day, kr, plural, ratioTenths } from "./text";
import type { AnalyticsOrder, MachineRef, TodoItem } from "./types";

/** "52 timmar" under 72 timmar, annars "3 dygn". */
export function silenceText(hours: number): string {
  return hours < 72
    ? plural(hours, "timme", "timmar")
    : plural(floorDiv(hours, 24), "dygn", "dygn");
}

interface LastSale {
  readonly order: AnalyticsOrder;
  /** Tidpunkten, eller `null` när bara affärsdatumet är känt. */
  readonly ms: number | null;
}

function lastSale(orders: readonly AnalyticsOrder[], timeZone: string): LastSale | null {
  let timed: { order: AnalyticsOrder; ms: number } | null = null;
  let dated: AnalyticsOrder | null = null;
  for (const o of orders) {
    if (o.orderedAt !== undefined) {
      const ms = parseInstant(o.orderedAt);
      if (!timed || ms > timed.ms || (ms === timed.ms && o.id > timed.order.id))
        timed = { order: o, ms };
    }
    if (
      !dated ||
      o.businessDate > dated.businessDate ||
      (o.businessDate === dated.businessDate && o.id > dated.id)
    ) {
      dated = o;
    }
  }
  if (timed && (!dated || localParts(timed.ms, timeZone).date >= dated.businessDate)) return timed;
  return dated ? { order: dated, ms: null } : null;
}

/** Punkter för automater som inte sålt. */
export function staleMachineTodos(ctx: TodoContext): TodoItem[] {
  const { input, today, nowMs, options } = ctx;
  const thresholdMs = options.staleHours * HOUR_MS;
  const thresholdDays = ceilDiv(options.staleHours, 24);
  const ordersByMachine = new Map<string, AnalyticsOrder[]>();
  for (const o of input.orders) {
    if (o.machineId === null || o.businessDate > today) continue;
    const list = ordersByMachine.get(o.machineId);
    if (list) list.push(o);
    else ordersByMachine.set(o.machineId, [o]);
  }

  const out: TodoItem[] = [];
  for (const m of input.machines) {
    if (!isMachineActive(m, today)) continue;
    const orders = ordersByMachine.get(m.id) ?? [];
    const last = lastSale(orders, options.timeZone);
    if (!last) {
      if (m.activeFrom === null || daysBetween(m.activeFrom, today) <= thresholdDays) continue;
      out.push(neverSold(ctx, m, m.activeFrom));
      continue;
    }
    let silentHours: number;
    if (last.ms !== null) {
      if (nowMs - last.ms <= thresholdMs) continue;
      silentHours = floorDiv(nowMs - last.ms, HOUR_MS);
    } else {
      const days = daysBetween(last.order.businessDate, today);
      if (days <= thresholdDays) continue;
      silentHours = (days - 1) * 24; // minst så många timmar har gått
    }
    out.push(silentMachine(ctx, m, last, orders, silentHours));
  }
  return out;
}

function silentMachine(
  ctx: TodoContext,
  m: MachineRef,
  last: LastSale,
  orders: readonly AnalyticsOrder[],
  silentHours: number,
): TodoItem {
  const { input, options } = ctx;
  const lastDate: IsoDate = last.order.businessDate;
  const v = salesVelocity(dailyUnits(orders), {
    asOf: lastDate,
    days: options.refillWindowDays,
    ...(m.activeFrom !== null ? { activeFrom: m.activeFrom } : {}),
  });
  const windowOrders = orders.filter((o) => o.businessDate >= v.start && o.businessDate <= v.end);
  const revenueOre = revenue(windowOrders, input.settings);
  const atStakeOre = v.days > 0 ? mulDivRound(revenueOre, HORIZON_DAYS, v.days) : 0;
  const when =
    last.ms !== null
      ? `${day(lastDate)} ${localParts(last.ms, options.timeZone).time}`
      : day(lastDate);
  const usual =
    v.days > 0 && v.units > 0
      ? ` Den brukar sälja ${ratioTenths(v.units, v.days)} pack och ${kr(mulDivRound(revenueOre, 1, v.days))} per dag.`
      : "";
  return {
    key: `stale-machine:${m.id}`,
    fingerprint: last.order.id,
    kind: "stale-machine",
    level: "now",
    urgency: urgencyOf("now", atStakeOre),
    atStakeOre,
    daysLeft: null,
    title: `${m.name} har inte sålt på ${silenceText(silentHours)}`,
    detail: `Senaste order ${when} (${ctx.titleName(last.order.titleId)}).${usual}`,
    evidence: evidence({
      rule: `Automaten är i drift och har inte sålt på över ${options.staleHours} timmar.`,
      period: v.days > 0 ? { start: v.start, end: v.end } : null,
      orderIds: [last.order.id, ...windowOrders.map((o) => o.id)],
      dates: [lastDate],
      titleIds: [last.order.titleId],
      machineIds: [m.id],
      figures: [
        { key: "silentHours", label: "Timmar utan försäljning", value: silentHours, unit: "hours" },
        { key: "unitsInWindow", label: "Sålda pack före tystnaden", value: v.units, unit: "packs" },
        { key: "windowDays", label: "Dagar i fönstret", value: v.days, unit: "days" },
        { key: "revenueInWindowOre", label: "Intäkt i fönstret", value: revenueOre, unit: "ore" },
        { key: "atStakeOre", label: "Intäkt i risk 7 dagar", value: atStakeOre, unit: "ore" },
      ],
    }),
    link: links.machine(m.id),
  };
}

function neverSold(ctx: TodoContext, m: MachineRef, activeFrom: IsoDate): TodoItem {
  const days = daysBetween(activeFrom, ctx.today);
  return {
    key: `stale-machine:${m.id}`,
    fingerprint: "none",
    kind: "stale-machine",
    level: "now",
    urgency: urgencyOf("now", 0),
    atStakeOre: 0,
    daysLeft: null,
    title: `${m.name} har inte sålt något sedan driftstart`,
    detail: `I drift sedan ${day(activeFrom)} (${plural(days, "dag", "dagar")}). Ingen order är registrerad.`,
    evidence: evidence({
      rule: `Automaten är i drift och har inte sålt på över ${ctx.options.staleHours} timmar.`,
      dates: [activeFrom],
      machineIds: [m.id],
      figures: [{ key: "daysActive", label: "Dagar i drift", value: days, unit: "days" }],
    }),
    link: links.machine(m.id),
  };
}
