/**
 * Besöksplan för en vecka: vilka automater som behöver besök, vad som ska med och i vilken
 * ordning.
 *
 * 1. Behov per automat och titel (domain.salesVelocity över `windowDays` dagar t.o.m. i dag):
 *      slutdatum   = domain.stockoutDate(i dag, i lager, takt)
 *      senast      = slutdatum − bufferDays (eller ExtraVisit.needBy)
 *    Automatens `needBy` är den tidigaste av titlarnas och extrabesökens. Automaten behöver
 *    besök om needBy ligger inom planens 7 dagar (eller tidigare).
 * 2. Besöksdag = senaste besöksdag (visitWeekdays) som är ≤ needBy, så att varje besök fyller
 *    på så sent som möjligt. Finns ingen sådan dag blir det första besöksdagen (sent besök).
 * 3. Fler än maxStopsPerDay: den minst brådskande flyttas till närmaste tidigare dag med plats,
 *    annars nästa senare dag (sent), annars hamnar den i `overflow`.
 * 4. Färre besök än minStopsPerTrip en dag: besöken flyttas till närmaste tidigare dag med
 *    besök och plats, så att antalet resor minskar. Att flytta tidigare bryter aldrig needBy.
 * 5. Packlista per besök och titel:
 *      lager vid besök = max(0, i lager − golv(sålda i fönstret × dagar till besöket / fönstrets dagar))
 *      mål             = kapacitet, eller tak(sålda × coverDays / fönstrets dagar) när den saknas
 *      antal           = max(0, mål − lager vid besök), begränsat av centrallagret i
 *                        brådskeordning (dag, needBy, automat)
 * 6. Ordning per dag: med koordinater för alla besök närmaste granne + 2-opt från depån
 *    (route.ts); annars efter needBy, sedan namn.
 */

import {
  addDays,
  ceilDiv,
  compareDates,
  dailyUnits,
  dayOfWeek,
  daysBetween,
  DomainError,
  floorDiv,
  salesVelocity,
  stockoutDate,
  type IsoDate,
  type SalesVelocity,
} from "@/domain";
import { evidence, isMachineActive, links, nameLookup } from "@/analytics/todos/common";
import { plural, ratioTenths, sentence, weekdayDay } from "@/analytics/todos/text";
import { businessDateAt, DEFAULT_TIME_ZONE } from "@/analytics/todos/time";
import { formatInt, NBSP } from "@/lib/format";
import { planRoute } from "./route";
import type { AnalyticsOrder } from "@/analytics/todos/types";
import type {
  PackLine,
  VisitDay,
  VisitMachine,
  VisitPlan,
  VisitPlanInput,
  VisitPlanOptions,
  VisitStop,
} from "./types";

/** Standardvärden för besöksplanen. */
export const VISIT_DEFAULTS: Required<Omit<VisitPlanOptions, "start" | "stockDate">> = {
  timeZone: DEFAULT_TIME_ZONE,
  visitWeekdays: [1, 2, 3, 4, 5],
  maxStopsPerDay: 8,
  windowDays: 14,
  bufferDays: 1,
  coverDays: 7,
  minStopsPerTrip: 2,
};

const PLAN_DAYS = 7;

function assertInt(v: number, label: string, min: number): void {
  if (!Number.isSafeInteger(v) || v < min) {
    throw new DomainError("invalid_input", `${label} måste vara ett heltal ≥ ${min}, fick ${v}.`);
  }
}

/** Kilometer med en decimal: 12 430 m → "12,4 km". */
export function kmText(meters: number): string {
  const tenthsKm = Math.round(meters / 100);
  return `${formatInt(Math.floor(tenthsKm / 10))},${tenthsKm % 10}${NBSP}km`;
}

interface TitleNeed {
  readonly titleId: string;
  readonly onHand: number;
  readonly velocity: SalesVelocity;
  readonly capacity: number | null;
  readonly stockout: IsoDate | null;
  readonly orderIds: string[];
}

interface MachineNeed {
  readonly machine: VisitMachine;
  readonly needBy: IsoDate | null;
  readonly titles: TitleNeed[];
  readonly reasons: { readonly needBy: IsoDate; readonly text: string }[];
}

interface Assignment {
  readonly need: MachineNeed;
  readonly needBy: IsoDate;
  day: IsoDate | null;
}

/**
 * Veckoplanen. `now` avgör dagens affärsdatum (lager och takt räknas från i dag).
 * Se filens beskrivning för reglerna.
 */
export function planVisits(input: VisitPlanInput, now: Date | string | number): VisitPlan {
  const o = {
    ...VISIT_DEFAULTS,
    ...Object.fromEntries(Object.entries(input.options ?? {}).filter(([, v]) => v !== undefined)),
  } as Required<Omit<VisitPlanOptions, "start" | "stockDate">> & {
    start?: IsoDate;
    stockDate?: IsoDate;
  };
  assertInt(o.maxStopsPerDay, "Besök per dag", 1);
  assertInt(o.windowDays, "Fönstret", 1);
  assertInt(o.bufferDays, "Marginalen", 0);
  assertInt(o.coverDays, "Dagar att fylla för", 1);
  assertInt(o.minStopsPerTrip, "Minsta antal besök per resa", 1);
  for (const w of o.visitWeekdays) assertInt(w, "Veckodag", 1);

  const today = businessDateAt(now, o.timeZone);
  const start = input.options?.start ?? today;
  const stockDate = input.options?.stockDate ?? today;
  if (start < today)
    throw new DomainError("invalid_input", `Planen kan inte börja före i dag (${today}).`);
  const end = addDays(start, PLAN_DAYS - 1);
  const visitDays: IsoDate[] = [];
  for (let i = 0; i < PLAN_DAYS; i++) {
    const d = addDays(start, i);
    if (o.visitWeekdays.includes(dayOfWeek(d))) visitDays.push(d);
  }
  const titleName = nameLookup(input.titles);
  const machineName = nameLookup(input.machines);

  const needs = machineNeeds(input, today, o, titleName);
  const assignments: Assignment[] = [];
  const notNeeded: { machineId: string; needBy: IsoDate | null }[] = [];
  for (const n of needs) {
    if (n.needBy === null || n.needBy > end)
      notNeeded.push({ machineId: n.machine.id, needBy: n.needBy });
    else assignments.push({ need: n, needBy: n.needBy, day: null });
  }

  // 2. Senaste besöksdag ≤ needBy, annars första.
  for (const a of assignments) {
    const fit = visitDays.filter((d) => d <= a.needBy);
    a.day = fit[fit.length - 1] ?? visitDays[0] ?? null;
  }
  // 3. Kapacitet per dag.
  const overflow: string[] = [];
  const onDay = (d: IsoDate) => assignments.filter((a) => a.day === d);
  for (let di = 0; di < visitDays.length; di++) {
    const d = visitDays[di] as IsoDate;
    let list = onDay(d);
    while (list.length > o.maxStopsPerDay) {
      const least = [...list].sort(
        (x, y) =>
          compareDates(y.needBy, x.needBy) || (x.need.machine.id < y.need.machine.id ? 1 : -1),
      )[0] as Assignment;
      const earlier = visitDays
        .slice(0, di)
        .reverse()
        .find((e) => onDay(e).length < o.maxStopsPerDay);
      const later = visitDays.slice(di + 1).find((e) => onDay(e).length < o.maxStopsPerDay);
      least.day = earlier ?? later ?? null;
      if (least.day === null) overflow.push(least.need.machine.id);
      list = onDay(d);
    }
  }
  // 4. Slå ihop små dagar med tidigare dagar.
  for (let di = visitDays.length - 1; di > 0; di--) {
    const d = visitDays[di] as IsoDate;
    const list = onDay(d);
    if (list.length === 0 || list.length >= o.minStopsPerTrip) continue;
    const target = visitDays
      .slice(0, di)
      .reverse()
      .find((e) => {
        const n = onDay(e).length;
        return n > 0 && n + list.length <= o.maxStopsPerDay;
      });
    if (target) for (const a of list) a.day = target;
  }

  // 5–6. Packlistor och ordning.
  const warehouse = input.warehouseStock
    ? new Map(input.warehouseStock.map((w) => [w.titleId, Math.max(0, w.onHand)]))
    : null;
  const days: VisitDay[] = [];
  for (const d of visitDays) {
    const list = onDay(d).sort(
      (x, y) =>
        compareDates(x.needBy, y.needBy) ||
        machineName(x.need.machine.id).localeCompare(machineName(y.need.machine.id), "sv") ||
        (x.need.machine.id < y.need.machine.id ? -1 : 1),
    );
    if (list.length === 0) continue;
    const draft = list.map((a) => buildStop(a, d, stockDate, o, titleName, machineName, warehouse));
    days.push(
      orderDay(
        d,
        draft,
        input.depot ?? null,
        list.map((a) => a.need.machine),
      ),
    );
  }
  const totalPacks = days.reduce((s, d) => s + d.totalPacks, 0);
  const stopsCount = days.reduce((s, d) => s + d.stops.length, 0);
  return {
    period: { start, end },
    days,
    notNeeded: notNeeded.sort((a, b) => (a.machineId < b.machineId ? -1 : 1)),
    overflow: overflow.sort(),
    totalPacks,
    summary:
      stopsCount === 0
        ? sentence(`Inga besök behövs ${weekdayDay(start)}–${weekdayDay(end)}`)
        : `${plural(stopsCount, "besök", "besök")} på ${plural(days.length, "dag", "dagar")}, ${plural(totalPacks, "pack", "pack")}.`,
    evidence: evidence({
      rule: `Besök senast ${plural(o.bufferDays, "dag", "dagar")} före beräknat slut, vid takten de senaste ${o.windowDays} dagarna; så sent som möjligt på besöksdagarna, högst ${o.maxStopsPerDay} per dag.`,
      period: { start, end },
      machineIds: days.flatMap((d) => d.stops.map((s) => s.machineId)),
      dates: days.map((d) => d.date),
      figures: [
        { key: "stops", label: "Besök", value: stopsCount, unit: "count" },
        { key: "packs", label: "Pack att ta med", value: totalPacks, unit: "packs" },
      ],
    }),
  };
}

function machineNeeds(
  input: VisitPlanInput,
  today: IsoDate,
  o: Required<Omit<VisitPlanOptions, "start" | "stockDate">>,
  titleName: (id: string) => string,
): MachineNeed[] {
  const capacity = new Map(
    (input.capacities ?? []).map((c) => [`${c.machineId}\u0000${c.titleId}`, c.capacity]),
  );
  const ordersByPair = new Map<string, AnalyticsOrder[]>();
  for (const ord of input.orders) {
    if (ord.machineId === null || ord.businessDate > today) continue;
    const k = `${ord.machineId}\u0000${ord.titleId}`;
    const list = ordersByPair.get(k);
    if (list) list.push(ord);
    else ordersByPair.set(k, [ord]);
  }
  const stockByPair = new Map<string, number>();
  for (const s of input.stock) {
    const k = `${s.machineId}\u0000${s.titleId}`;
    stockByPair.set(k, (stockByPair.get(k) ?? 0) + s.onHand);
  }
  const out: MachineNeed[] = [];
  for (const m of input.machines) {
    if (!isMachineActive(m, today)) continue;
    const pairs = new Set<string>();
    for (const k of [...stockByPair.keys(), ...capacity.keys(), ...ordersByPair.keys()]) {
      if (k.startsWith(`${m.id}\u0000`)) pairs.add(k);
    }
    const titles: TitleNeed[] = [];
    const reasons: { needBy: IsoDate; text: string }[] = [];
    for (const k of [...pairs].sort()) {
      const titleId = k.slice(m.id.length + 1);
      const onHand = Math.max(0, stockByPair.get(k) ?? 0);
      const orders = ordersByPair.get(k) ?? [];
      const v = salesVelocity(dailyUnits(orders), {
        asOf: today,
        days: o.windowDays,
        ...(m.activeFrom !== null ? { activeFrom: m.activeFrom } : {}),
      });
      if (v.units === 0 && !capacity.has(k)) continue;
      const stockout = stockoutDate(today, onHand, v);
      const windowOrders = orders.filter(
        (x) => x.businessDate >= v.start && x.businessDate <= v.end,
      );
      titles.push({
        titleId,
        onHand,
        velocity: v,
        capacity: capacity.get(k) ?? null,
        stockout,
        orderIds: windowOrders.map((x) => x.id),
      });
      if (stockout !== null) {
        const needBy = addDays(stockout, -o.bufferDays);
        reasons.push({
          needBy,
          text:
            onHand === 0
              ? `${titleName(titleId)} är slut (${ratioTenths(v.units, v.days)} pack/dag)`
              : `${titleName(titleId)} tar slut ${weekdayDay(stockout)} (${onHand} kvar, ${ratioTenths(v.units, v.days)} pack/dag)`,
        });
      }
    }
    for (const e of input.extraVisits ?? []) {
      if (e.machineId === m.id) reasons.push({ needBy: e.needBy, text: e.reason });
    }
    reasons.sort((a, b) => compareDates(a.needBy, b.needBy) || (a.text < b.text ? -1 : 1));
    out.push({ machine: m, needBy: reasons[0]?.needBy ?? null, titles, reasons });
  }
  return out;
}

function buildStop(
  a: Assignment,
  day: IsoDate,
  stockDate: IsoDate,
  o: Required<Omit<VisitPlanOptions, "start" | "stockDate">>,
  titleName: (id: string) => string,
  machineName: (id: string) => string,
  warehouse: Map<string, number> | null,
): Omit<VisitStop, "sequence" | "distanceFromPreviousMeters"> {
  // Dagar med försäljning mellan saldots dag och besöket.
  const daysUntil = Math.max(0, daysBetween(stockDate, day));
  const packs: PackLine[] = [];
  for (const t of a.need.titles) {
    const v = t.velocity;
    const soldUntil = v.days > 0 ? floorDiv(v.units * daysUntil, v.days) : 0;
    const projected = Math.max(0, t.onHand - soldUntil);
    const target = t.capacity ?? (v.days > 0 ? ceilDiv(v.units * o.coverDays, v.days) : 0);
    const wanted = Math.max(0, target - projected);
    let quantity = wanted;
    if (warehouse) {
      const available = warehouse.get(t.titleId) ?? 0;
      quantity = Math.min(wanted, available);
      warehouse.set(t.titleId, available - quantity);
    }
    if (wanted === 0) continue;
    packs.push({
      titleId: t.titleId,
      titleName: titleName(t.titleId),
      quantity,
      onHandNow: t.onHand,
      projectedAtVisit: projected,
      target,
      capacity: t.capacity,
      shortBy: wanted - quantity,
      stockoutDate: t.stockout,
    });
  }
  packs.sort((x, y) => y.quantity - x.quantity || (x.titleId < y.titleId ? -1 : 1));
  const reasons = a.need.reasons.map((r) => r.text);
  const short = packs.filter((p) => p.shortBy > 0);
  if (short.length > 0) {
    reasons.push(
      `Centrallagret räcker inte: ${short.map((p) => `${p.shortBy} × ${p.titleName}`).join(", ")} saknas`,
    );
  }
  const totalPacks = packs.reduce((s, p) => s + p.quantity, 0);
  return {
    machineId: a.need.machine.id,
    machineName: machineName(a.need.machine.id),
    needBy: a.needBy,
    late: day > a.needBy,
    reasons,
    packs,
    totalPacks,
    evidence: evidence({
      rule: sentence(
        `Besök senast ${weekdayDay(a.needBy)}; fyll till ${packs.some((p) => p.capacity !== null) ? "kapacitet" : `${o.coverDays} dagars försäljning`}`,
      ),
      period: a.need.titles[0]
        ? { start: a.need.titles[0].velocity.start, end: a.need.titles[0].velocity.end }
        : null,
      orderIds: a.need.titles.flatMap((t) => t.orderIds),
      dates: [day, a.needBy],
      titleIds: packs.map((p) => p.titleId),
      machineIds: [a.need.machine.id],
      figures: [
        { key: "totalPacks", label: "Pack att ta med", value: totalPacks, unit: "packs" },
        { key: "daysUntilVisit", label: "Dagar till besöket", value: daysUntil, unit: "days" },
      ],
    }),
    link: links.machine(a.need.machine.id),
  };
}

function orderDay(
  date: IsoDate,
  draft: Omit<VisitStop, "sequence" | "distanceFromPreviousMeters">[],
  depot: VisitPlanInput["depot"],
  machines: readonly VisitMachine[],
): VisitDay {
  const loc = new Map(machines.map((m) => [m.id, m.location ?? null]));
  const allLocated = draft.every((s) => loc.get(s.machineId));
  let ordered = draft;
  let legs: (number | null)[] = draft.map(() => null);
  let totalMeters: number | null = null;
  if (allLocated) {
    const route = planRoute(
      draft.map((s) => ({
        id: s.machineId,
        location: loc.get(s.machineId) as NonNullable<VisitMachine["location"]>,
      })),
      depot ?? null,
    );
    const byId = new Map(draft.map((s) => [s.machineId, s]));
    ordered = route.order.map((id) => byId.get(id) as (typeof draft)[number]);
    legs = route.legs;
    totalMeters = route.totalMeters;
  }
  const stops: VisitStop[] = ordered.map((s, i) => ({
    ...s,
    sequence: i + 1,
    distanceFromPreviousMeters: legs[i] ?? null,
  }));
  const load = new Map<string, { titleId: string; titleName: string; quantity: number }>();
  for (const s of stops) {
    for (const p of s.packs) {
      const prev = load.get(p.titleId);
      if (prev) prev.quantity += p.quantity;
      else
        load.set(p.titleId, { titleId: p.titleId, titleName: p.titleName, quantity: p.quantity });
    }
  }
  const totalPacks = stops.reduce((s, x) => s + x.totalPacks, 0);
  const parts = [plural(stops.length, "besök", "besök"), plural(totalPacks, "pack", "pack")];
  if (totalMeters !== null) parts.push(kmText(totalMeters));
  return {
    date,
    stops,
    load: [...load.values()].sort(
      (a, b) => b.quantity - a.quantity || (a.titleId < b.titleId ? -1 : 1),
    ),
    totalPacks,
    totalMeters,
    routeMethod: allLocated ? "distance" : "urgency",
    title: `${weekdayDay(date)}: ${parts.join(", ")}`,
  };
}
