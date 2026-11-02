/**
 * Automater: vymodeller byggda ur beräkningslagret. Rena funktioner utan I/O.
 *
 * Alla belopp, vinster, marginaler, takter och statusar kommer från @/domain och
 * @/analytics (profitability, keyMetrics, unitEconomics, salesVelocity, computeTodos,
 * machineHealth). Här sker bara urval, sortering, räkning av antal (köp per timme) och
 * text. Belopp är öre; tider visas i organisationens tidszon via src/lib/format.
 */

import {
  hourSlotAt,
  machineHealth,
  type HealthStatus,
  type MachineHealth,
} from "@/analytics/health";
import { computeTodos, TODO_DEFAULTS, type AnalyticsOrder, type TodoItem } from "@/analytics/todos";
import {
  addDays,
  changeBp,
  dailyUnits,
  daysBetween,
  daysOfStockLeft,
  keyMetrics,
  minDate,
  profitability,
  salesVelocity,
  stockoutDate,
  topContributor,
  unitEconomics,
  type IsoDate,
  type Period,
  type ProfitabilityInput,
  type ProfitabilityRow,
} from "@/domain";
import { parseIsoDate } from "@/components/shell/period-state";
import {
  formatDate,
  formatDecimal,
  formatDelta,
  formatInt,
  formatPercent,
  formatSek,
  NBSP,
  weekdaysShort,
} from "@/lib/format";
import type {
  DomainInput,
  MachineRecord,
  MasterData,
  StockRow,
  StockSnapshot,
} from "@/server/data/core/types";

import type {
  DailyPoint,
  HeatmapView,
  KpiView,
  MachineLifecycle,
  MachineListRow,
  MachinesOverview,
  MachineStatusView,
  PlacementLine,
  StockLine,
  TitleShare,
  UnitEconomicsView,
} from "./types";

// ---------------------------------------------------------------------------
// Små hjälpare
// ---------------------------------------------------------------------------

const BP = 10_000;

/** Högst så många signalmarkeringar per vy (docs/design.md, avsnitt 3). */
export const SIGNAL_BUDGET = 3;

/** Kanonisk länk till automatens sida: koden i gemener (/automater/bl-001). */
export function machineHref(code: string, query = ""): string {
  const q = query.replace(/^\?/, "");
  return `/automater/${encodeURIComponent(code.toLowerCase())}${q ? `?${q}` : ""}`;
}

/** Automatens läge i registret i dag. */
export function lifecycleOf(
  m: Pick<MachineRecord, "activeFrom" | "activeTo" | "archived">,
  today: IsoDate,
): MachineLifecycle {
  if (m.archived || (m.activeTo !== null && m.activeTo < today)) return "decommissioned";
  if (m.activeFrom !== null && m.activeFrom > today) return "planned";
  return "active";
}

/** Andel förändring (0,12 = +12 %) ur beräkningslagrets changeBp, eller null. */
export function changeShare(current: number, previous: number | null | undefined): number | null {
  if (previous === null || previous === undefined) return null;
  const bp = changeBp(current, previous);
  return bp === null ? null : bp / BP;
}

/** "1 nov." eller "1 nov. 2025" (året bara när det inte är innevarande år). */
export function dayText(date: IsoDate, today: IsoDate): string {
  const d = parseIsoDate(date);
  const now = parseIsoDate(today) ?? new Date();
  return d ? formatDate(d, { year: "auto", now }) : date;
}

/** Avslutar en mening med punkt, utan dubbel punkt efter "nov.". */
export function sentence(text: string): string {
  const t = text.trim();
  return t === "" || /[.!?]$/.test(t) ? t : `${t}.`;
}

function daysText(days: number): string {
  return days === 1 ? "en dag" : `${formatInt(days)}${NBSP}dagar`;
}

function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

/** Nettointäkt för en rad: prissatta och oprissatta order (som keyMetrics). */
export function rowRevenue(row: ProfitabilityRow | undefined): number {
  return row ? row.revenueOre + row.unpricedRevenueOre : 0;
}

function kr(ore: number): string {
  return formatSek(ore / 100);
}

function byKey(rows: readonly ProfitabilityRow[]): Map<string, ProfitabilityRow> {
  return new Map(rows.filter((r) => r.kind === "item").map((r) => [r.key, r]));
}

// ---------------------------------------------------------------------------
// Signaler: påfyllning (Att göra-regeln) och hälsa
// ---------------------------------------------------------------------------

export interface MachineSignals {
  /** Påfyllningspunkter per automat (regeln i @/analytics/todos). */
  readonly refill: Map<string, TodoItem[]>;
  /** Hälsa per automat (@/analytics/health). */
  readonly health: Map<string, MachineHealth>;
}

/**
 * Påfyllning och hälsa per automat, räknat på de senaste veckornas order (oavsett
 * vald period) och lagret just nu. Ett fel i en regel stoppar inte sidan.
 */
export function machineSignals(args: {
  recent: DomainInput;
  stock: StockSnapshot;
  master: MasterData;
  now: Date;
  timeZone: string;
}): MachineSignals {
  const { recent, stock, master, now, timeZone } = args;
  const refill = new Map<string, TodoItem[]>();
  const health = new Map<string, MachineHealth>();
  try {
    const todos = computeTodos(
      {
        ...recent.sources,
        orders: recent.current.orders,
        titles: master.titles,
        machines: master.machines,
        stores: master.stores,
        stock: stock.machineStock,
        reportRecipients: [],
        reportDeliveries: [],
        options: { timeZone },
      },
      now,
    );
    for (const t of todos) {
      if (t.kind !== "refill") continue;
      const machineId = t.evidence.machineIds[0];
      if (!machineId) continue;
      const list = refill.get(machineId) ?? [];
      list.push(t);
      refill.set(machineId, list);
    }
  } catch (error) {
    console.error("[automater] Påfyllningsregeln kunde inte räknas:", error);
  }
  try {
    for (const h of machineHealth(
      {
        orders: recent.current.orders,
        machines: master.machines,
        stock: stock.machineStock,
        options: { timeZone },
      },
      now,
    )) {
      health.set(h.machineId, h);
    }
  } catch (error) {
    console.error("[automater] Hälsan kunde inte räknas:", error);
  }
  return { refill, health };
}

const HEALTH_VIEW: Record<
  HealthStatus,
  { status: MachineStatusView["status"]; label: string; flagged: boolean }
> = {
  ok: { status: "ok", label: "I drift", flagged: false },
  suspected_fault: { status: "warning", label: "Misstänkt fel", flagged: false },
  fault: { status: "critical", label: "Fel", flagged: true },
  offline: { status: "offline", label: "Ur drift", flagged: false },
  empty: { status: "critical", label: "Tom", flagged: true },
  unknown: { status: "neutral", label: "Okänt", flagged: false },
  inactive: { status: "offline", label: "Inte i drift", flagged: false },
};

/**
 * Status att visa för en automat. Ordning: avvecklad/planerad, fel, tom, fyll på nu,
 * ur drift, misstänkt fel, fyll på snart, okänt, i drift. Bara fel, tom och "fyll på
 * nu" kräver åtgärd (signal); övrigt är grått och bärs av form och text.
 */
export function statusOf(args: {
  lifecycle: MachineLifecycle;
  activeFrom: IsoDate | null;
  activeTo: IsoDate | null;
  today: IsoDate;
  health: MachineHealth | undefined;
  refill: readonly TodoItem[];
}): MachineStatusView {
  const { lifecycle, health, refill, today } = args;
  if (lifecycle === "decommissioned") {
    return {
      status: "offline",
      label: "Avvecklad",
      flagged: false,
      health: null,
      reason: args.activeTo ? sentence(`Sista dag ${dayText(args.activeTo, today)}`) : null,
    };
  }
  if (lifecycle === "planned") {
    return {
      status: "neutral",
      label: "Planerad",
      flagged: false,
      health: null,
      reason: args.activeFrom ? sentence(`Driftstart ${dayText(args.activeFrom, today)}`) : null,
    };
  }
  const now = refill.filter((t) => t.level === "now");
  const soon = refill.filter((t) => t.level !== "now");
  const h = health?.status ?? null;
  const healthReason = health ? sentence(health.title) : null;
  const refillReason = (items: readonly TodoItem[]) => {
    const first = items[0];
    if (!first) return null;
    return items.length > 1
      ? sentence(`${first.title} och ${plural(items.length - 1, "titel", "titlar")} till`)
      : sentence(first.title);
  };

  if (h === "fault" || h === "empty") {
    return { ...HEALTH_VIEW[h], health: h, reason: healthReason };
  }
  if (now.length > 0) {
    return {
      status: "critical",
      label: "Fyll på nu",
      flagged: true,
      health: h,
      reason: refillReason(now),
    };
  }
  if (h === "offline" || h === "suspected_fault") {
    return { ...HEALTH_VIEW[h], health: h, reason: healthReason };
  }
  if (soon.length > 0) {
    return {
      status: "warning",
      label: "Fyll på snart",
      flagged: false,
      health: h,
      reason: refillReason(soon),
    };
  }
  if (h === null)
    return { status: "ok", label: "I drift", flagged: false, health: null, reason: null };
  return { ...HEALTH_VIEW[h], health: h, reason: h === "ok" ? null : healthReason };
}

// ---------------------------------------------------------------------------
// Listan
// ---------------------------------------------------------------------------

export interface OverviewArgs {
  readonly input: DomainInput;
  readonly master: MasterData;
  readonly stock: StockSnapshot;
  readonly signals: MachineSignals;
  readonly lastOrderAt: ReadonlyMap<string, string>;
  readonly today: IsoDate;
  /** Periodens längd i dagar. */
  readonly days: number;
  /** Query-strängen som följer med länkarna (period och filter). */
  readonly query: string;
}

function currentPlacementSince(master: MasterData, machineId: string, today: IsoDate) {
  const p = master.placements.find(
    (x) => x.machineId === machineId && x.from <= today && (x.to === null || x.to >= today),
  );
  return p ?? null;
}

/** Listan över automater med nyckeltal och rubrik för perioden. */
export function buildOverview(args: OverviewArgs): MachinesOverview {
  const { input, master, stock, signals, lastOrderAt, today, days, query } = args;
  const current = profitability(input.current, "machine");
  const previous = input.previous ? profitability(input.previous, "machine") : null;
  const cur = byKey(current.rows);
  const prev = previous ? byKey(previous.rows) : null;
  const storeName = new Map(master.stores.map((s) => [s.id, s.name]));
  const titleName = new Map(master.titles.map((t) => [t.id, t.name]));

  // Mest sålda titel per automat (antal order).
  const counts = new Map<string, Map<string, number>>();
  for (const o of input.current.orders) {
    if (o.machineId === null) continue;
    const m = counts.get(o.machineId) ?? new Map<string, number>();
    m.set(o.titleId, (m.get(o.titleId) ?? 0) + 1);
    counts.set(o.machineId, m);
  }
  const packs = new Map<string, number>();
  for (const r of stock.machineStock) {
    packs.set(r.machineId, (packs.get(r.machineId) ?? 0) + Math.max(0, r.onHand));
  }

  // Filter: vid butik- eller automatfilter visas bara de automater som ingår.
  const scope = input.scope;
  const inScope = (m: MachineRecord) => {
    if (scope.machineId) return m.id === scope.machineId;
    if (scope.storeId) {
      return input.sources.placements.some(
        (p) =>
          p.machineId === m.id &&
          p.storeId === scope.storeId &&
          p.from <= input.period.end &&
          (p.to === null || p.to >= input.period.start),
      );
    }
    return true;
  };

  const totalRevenue = rowRevenue(current.totals);
  const rows: MachineListRow[] = master.machines.filter(inScope).map((m) => {
    const lifecycle = lifecycleOf(m, today);
    const row = cur.get(m.id);
    const revenueOre = rowRevenue(row);
    const prevRow = prev?.get(m.id);
    const top = [...(counts.get(m.id) ?? new Map<string, number>()).entries()].sort(
      (a, b) =>
        b[1] - a[1] || (titleName.get(a[0]) ?? "").localeCompare(titleName.get(b[0]) ?? "", "sv"),
    )[0];
    const placement = currentPlacementSince(master, m.id, today);
    const refill = signals.refill.get(m.id) ?? [];
    return {
      id: m.id,
      code: m.code,
      name: m.name,
      href: machineHref(m.code, query),
      lifecycle,
      activeFrom: m.activeFrom,
      activeTo: m.activeTo,
      storeId: placement?.storeId ?? null,
      storeName: placement ? (storeName.get(placement.storeId) ?? null) : null,
      storeSince: placement?.from ?? null,
      status: statusOf({
        lifecycle,
        activeFrom: m.activeFrom,
        activeTo: m.activeTo,
        today,
        health: signals.health.get(m.id),
        refill,
      }),
      revenueOre,
      profitOre: row?.profitOre ?? 0,
      marginBp: row?.marginBp ?? null,
      orders: row?.orders ?? 0,
      revenueChange: prev ? changeShare(revenueOre, rowRevenue(prevRow)) : null,
      revenueShare: totalRevenue > 0 ? revenueOre / totalRevenue : 0,
      topTitle: top ? { name: titleName.get(top[0]) ?? "Okänd titel", orders: top[1] } : null,
      refillNow: refill.filter((t) => t.level === "now").length,
      refillSoon: refill.filter((t) => t.level !== "now").length,
      packsOnHand: packs.get(m.id) ?? 0,
      lastOrderAt: lastOrderAt.get(m.id) ?? null,
    };
  });

  // Ordning: i drift först (störst intäkt), sedan planerade, sist avvecklade.
  const rank: Record<MachineLifecycle, number> = { active: 0, planned: 1, decommissioned: 2 };
  rows.sort(
    (a, b) =>
      rank[a.lifecycle] - rank[b.lifecycle] ||
      b.revenueOre - a.revenueOre ||
      a.code.localeCompare(b.code, "sv", { numeric: true }),
  );

  // Signalbudget: högst tre markeringar per vy. Fler automater som kräver åtgärd får
  // samma text men varningsform; antalet står i rubriken.
  let marked = 0;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || r.status.status !== "critical") continue;
    marked += 1;
    if (marked > SIGNAL_BUDGET) rows[i] = { ...r, status: { ...r.status, status: "warning" } };
  }

  const activeMachines = rows.filter((r) => r.lifecycle === "active").length;
  const t = current.totals;
  const pt = previous?.totals ?? null;
  const machineDays = activeMachines * days;
  const totals = {
    revenueOre: totalRevenue,
    profitOre: t.profitOre,
    marginBp: t.marginBp,
    orders: t.orders,
    revenuePerMachineDayOre: machineDays > 0 ? Math.round(totalRevenue / machineDays) : null,
    revenueChange: pt ? changeShare(totalRevenue, rowRevenue(pt)) : null,
    profitChange: pt ? changeShare(t.profitOre, pt.profitOre) : null,
    ordersChange: pt ? changeShare(t.orders, pt.orders) : null,
    previousMarginBp: pt?.marginBp ?? null,
    activeMachines,
  };

  const flagged = rows.filter((r) => r.status.flagged).length;
  const top = topContributor(current);
  const topRow = top ? rows.find((r) => r.id === top.key) : undefined;
  return {
    rows,
    totals,
    flagged,
    headline: overviewHeadline({
      rows,
      totals,
      days,
      flagged,
      top: topRow && top ? { code: topRow.code, shareBp: top.shareOfProfitBp } : null,
    }),
  };
}

/** Rubriken på listan: vad automaterna drog in och vad som sticker ut. */
export function overviewHeadline(args: {
  rows: readonly MachineListRow[];
  totals: MachinesOverview["totals"];
  days: number;
  flagged: number;
  top: { code: string; shareBp: number | null } | null;
}): { title: string; aside: string } {
  const { rows, totals, days, flagged, top } = args;
  if (rows.length === 0) {
    return {
      title: "Inga automater ännu.",
      aside: "Intäkt, vinst och lager per automat visas här när den första är tillagd.",
    };
  }
  const n = totals.activeMachines;
  const machinesText = plural(n, "automat", "automater");
  if (totals.orders === 0) {
    return {
      title: `Ingen försäljning på ${daysText(days)}.`,
      aside: `${machinesText} i drift.`,
    };
  }
  const title = `${kr(totals.revenueOre)} på ${daysText(days)} från ${machinesText}.`;
  const parts: string[] = [];
  if (totals.revenueChange !== null) {
    const c = totals.revenueChange;
    parts.push(
      Math.abs(c) < 0.005
        ? "Samma som perioden innan."
        : `${formatPercent(Math.abs(c), 0)} ${c > 0 ? "bättre" : "sämre"} än perioden innan.`,
    );
  }
  if (flagged > 0) {
    parts.push(`${plural(flagged, "automat", "automater")} kräver åtgärd.`);
  } else if (top && top.shareBp !== null && n > 1) {
    parts.push(`${top.code} står för ${formatPercent(top.shareBp / BP, 0)} av vinsten.`);
  }
  return { title, aside: parts.join(" ") };
}

// ---------------------------------------------------------------------------
// Detaljvyn
// ---------------------------------------------------------------------------

/** Indata till beräkningarna med bara automatens order (avtal och placeringar orörda). */
export function machineInput<T extends ProfitabilityInput>(input: T, machineId: string): T {
  return { ...input, orders: input.orders.filter((o) => o.machineId === machineId) };
}

export interface MachineFigures {
  readonly revenueOre: number;
  readonly profitOre: number;
  readonly marginBp: number | null;
  readonly orders: number;
  readonly averageOrderOre: number | null;
}

/**
 * Automatens nyckeltal. Intäkt, order och snittorder räknas på automatens order
 * (keyMetrics); vinst och marginal tas ur lönsamheten per automat på hela indata, så att
 * butikens hyra fördelas mellan butikens automater som på Lönsamhet.
 */
export function machineFigures(input: ProfitabilityInput, machineId: string): MachineFigures {
  const own = keyMetrics(machineInput(input, machineId));
  const row = byKey(profitability(input, "machine").rows).get(machineId);
  return {
    revenueOre: own.revenueOre,
    profitOre: row?.profitOre ?? 0,
    marginBp: row?.marginBp ?? null,
    orders: own.orderCount,
    averageOrderOre: own.averageOrderValueOre,
  };
}

/** Intäkt per dag i kronor för diagrammet (hela perioden, tomma dagar som 0). */
export function dailyRevenue(input: ProfitabilityInput, machineId: string): DailyPoint[] {
  return profitability(machineInput(input, machineId), "day")
    .rows.filter((r) => r.kind === "time")
    .map((r) => ({ date: r.key, value: rowRevenue(r) / 100 }));
}

/** Nyckeltalen i detaljvyn med förändring mot jämförelseperioden. */
export function machineKpis(
  cur: MachineFigures,
  prev: MachineFigures | null,
  trend: readonly DailyPoint[],
): KpiView[] {
  const rel = (a: number, b: number | null | undefined) => {
    const c = changeShare(a, b ?? null);
    return c === null ? null : { value: c, kind: "relative" as const };
  };
  const marginDelta =
    prev && cur.marginBp !== null && prev.marginBp !== null
      ? { value: (cur.marginBp - prev.marginBp) / 100, kind: "absolute" as const }
      : null;
  return [
    {
      id: "revenue",
      label: "Intäkt",
      value: cur.revenueOre,
      kind: "sek",
      delta: prev ? rel(cur.revenueOre, prev.revenueOre) : null,
      primary: true,
      trend: trend.map((p) => p.value),
    },
    {
      id: "profit",
      label: cur.profitOre < 0 ? "Förlust" : "Vinst",
      value: cur.profitOre,
      kind: "sek",
      delta: prev ? rel(cur.profitOre, prev.profitOre) : null,
    },
    {
      id: "margin",
      label: "Marginal",
      value: cur.marginBp === null ? Number.NaN : cur.marginBp / BP,
      kind: "percent",
      delta: marginDelta,
    },
    {
      id: "orders",
      label: "Order",
      value: cur.orders,
      kind: "int",
      delta: prev ? rel(cur.orders, prev.orders) : null,
    },
    {
      id: "average",
      label: "Snittorder",
      value: cur.averageOrderOre ?? Number.NaN,
      kind: "sek",
      delta:
        prev && cur.averageOrderOre !== null && prev.averageOrderOre !== null
          ? rel(cur.averageOrderOre, prev.averageOrderOre)
          : null,
    },
  ];
}

/** Titlarna i automaten, störst intäkt först. */
export function titleShares(
  input: ProfitabilityInput,
  machineId: string,
  master: MasterData,
): TitleShare[] {
  const name = new Map(master.titles.map((t) => [t.id, t.name]));
  const r = profitability(machineInput(input, machineId), "title");
  const total = rowRevenue(r.totals);
  return r.rows
    .filter((row) => row.kind === "item" && row.orders > 0)
    .map((row) => ({
      titleId: row.key,
      name: name.get(row.key) ?? "Okänd titel",
      orders: row.orders,
      revenueOre: rowRevenue(row),
      share: total > 0 ? rowRevenue(row) / total : 0,
    }))
    .sort((a, b) => b.revenueOre - a.revenueOre || a.name.localeCompare(b.name, "sv"));
}

/**
 * Köp per veckodag och timme i organisationens tidszon. Kolumnerna täcker timmarna
 * med försäljning (minst 08–20), raderna är måndag–söndag.
 */
export function salesHeatmap(orders: readonly AnalyticsOrder[], timeZone: string): HeatmapView {
  const grid = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let total = 0;
  for (const o of orders) {
    const ms = o.orderedAt ? Date.parse(o.orderedAt) : Number.NaN;
    if (!Number.isFinite(ms)) continue;
    const slot = hourSlotAt(ms, timeZone);
    const row = grid[slot.weekday - 1];
    if (!row) continue;
    row[slot.hour] = (row[slot.hour] ?? 0) + 1;
    total++;
  }
  let first = 8;
  let last = 20;
  for (let h = 0; h < 24; h++) {
    if (grid.some((r) => (r[h] ?? 0) > 0)) {
      first = Math.min(first, h);
      last = Math.max(last, h);
    }
  }
  const values = grid.map((r) => r.slice(first, last + 1));
  let peak: HeatmapView["peak"] = null;
  values.forEach((r, wi) =>
    r.forEach((v, ci) => {
      if (v > 0 && (peak === null || v > peak.count)) {
        peak = { weekday: wi, hour: first + ci, count: v };
      }
    }),
  );
  return {
    values,
    rowLabels: [...weekdaysShort],
    colLabels: Array.from({ length: last - first + 1 }, (_, i) =>
      String(first + i).padStart(2, "0"),
    ),
    firstHour: first,
    total,
    peak,
  };
}

/** "13–14" för timmen 13. */
export function hourRange(hour: number): string {
  return `${String(hour).padStart(2, "0")}–${String((hour + 1) % 24).padStart(2, "0")}`;
}

/**
 * Automatens lager per titel med takt och hur länge det räcker (14 hela dagar t.o.m. i
 * går, som påfyllningsregeln). Nivån kommer från regeln i Att göra.
 */
export function stockLines(args: {
  machine: Pick<MachineRecord, "id" | "activeFrom">;
  rows: readonly StockRow[];
  recentOrders: readonly AnalyticsOrder[];
  refill: readonly TodoItem[];
  master: MasterData;
  today: IsoDate;
}): StockLine[] {
  const { machine, rows, recentOrders, refill, master, today } = args;
  const asOf = addDays(today, -1);
  const name = new Map(master.titles.map((t) => [t.id, t.name]));
  const level = new Map<string, "now" | "soon">();
  for (const t of refill) {
    const titleId = t.evidence.titleIds[0];
    if (titleId) level.set(titleId, t.level === "now" ? "now" : "soon");
  }
  const byTitle = new Map<string, AnalyticsOrder[]>();
  for (const o of recentOrders) {
    if (o.machineId !== machine.id) continue;
    const list = byTitle.get(o.titleId) ?? [];
    list.push(o);
    byTitle.set(o.titleId, list);
  }
  const lines = rows
    .filter((r) => r.locationKind === "machine" && r.machineId === machine.id)
    .map((r): StockLine => {
      const v = salesVelocity(dailyUnits(byTitle.get(r.titleId) ?? []), {
        asOf,
        days: TODO_DEFAULTS.refillWindowDays,
        ...(machine.activeFrom !== null ? { activeFrom: minDate(machine.activeFrom, asOf) } : {}),
      });
      const onHand = Math.max(0, r.onHand);
      return {
        titleId: r.titleId,
        name: name.get(r.titleId) ?? "Okänd titel",
        onHand: r.onHand,
        perDay: v.units > 0 ? v.perDay : null,
        daysLeft: daysOfStockLeft(onHand, v),
        stockoutDate: stockoutDate(asOf, onHand, v),
        lastRestockedAt: r.lastRestockedAt,
        level: level.get(r.titleId) ?? null,
      };
    })
    .filter((l) => l.onHand !== 0 || l.perDay !== null || l.level !== null);
  const rank = (l: StockLine) => (l.level === "now" ? 0 : l.level === "soon" ? 1 : 2);
  return lines.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.daysLeft ?? Number.MAX_SAFE_INTEGER) - (b.daysLeft ?? Number.MAX_SAFE_INTEGER) ||
      a.name.localeCompare(b.name, "sv"),
  );
}

/** Placeringshistoriken, senaste först. */
export function placementLines(
  master: MasterData,
  machineId: string,
  today: IsoDate,
): PlacementLine[] {
  const storeName = new Map(master.stores.map((s) => [s.id, s.name]));
  return master.placements
    .filter((p) => p.machineId === machineId)
    .map((p) => {
      const end = p.to === null ? today : minDate(p.to, today);
      return {
        id: p.id,
        storeId: p.storeId,
        storeName: storeName.get(p.storeId) ?? "Okänd butik",
        from: p.from,
        to: p.to,
        current: p.from <= today && (p.to === null || p.to >= today),
        days: Math.max(0, daysBetween(p.from, end) + 1),
      };
    })
    .sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0));
}

/** Enhetsekonomi för automaten (domänens unitEconomics), eller null utan investering. */
export function machineUnitEconomics(
  input: DomainInput,
  machineId: string,
): UnitEconomicsView | null {
  const u = unitEconomics({
    ...input.current,
    investments: input.investments,
    machineIds: [machineId],
  }).find((x) => x.machineId === machineId);
  if (!u || u.investmentOre === 0) return null;
  return {
    investmentOre: u.investmentOre,
    bookValueOre: u.bookValueOre,
    monthlyDepreciationOre: u.monthlyDepreciationOre,
    profitPerMonthOre: u.profitPerMonthOre,
    profitPerMonthAfterDepreciationOre: u.profitPerMonthAfterDepreciationOre,
    paybackMonths: u.paybackMonths,
    activeDays: u.activeDays,
  };
}

/** Rubriken på automatens sida. */
export function machineHeadline(args: {
  code: string;
  lifecycle: MachineLifecycle;
  activeFrom: IsoDate | null;
  activeTo: IsoDate | null;
  figures: MachineFigures;
  previous: MachineFigures | null;
  days: number;
  store: { name: string; since: IsoDate } | null;
  today: IsoDate;
}): { title: string; aside: string } {
  const { code, lifecycle, figures, previous, days, store, today } = args;
  const storeText = store
    ? sentence(`Står i ${store.name} sedan ${dayText(store.since, today)}`)
    : lifecycle === "active"
      ? "Står inte i någon butik."
      : "";
  if (lifecycle === "decommissioned" && args.activeTo) {
    return {
      title: sentence(`${code} avvecklades ${dayText(args.activeTo, today)}`),
      aside:
        figures.orders > 0
          ? `${kr(figures.revenueOre)} i intäkt på ${daysText(days)}. Historiken finns kvar.`
          : "Historiken finns kvar.",
    };
  }
  if (lifecycle === "planned" && args.activeFrom) {
    return {
      title: sentence(`${code} startar ${dayText(args.activeFrom, today)}`),
      aside: storeText || "Ingen butik vald ännu.",
    };
  }
  if (figures.orders === 0) {
    return { title: `${code} har inte sålt något på ${daysText(days)}.`, aside: storeText };
  }
  const parts: string[] = [];
  const c = previous ? changeShare(figures.revenueOre, previous.revenueOre) : null;
  if (c !== null) {
    parts.push(
      Math.abs(c) < 0.005
        ? "Samma som perioden innan."
        : `${formatPercent(Math.abs(c), 0)} ${c > 0 ? "bättre" : "sämre"} än perioden innan.`,
    );
  } else {
    parts.push(
      `${figures.profitOre < 0 ? "Förlust" : "Vinst"} ${kr(Math.abs(figures.profitOre))}.`,
    );
  }
  if (storeText) parts.push(storeText);
  return {
    title: `${code}: ${kr(figures.revenueOre)} på ${daysText(days)}.`,
    aside: parts.join(" "),
  };
}

/** Kort fras för förändring i tabeller: "+12 %" eller "–". */
export function deltaText(change: number | null): string | null {
  return change === null ? null : formatDelta(change, Math.abs(change) < 0.1 ? 1 : 0);
}

/** Perioden för de senaste veckornas signaler (hälsans historik är 8 veckor). */
export function recentWindow(today: IsoDate): Period {
  return { start: addDays(today, -62), end: today };
}

/** Nyckeltalen överst i listan. Marginalens förändring kräver jämförelseperiodens marginal. */
export function overviewKpis(totals: MachinesOverview["totals"]): KpiView[] {
  const previousMarginBp = totals.previousMarginBp;
  const rel = (c: number | null) => (c === null ? null : { value: c, kind: "relative" as const });
  return [
    {
      id: "revenue",
      label: "Intäkt",
      value: totals.revenueOre,
      kind: "sek",
      delta: rel(totals.revenueChange),
      primary: true,
    },
    {
      id: "profit",
      label: totals.profitOre < 0 ? "Förlust" : "Vinst",
      value: totals.profitOre,
      kind: "sek",
      delta: rel(totals.profitChange),
    },
    {
      id: "margin",
      label: "Marginal",
      value: totals.marginBp === null ? Number.NaN : totals.marginBp / BP,
      kind: "percent",
      delta:
        totals.marginBp !== null && previousMarginBp !== null
          ? { value: (totals.marginBp - previousMarginBp) / 100, kind: "absolute" }
          : null,
    },
    {
      id: "orders",
      label: "Order",
      value: totals.orders,
      kind: "int",
      delta: rel(totals.ordersChange),
    },
    {
      id: "per-machine-day",
      label: "Per automat och dag",
      value: totals.revenuePerMachineDayOre ?? Number.NaN,
      kind: "sek",
      delta: null,
    },
  ];
}

/** Förslag på nästa kod: BL-001, BL-002 … → BL-003. Utan mönster: BL-001. */
export function nextMachineCode(codes: readonly string[]): string {
  let prefix = "BL-";
  let width = 3;
  let max = 0;
  for (const c of codes) {
    const m = /^(.*?)(\d+)$/.exec(c);
    if (!m || m[2] === undefined) continue;
    const n = Number(m[2]);
    if (n >= max) {
      max = n;
      prefix = m[1] ?? "";
      width = m[2].length;
    }
  }
  let n = max + 1;
  let code = `${prefix}${String(n).padStart(width, "0")}`;
  const taken = new Set(codes);
  while (taken.has(code)) {
    n += 1;
    code = `${prefix}${String(n).padStart(width, "0")}`;
  }
  return code;
}

/**
 * Den grå delen av tabellens rubrik: spridningen mellan den som drar in mest och minst
 * (raderna är sorterade på intäkt, i drift först).
 */
export function spreadText(rows: readonly MachineListRow[]): string {
  const sold = rows.filter((r) => r.lifecycle === "active" && r.orders > 0);
  const best = sold[0];
  const worst = sold.at(-1);
  if (!best || !worst) return "Ingen har sålt något i perioden.";
  if (best === worst) return `${best.code} sålde ${plural(best.orders, "pack", "pack")}.`;
  if (worst.revenueOre <= 0) return `${worst.code} har ingen intäkt i perioden.`;
  const ratio = best.revenueOre / worst.revenueOre;
  if (ratio < 1.1) return `${best.code} och ${worst.code} drar in ungefär lika mycket.`;
  if (ratio >= 2) {
    return `${best.code} drar in ${formatDecimal(ratio)} gånger så mycket som ${worst.code}.`;
  }
  return `${best.code} drar in ${formatPercent(ratio - 1, 0)} mer än ${worst.code}.`;
}

/** Nyckeltalen för enhetsekonomin (investering, bokfört värde, vinst per månad, återbetalning). */
export function unitEconomicsKpis(u: UnitEconomicsView): KpiView[] {
  return [
    {
      id: "payback",
      label: "Återbetalning",
      value: u.paybackMonths ?? Number.NaN,
      kind: "months",
      delta: null,
      primary: true,
    },
    { id: "investment", label: "Investering", value: u.investmentOre, kind: "sek", delta: null },
    { id: "book", label: "Bokfört värde", value: u.bookValueOre, kind: "sek", delta: null },
    {
      id: "monthly",
      label: "Vinst per månad efter avskrivning",
      value: u.profitPerMonthAfterDepreciationOre ?? Number.NaN,
      kind: "sek",
      delta: null,
    },
  ];
}
