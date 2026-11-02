/**
 * Maskinhälsa: status per automat.
 *
 * Ordning för beslutet (första som gäller):
 *   1. Inte i drift i dag (före driftstart, efter slutdag, arkiverad)          → 'inactive'
 *   2. Leverantören: senaste anslutningshändelse är offline, eller heartbeat
 *      saknas längre än gränsen (om heartbeat används)                         → 'offline' (vendor)
 *   3. Leverantören: senaste felhändelse är ett fel som inte åtgärdats         → 'fault' (vendor)
 *   4. Lagret i automaten är 0 pack (om lagret är känt)                        → 'empty' (stock)
 *   5. Tystnaden är avvikande (nedan):
 *        och har varat ≥ offlineAfterHours och leverantören saknar
 *        anslutningsdata för automaten                                         → 'offline' (sales)
 *        annars                                                                → 'suspected_fault' (sales)
 *   6. Historiken har färre order än minHistoryOrders                          → 'unknown'
 *   7. Annars                                                                  → 'ok'
 *
 * Avvikande tystnad:
 *   tystnad      = från senaste försäljning (eller driftstart) till nu
 *   historik     = historyWeeks veckor före tystnaden, utan timmar före driftstart,
 *                  efter slutdag eller när leverantören rapporterat offline
 *   förväntat λ  = Σ över tystnadens timmar: takten för samma veckodag och timme i historiken
 *   P(0)         = e^−λ (Poisson)
 *   avvikande    ⇔ tystnaden ≥ minSilenceMinutes och P(0) i hela bp < alarmProbabilityBp
 *                  och historiken har minst minHistoryOrders order
 *
 * En tyst natt eller ett stängt köpcentrum ger λ ≈ 0 eftersom historiken inte har någon
 * försäljning de timmarna, och larmar därför inte.
 */

import { addDays, assertIsoDate, DomainError, type IsoDate } from "@/domain";
import { evidence, isMachineActive, links, nameLookup } from "@/analytics/todos/common";
import { day, plural, sentence, tenths } from "@/analytics/todos/text";
import {
  businessDateAt,
  DEFAULT_TIME_ZONE,
  localParts,
  parseInstant,
} from "@/analytics/todos/time";
import {
  buildHourCalendar,
  HOUR_MS,
  localDayStartMs,
  MINUTE_MS,
  type HourCalendar,
} from "./calendar";
import { poissonZero, probabilityToBp } from "./poisson";
import { buildWeeklyProfile, expectedSales, milliToTenths, type SaleInstant } from "./profile";
import { durationText, probabilityText, slotsText, whenText } from "./text";
import type { EvidenceFigure } from "@/analytics/todos/types";
import type {
  AnalyticsOrder,
  HealthInput,
  HealthOptions,
  HealthSource,
  HealthStatus,
  MachineHealth,
  MachineRef,
  MachineSignal,
  SilenceAnalysis,
} from "./types";

/** Standardvärden för hälsoberäkningen. */
export const HEALTH_DEFAULTS: Required<HealthOptions> = {
  timeZone: DEFAULT_TIME_ZONE,
  historyWeeks: 8,
  alarmProbabilityBp: 100,
  minHistoryOrders: 20,
  minSilenceMinutes: 60,
  offlineAfterHours: 24,
  heartbeatTimeoutMinutes: null,
};

/** Längsta tid bakåt som timkalendern täcker. */
export const MAX_CALENDAR_DAYS = 400;

/** Svenska etiketter per status. */
export const HEALTH_LABELS: Record<HealthStatus, string> = {
  ok: "I drift",
  suspected_fault: "Misstänkt fel",
  fault: "Fel",
  offline: "Offline",
  empty: "Tom",
  unknown: "Okänt",
  inactive: "Inte i drift",
};

/** Sorteringsordning: allvarligast först. */
export const HEALTH_RANK: Record<HealthStatus, number> = {
  offline: 0,
  fault: 1,
  suspected_fault: 2,
  empty: 3,
  unknown: 4,
  ok: 5,
  inactive: 6,
};

/**
 * Historikens början: lokal midnatt `weeks` veckor före tystnadens dag. Räknas i kalenderdagar
 * (inte timmar) så att varje veckodag och timme förekommer minst `weeks` gånger även när
 * sommartid börjar eller slutar inom historiken.
 */
export function historyStartMs(fromMs: number, weeks: number, timeZone: string): number {
  return localDayStartMs(addDays(localParts(fromMs, timeZone).date, -7 * weeks), timeZone);
}

function assertPositiveInteger(value: number, label: string, min = 1): void {
  if (!Number.isSafeInteger(value) || value < min) {
    throw new DomainError(
      "invalid_input",
      `${label} måste vara ett heltal ≥ ${min}, fick ${value}.`,
    );
  }
}

/** Slår ihop inställningarna med standardvärdena och kontrollerar dem. */
export function resolveHealthOptions(options: HealthOptions | undefined): Required<HealthOptions> {
  const o: Required<HealthOptions> = { ...HEALTH_DEFAULTS };
  for (const [k, v] of Object.entries(options ?? {})) {
    if (v !== undefined) (o as Record<string, unknown>)[k] = v;
  }
  assertPositiveInteger(o.historyWeeks, "Veckor historik");
  assertPositiveInteger(o.alarmProbabilityBp, "Larmgränsen");
  if (o.alarmProbabilityBp > 10_000) {
    throw new DomainError("invalid_input", "Larmgränsen får vara högst 10 000 bp.");
  }
  assertPositiveInteger(o.minHistoryOrders, "Minsta antal order i historiken", 0);
  assertPositiveInteger(o.minSilenceMinutes, "Minsta tystnad", 0);
  assertPositiveInteger(o.offlineAfterHours, "Gränsen för offline");
  if (o.heartbeatTimeoutMinutes !== null)
    assertPositiveInteger(o.heartbeatTimeoutMinutes, "Gränsen för heartbeat");
  return o;
}

// ---------------------------------------------------------------------------
// Leverantörsdata
// ---------------------------------------------------------------------------

interface TimedSignal {
  readonly signal: MachineSignal;
  readonly ms: number;
}

/** Leverantörens bild av automaten vid `nowMs`. */
export interface VendorState {
  /** Sant om leverantören skickat någon anslutningshändelse för automaten. */
  readonly hasConnectivity: boolean;
  /** Offline sedan (ms), med händelsen. `null` = online eller okänt. */
  readonly offline: { readonly sinceMs: number; readonly signal: MachineSignal } | null;
  /** Aktivt fel, med händelsen. */
  readonly fault: { readonly sinceMs: number; readonly signal: MachineSignal } | null;
  /** Kända offline-intervall [från, till) för att rensa historiken. */
  readonly offlineIntervals: readonly (readonly [number, number])[];
}

function sortSignals(signals: readonly MachineSignal[], nowMs: number): TimedSignal[] {
  return signals
    .map((signal) => ({ signal, ms: parseInstant(signal.at) }))
    .filter((s) => s.ms <= nowMs)
    .sort(
      (a, b) => a.ms - b.ms || (a.signal.id < b.signal.id ? -1 : a.signal.id > b.signal.id ? 1 : 0),
    );
}

/**
 * Leverantörens tillstånd för en automat ur dess händelser (redan filtrerade på automaten).
 * - Anslutning: senaste av online/offline/heartbeat avgör. Med `heartbeatTimeoutMinutes` räknas
 *   automaten som offline från senaste heartbeat/online + gränsen.
 * - Fel: senaste av fault/fault_cleared avgör.
 * - Offline-intervall: från offline till nästa online/heartbeat (eller nu).
 */
export function vendorState(
  signals: readonly MachineSignal[],
  nowMs: number,
  heartbeatTimeoutMinutes: number | null = null,
): VendorState {
  const sorted = sortSignals(signals, nowMs);
  let lastConn: TimedSignal | null = null;
  let lastFault: TimedSignal | null = null;
  const intervals: [number, number][] = [];
  let openOffline: number | null = null;
  for (const s of sorted) {
    const k = s.signal.kind;
    if (k === "online" || k === "offline" || k === "heartbeat") {
      lastConn = s;
      if (k === "offline") {
        if (openOffline === null) openOffline = s.ms;
      } else if (openOffline !== null) {
        intervals.push([openOffline, s.ms]);
        openOffline = null;
      }
    } else {
      lastFault = s;
    }
  }
  if (openOffline !== null) intervals.push([openOffline, nowMs]);

  let offline: VendorState["offline"] = null;
  if (lastConn?.signal.kind === "offline") {
    offline = { sinceMs: lastConn.ms, signal: lastConn.signal };
  } else if (lastConn && heartbeatTimeoutMinutes !== null) {
    const deadline = lastConn.ms + heartbeatTimeoutMinutes * MINUTE_MS;
    if (nowMs > deadline) {
      offline = { sinceMs: deadline, signal: lastConn.signal };
      intervals.push([deadline, nowMs]);
    }
  }
  const fault =
    lastFault?.signal.kind === "fault" ? { sinceMs: lastFault.ms, signal: lastFault.signal } : null;
  return { hasConnectivity: lastConn !== null, offline, fault, offlineIntervals: intervals };
}

// ---------------------------------------------------------------------------
// Tystnad
// ---------------------------------------------------------------------------

interface MachinePrep {
  readonly machine: MachineRef;
  readonly active: boolean;
  readonly sales: SaleInstant[];
  readonly lastOrder: AnalyticsOrder | null;
  /** Tystnadens början (ms), `null` om okänd (inga order och okänd driftstart). */
  readonly silenceStartMs: number | null;
  /** Sant om tystnaden räknas från driftstart (automaten har aldrig sålt). */
  readonly fromActivation: boolean;
  readonly vendor: VendorState;
  readonly onHand: number | null;
  /** Hur långt försäljningsdatat räcker (ms), om det slutar före nu. */
  readonly dataUntilMs: number | null;
  readonly dataSourceName: string | null;
  /** Senaste order utan försäljningshändelse, när den är senare än försäljningshändelserna. */
  readonly unmatchedSaleMs: number | null;
}

function lastOrderOf(
  orders: readonly AnalyticsOrder[],
  timeZone: string,
): {
  order: AnalyticsOrder | null;
  startMs: number | null;
} {
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
    )
      dated = o;
  }
  if (timed && (!dated || localParts(timed.ms, timeZone).date >= dated.businessDate)) {
    return { order: timed.order, startMs: timed.ms };
  }
  if (dated) {
    // Bara datumet är känt: ordern kan ha kommit sent på dagen, så tystnaden räknas från nästa midnatt.
    return { order: dated, startMs: localDayStartMs(addDays(dated.businessDate, 1), timeZone) };
  }
  return { order: null, startMs: null };
}

/**
 * Bedömer tystnaden [fromMs, nowMs) mot veckomönstret i historiken före tystnaden.
 * Exporteras för test och för andra moduler (t.ex. larm).
 */
export function analyzeSilence(params: {
  readonly calendar: HourCalendar;
  readonly sales: readonly SaleInstant[];
  readonly fromMs: number;
  readonly nowMs: number;
  readonly historyWeeks: number;
  readonly include: (hourStartMs: number, date: IsoDate) => boolean;
  readonly alarmProbabilityBp: number;
  readonly minHistoryOrders: number;
  readonly minSilenceMinutes: number;
}): SilenceAnalysis & { readonly orderIds: string[]; readonly dates: IsoDate[] } {
  const { calendar, fromMs, nowMs } = params;
  const historyFrom = historyStartMs(fromMs, params.historyWeeks, calendar.timeZone);
  const profile = buildWeeklyProfile(calendar, params.sales, historyFrom, fromMs, (h) =>
    params.include(h.startMs, h.date),
  );
  const exp = expectedSales(profile, calendar, fromMs, nowMs);
  const minutes = Math.max(0, Math.floor((nowMs - fromMs) / MINUTE_MS));
  const zeroProbabilityBp = probabilityToBp(poissonZero(exp.lambda));
  const anomalous =
    minutes >= params.minSilenceMinutes &&
    profile.totalOrders >= params.minHistoryOrders &&
    zeroProbabilityBp < params.alarmProbabilityBp;
  const slots = new Set<number>();
  const dates = new Set<IsoDate>();
  for (const h of calendar.hours) {
    if (h.startMs + HOUR_MS <= fromMs || h.startMs >= nowMs) continue;
    slots.add(h.slot);
    dates.add(h.date);
  }
  const orderIds: string[] = [];
  for (const s of slots) orderIds.push(...(profile.orderIds[s] ?? []));
  return {
    from: new Date(fromMs).toISOString(),
    to: new Date(nowMs).toISOString(),
    minutes,
    expectedMilli: Math.round(exp.lambda * 1000),
    zeroProbabilityBp,
    anomalous,
    historyOrders: profile.totalOrders,
    historyHours: profile.totalHours,
    topSlots: exp.contributions.filter((c) => c.expectedMilli > 0).slice(0, 3),
    orderIds,
    dates: [...dates],
  };
}

// ---------------------------------------------------------------------------
// Huvudfunktion
// ---------------------------------------------------------------------------

/**
 * Status per automat vid tidpunkten `now`, sorterad med allvarligast först (offline, fel,
 * misstänkt fel, tom, okänt, i drift, inte i drift) och sedan på namn.
 * Order behöver `orderedAt` för veckomönstret; order med bara affärsdatum räknas som
 * försäljning sent den dagen.
 */
export function machineHealth(input: HealthInput, now: Date | string | number): MachineHealth[] {
  const o = resolveHealthOptions(input.options);
  const nowMs = parseInstant(now);
  const tz = o.timeZone;
  const today = businessDateAt(nowMs, tz);
  const machineName = nameLookup(input.machines);

  const ordersByMachine = new Map<string, AnalyticsOrder[]>();
  for (const ord of input.orders) {
    if (ord.machineId === null) continue;
    assertIsoDate(ord.businessDate);
    if (ord.businessDate > today) continue;
    if (ord.orderedAt !== undefined && parseInstant(ord.orderedAt) > nowMs) continue;
    const list = ordersByMachine.get(ord.machineId);
    if (list) list.push(ord);
    else ordersByMachine.set(ord.machineId, [ord]);
  }
  const signalsByMachine = new Map<string, MachineSignal[]>();
  for (const s of input.signals ?? []) {
    const list = signalsByMachine.get(s.machineId);
    if (list) list.push(s);
    else signalsByMachine.set(s.machineId, [s]);
  }
  const coverageByMachine = new Map<string, { ms: number; sourceName: string | null }>();
  const lastSaleByMachine = new Map<string, number>();
  for (const c of input.salesCoverage ?? []) {
    if (c.until) {
      const ms = parseInstant(c.until);
      const prev = coverageByMachine.get(c.machineId);
      if (!prev || ms > prev.ms)
        coverageByMachine.set(c.machineId, { ms, sourceName: c.sourceName ?? null });
    }
    if (c.lastSaleAt) {
      const ms = parseInstant(c.lastSaleAt);
      if (ms <= nowMs && ms > (lastSaleByMachine.get(c.machineId) ?? -Infinity))
        lastSaleByMachine.set(c.machineId, ms);
    }
  }
  const stockByMachine = new Map<string, number>();
  for (const s of input.stock ?? []) {
    stockByMachine.set(s.machineId, (stockByMachine.get(s.machineId) ?? 0) + Math.max(0, s.onHand));
  }

  const preps: MachinePrep[] = [];
  let calendarFrom = nowMs;
  for (const m of input.machines) {
    const orders = ordersByMachine.get(m.id) ?? [];
    const last = lastOrderOf(orders, tz);
    let silenceStartMs = last.startMs;
    let fromActivation = false;
    // En senare order utan försäljningshändelse (titeln inte matchad) avslutar också tystnaden.
    const lastSaleMs = lastSaleByMachine.get(m.id);
    const unmatchedSaleMs =
      lastSaleMs !== undefined && (silenceStartMs === null || lastSaleMs > silenceStartMs)
        ? lastSaleMs
        : null;
    if (unmatchedSaleMs !== null) silenceStartMs = unmatchedSaleMs;
    if (silenceStartMs === null && m.activeFrom !== null) {
      silenceStartMs = localDayStartMs(m.activeFrom, tz);
      fromActivation = true;
    }
    if (silenceStartMs !== null) silenceStartMs = Math.min(silenceStartMs, nowMs);
    const sales: SaleInstant[] = [];
    for (const ord of orders) {
      if (ord.orderedAt !== undefined) sales.push({ id: ord.id, ms: parseInstant(ord.orderedAt) });
    }
    const active = isMachineActive(m, today);
    const coverage = coverageByMachine.get(m.id);
    const dataUntilMs = coverage && coverage.ms < nowMs ? coverage.ms : null;
    if (active && silenceStartMs !== null) {
      calendarFrom = Math.min(calendarFrom, historyStartMs(silenceStartMs, o.historyWeeks, tz));
    }
    preps.push({
      machine: m,
      active,
      sales,
      lastOrder: last.order,
      silenceStartMs,
      fromActivation,
      vendor: vendorState(signalsByMachine.get(m.id) ?? [], nowMs, o.heartbeatTimeoutMinutes),
      onHand: stockByMachine.has(m.id) ? (stockByMachine.get(m.id) ?? 0) : null,
      dataUntilMs,
      dataSourceName: coverage?.sourceName ?? null,
      unmatchedSaleMs,
    });
  }
  // Skydd mot orimligt långa kalendrar (en automat som varit tyst i flera år): historik äldre
  // än MAX_CALENDAR_DAYS räknas inte, och automaten blir då 'unknown' i stället för att allt kastar.
  calendarFrom = Math.max(calendarFrom, nowMs - MAX_CALENDAR_DAYS * 24 * HOUR_MS);
  const calendar = buildHourCalendar(calendarFrom, nowMs, tz);

  const out = preps.map((p) => evaluate(p, calendar, nowMs, today, o, machineName(p.machine.id)));
  return out.sort(
    (a, b) =>
      HEALTH_RANK[a.status] - HEALTH_RANK[b.status] ||
      machineName(a.machineId).localeCompare(machineName(b.machineId), "sv") ||
      (a.machineId < b.machineId ? -1 : a.machineId > b.machineId ? 1 : 0),
  );
}

function evaluate(
  p: MachinePrep,
  calendar: HourCalendar,
  nowMs: number,
  today: IsoDate,
  o: Required<HealthOptions>,
  name: string,
): MachineHealth {
  const m = p.machine;
  const tz = o.timeZone;
  const link = links.machine(m.id);
  // Tystnaden bedöms bara fram till dit försäljningen är importerad (eftersläpning i datat är
  // inte en tyst automat). Leverantörens maskindata gäller fram till nu.
  const endMs =
    p.dataUntilMs === null
      ? nowMs
      : Math.max(Math.min(p.dataUntilMs, nowMs), p.silenceStartMs ?? p.dataUntilMs);
  const lagging = nowMs - endMs >= o.minSilenceMinutes * MINUTE_MS && endMs < nowMs;
  const coverageText = lagging
    ? ` Försäljningen${p.dataSourceName ? ` från ${p.dataSourceName}` : ""} är importerad till och med ${whenText(endMs, tz)}; tystnaden är bedömd fram till dit.`
    : "";
  const coverageRule = lagging
    ? " Tystnaden räknas fram till senaste importerade försäljning i automatens datakälla, inte fram till nu."
    : "";
  const lastSaleText =
    p.unmatchedSaleMs !== null
      ? `Senaste order ${whenText(p.unmatchedSaleMs, tz)} (titeln är inte matchad, så ordern finns inte i lagret).`
      : p.lastOrder
        ? p.lastOrder.orderedAt !== undefined
          ? `Senaste försäljning ${whenText(parseInstant(p.lastOrder.orderedAt), tz)}.`
          : sentence(`Senaste försäljning ${day(p.lastOrder.businessDate)}`)
        : "Ingen försäljning registrerad.";

  const base = (
    status: HealthStatus,
    source: HealthSource,
    sinceMs: number | null,
    title: string,
    detail: string,
    ev: Parameters<typeof evidence>[0],
    extra: { silence?: SilenceAnalysis | null; signal?: MachineSignal | null } = {},
  ): MachineHealth => ({
    machineId: m.id,
    status,
    label: HEALTH_LABELS[status],
    source,
    since: sinceMs === null ? null : new Date(sinceMs).toISOString(),
    title,
    detail,
    silence: extra.silence ?? null,
    signal: extra.signal ?? null,
    dataUntil: source === "sales" && endMs < nowMs ? new Date(endMs).toISOString() : null,
    evidence: evidence({ machineIds: [m.id], ...ev }),
    link,
  });

  if (!p.active) {
    const why = m.archived
      ? "Automaten är arkiverad."
      : m.activeFrom !== null && m.activeFrom > today
        ? sentence(`Driftstart ${day(m.activeFrom)}`)
        : m.activeTo !== null
          ? sentence(`Ur drift sedan ${day(addDays(m.activeTo, 1))}`)
          : "Automaten är inte i drift.";
    return base("inactive", "none", null, `${name} är inte i drift`, why, {
      rule: "Automaten räknas som i drift från driftstart till och med slutdag, om den inte är arkiverad.",
      dates: [m.activeFrom, m.activeTo].filter((d): d is IsoDate => d !== null),
    });
  }

  if (p.vendor.offline) {
    const { sinceMs, signal } = p.vendor.offline;
    const minutes = Math.floor((nowMs - sinceMs) / MINUTE_MS);
    const heartbeat = signal.kind !== "offline";
    const detail = heartbeat
      ? `Ingen kontakt sedan ${whenText(parseInstant(signal.at), tz)} (${durationText(Math.floor((nowMs - parseInstant(signal.at)) / MINUTE_MS))}). ${lastSaleText}`
      : `Leverantören rapporterade offline ${whenText(sinceMs, tz)} (för ${durationText(minutes)} sedan). ${lastSaleText}`;
    return base(
      "offline",
      "vendor",
      sinceMs,
      `${name} är offline`,
      detail,
      {
        rule: heartbeat
          ? `Offline när leverantören inte hört av automaten på ${o.heartbeatTimeoutMinutes} minuter.`
          : "Offline när leverantörens senaste anslutningshändelse är offline.",
        dates: [localParts(sinceMs, tz).date],
        orderIds: p.lastOrder ? [p.lastOrder.id] : [],
        figures: [
          { key: "offlineMinutes", label: "Minuter offline", value: minutes, unit: "count" },
        ],
      },
      { signal },
    );
  }

  if (p.vendor.fault) {
    const { sinceMs, signal } = p.vendor.fault;
    const what = signal.message?.trim() || (signal.code ? `felkod ${signal.code}` : "fel");
    const code = signal.code && signal.message ? ` (kod ${signal.code})` : "";
    return base(
      "fault",
      "vendor",
      sinceMs,
      `${name} har fel: ${what}`,
      `Leverantören rapporterade felet ${whenText(sinceMs, tz)}${code}, för ${durationText(Math.floor((nowMs - sinceMs) / MINUTE_MS))} sedan. ${lastSaleText}`,
      {
        rule: "Fel när leverantörens senaste felhändelse är ett fel som inte rapporterats åtgärdat.",
        dates: [localParts(sinceMs, tz).date],
        orderIds: p.lastOrder ? [p.lastOrder.id] : [],
      },
      { signal },
    );
  }

  if (p.onHand === 0) {
    return base(
      "empty",
      "stock",
      null,
      `${name} är tom`,
      `Lagret i automaten är 0 pack. ${lastSaleText}`,
      {
        rule: "Tom när summan av lagersaldona i automaten är 0.",
        orderIds: p.lastOrder ? [p.lastOrder.id] : [],
        figures: [{ key: "onHand", label: "Pack i automaten", value: 0, unit: "packs" }],
      },
    );
  }

  if (p.silenceStartMs === null) {
    return base(
      "unknown",
      "none",
      null,
      `${name}: okänd status`,
      "Ingen försäljning och ingen driftstart registrerad.",
      {
        rule: "Status kan bara härledas när automaten har sålt eller har en driftstart.",
      },
    );
  }

  const m0 = m;
  const s = analyzeSilence({
    calendar,
    sales: p.sales,
    fromMs: p.silenceStartMs,
    nowMs: endMs,
    historyWeeks: o.historyWeeks,
    include: (hourStart, date) =>
      (m0.activeFrom === null || date >= m0.activeFrom) &&
      (m0.activeTo === null || date <= m0.activeTo) &&
      !p.vendor.offlineIntervals.some(([a, b]) => hourStart + HOUR_MS > a && hourStart < b),
    alarmProbabilityBp: o.alarmProbabilityBp,
    minHistoryOrders: o.minHistoryOrders,
    minSilenceMinutes: o.minSilenceMinutes,
  });
  const { orderIds, dates, ...silence } = s;
  const expectedText = tenths(milliToTenths(silence.expectedMilli));
  const sinceText = p.fromActivation
    ? `driftstart ${whenText(p.silenceStartMs, tz)}`
    : whenText(p.silenceStartMs, tz);
  const busiest = slotsText(silence.topSlots);
  const figures: EvidenceFigure[] = [
    {
      key: "silenceMinutes",
      label: "Minuter utan försäljning",
      value: silence.minutes,
      unit: "count",
    },
    {
      key: "expectedTenths",
      label: "Förväntade pack under tystnaden",
      value: milliToTenths(silence.expectedMilli),
      unit: "tenths",
    },
    {
      key: "zeroProbabilityBp",
      label: "Sannolikhet för noll försäljning",
      value: silence.zeroProbabilityBp,
      unit: "bp",
    },
    { key: "alarmProbabilityBp", label: "Larmgräns", value: o.alarmProbabilityBp, unit: "bp" },
    {
      key: "historyOrders",
      label: "Order i historiken",
      value: silence.historyOrders,
      unit: "count",
    },
    {
      key: "historyHours",
      label: "Timmar i historiken",
      value: silence.historyHours,
      unit: "hours",
    },
  ];
  const rule = `Misstänkt fel när sannolikheten för noll försäljning under tystnaden är under ${probabilityText(o.alarmProbabilityBp)}, räknat på samma veckodagar och timmar de senaste ${o.historyWeeks} veckorna (minst ${o.minHistoryOrders} order).${coverageRule}`;
  const ev = {
    rule,
    period: {
      start: localParts(historyStartMs(p.silenceStartMs, o.historyWeeks, tz), tz).date,
      end: today,
    },
    orderIds: [...(p.lastOrder ? [p.lastOrder.id] : []), ...orderIds],
    dates,
    figures,
  };

  if (silence.anomalous) {
    const hours = Math.floor(silence.minutes / 60);
    const derivedOffline = hours >= o.offlineAfterHours && !p.vendor.hasConnectivity;
    const why = `Ingen försäljning sedan ${sinceText} (${durationText(silence.minutes)}). Samma veckodagar och timmar brukar ge ${expectedText} pack${busiest ? `, mest ${busiest}` : ""}; sannolikheten för noll försäljning är ${probabilityText(silence.zeroProbabilityBp)}.${coverageText}`;
    if (derivedOffline) {
      return base(
        "offline",
        "sales",
        p.silenceStartMs,
        `${name} är troligen offline`,
        `${why} Maskindata saknas, så statusen är härledd ur försäljningen.`,
        {
          ...ev,
          rule: `${rule} Offline när tystnaden dessutom varat minst ${plural(o.offlineAfterHours, "timme", "timmar")} och maskindata saknas.`,
        },
        { silence },
      );
    }
    return base("suspected_fault", "sales", p.silenceStartMs, `${name}: misstänkt fel`, why, ev, {
      silence,
    });
  }

  if (silence.historyOrders < o.minHistoryOrders) {
    return base(
      "unknown",
      "sales",
      null,
      `${name}: för lite historik`,
      `${plural(silence.historyOrders, "order", "order")} de senaste ${o.historyWeeks} veckorna; minst ${o.minHistoryOrders} behövs för att bedöma tystnad. ${lastSaleText}${coverageText}`,
      ev,
      { silence },
    );
  }

  const quiet =
    silence.minutes >= o.minSilenceMinutes
      ? ` Under tystnaden (${durationText(silence.minutes)}) brukar den sälja ${expectedText} pack; sannolikheten för noll är ${probabilityText(silence.zeroProbabilityBp)}.`
      : "";
  return base(
    "ok",
    "sales",
    null,
    `${name} är i drift`,
    `${lastSaleText}${quiet}${coverageText}`,
    ev,
    {
      silence,
    },
  );
}
