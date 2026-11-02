/**
 * Automater som inte sålt på över 48 timmar (bara automater i drift i dag).
 *
 *   tyst tid      = nu − senaste orderns betaltidpunkt (orderedAt)
 *   flaggas när     tyst tid > gränsen (standard 48 h)
 *   kronor i risk = automatens intäkt per dag de 14 dagarna t.o.m. senaste försäljningsdag × 7
 *   nivå          = alltid 'now' (en tyst automat är ofta trasig eller tom)
 *
 * Order utan (giltig) betaltidpunkt räknas som sålda i slutet av sin affärsdag (00:00 nästa
 * dag i organisationens tidszon), så den tysta tiden underskattas hellre än överskattas.
 * En automat utan några order flaggas när det gått mer än gränsen sedan driftstart
 * (00:00 svensk tid dagen `activeFrom`): i drift sedan 31 okt. → 59 timmar kl. 11 den 2 nov.
 */

import {
  addDays,
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
import { HOUR_MS, localParts, startOfBusinessDate, tryParseInstant } from "./time";
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
  /** Betaltidpunkten, eller `null` när bara affärsdatumet är känt (saknad eller ogiltig `orderedAt`). */
  readonly ms: number | null;
  /**
   * Senast möjliga försäljningstidpunkt: betaltidpunkten, eller slutet av affärsdagen
   * (00:00 nästa dag) när bara datumet är känt. Tyst tid räknas härifrån.
   */
  readonly latestMs: number;
}

function compareLastSale(a: LastSale, b: LastSale): number {
  if (a.latestMs !== b.latestMs) return a.latestMs - b.latestMs;
  const ta = a.ms !== null ? 1 : 0;
  const tb = b.ms !== null ? 1 : 0;
  if (ta !== tb) return ta - tb;
  return a.order.id < b.order.id ? -1 : a.order.id > b.order.id ? 1 : 0;
}

/**
 * Senaste försäljningen. En order utan giltig betaltidpunkt räknas som såld i slutet av sin
 * affärsdag, så att den tysta tiden aldrig överskattas. En ogiltig `orderedAt` hoppas över
 * (ordern räknas på datum) i stället för att stoppa hela beräkningen.
 */
function lastSale(orders: readonly AnalyticsOrder[], timeZone: string): LastSale | null {
  let best: LastSale | null = null;
  const endOfDay = new Map<IsoDate, number>();
  for (const o of orders) {
    const ms = o.orderedAt !== undefined ? tryParseInstant(o.orderedAt) : null;
    let latestMs = ms;
    if (latestMs === null) {
      latestMs = endOfDay.get(o.businessDate) ?? null;
      if (latestMs === null) {
        latestMs = startOfBusinessDate(addDays(o.businessDate, 1), timeZone);
        endOfDay.set(o.businessDate, latestMs);
      }
    }
    // Senast först; vid lika tid vinner en order med känd tidpunkt, sedan högst id.
    const candidate: LastSale = { order: o, ms, latestMs };
    if (!best || compareLastSale(candidate, best) > 0) best = candidate;
  }
  return best;
}

/** Punkter för automater som inte sålt. */
export function staleMachineTodos(ctx: TodoContext): TodoItem[] {
  const { input, today, nowMs, options } = ctx;
  const thresholdMs = options.staleHours * HOUR_MS;
  const ordersByMachine = new Map<string, AnalyticsOrder[]>();
  for (const o of input.orders) {
    if (o.machineId === null || o.businessDate > today) continue;
    const list = ordersByMachine.get(o.machineId);
    if (list) list.push(o);
    else ordersByMachine.set(o.machineId, [o]);
  }

  // Hur långt försäljningen är importerad per automat. Tystnaden räknas fram till dit
  // (högst till nu, minst till senaste försäljningen), som maskinhälsan på Drift.
  const untilByMachine = new Map<string, number>();
  for (const c of input.salesDataUntil ?? []) {
    const ms = c.until ? tryParseInstant(c.until) : null;
    if (ms === null) continue;
    const prev = untilByMachine.get(c.machineId);
    if (prev === undefined || ms > prev) untilByMachine.set(c.machineId, ms);
  }
  const endFor = (machineId: string, sinceMs: number): number => {
    const until = untilByMachine.get(machineId);
    return until === undefined ? nowMs : Math.max(Math.min(until, nowMs), sinceMs);
  };

  const out: TodoItem[] = [];
  for (const m of input.machines) {
    if (!isMachineActive(m, today)) continue;
    const orders = ordersByMachine.get(m.id) ?? [];
    const last = lastSale(orders, options.timeZone);
    if (!last) {
      if (m.activeFrom === null) continue;
      const startMs = startOfBusinessDate(m.activeFrom, options.timeZone);
      const sinceMs = endFor(m.id, startMs) - startMs;
      if (sinceMs <= thresholdMs) continue;
      out.push(neverSold(ctx, m, m.activeFrom, floorDiv(sinceMs, HOUR_MS)));
      continue;
    }
    const silentMs = endFor(m.id, last.latestMs) - last.latestMs;
    if (silentMs <= thresholdMs) continue;
    out.push(silentMachine(ctx, m, last, orders, floorDiv(silentMs, HOUR_MS)));
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

function neverSold(
  ctx: TodoContext,
  m: MachineRef,
  activeFrom: IsoDate,
  silentHours: number,
): TodoItem {
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
    detail: `I drift sedan ${day(activeFrom)} (${silenceText(silentHours)}). Ingen order är registrerad.`,
    evidence: evidence({
      rule: `Automaten är i drift och har inte sålt på över ${ctx.options.staleHours} timmar.`,
      dates: [activeFrom],
      machineIds: [m.id],
      figures: [
        {
          key: "silentHours",
          label: "Timmar i drift utan försäljning",
          value: silentHours,
          unit: "hours",
        },
        { key: "daysActive", label: "Dagar sedan driftstart", value: days, unit: "days" },
      ],
    }),
    link: links.machine(m.id),
  };
}
