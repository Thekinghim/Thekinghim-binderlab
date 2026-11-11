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
import { sellOut, type WeekShare } from "@/analytics/sellout";
import { computeTodos, TODO_DEFAULTS, type AnalyticsOrder, type TodoItem } from "@/analytics/todos";
import type { VisitPlan } from "@/analytics/visits";
import {
  addDays,
  changeBp,
  dailyUnits,
  daysBetween,
  keyMetrics,
  maxDate,
  minDate,
  periodDays,
  profitability,
  roundHalfUp,
  salesVelocity,
  topContributor,
  unitEconomics,
  type IsoDate,
  type Period,
  type ProfitabilityInput,
  type ProfitabilityResult,
  type ProfitabilityRow,
} from "@/domain";
import { sellingSpan, withSellingDays } from "@/analytics/expansion/unit-economics-compare";
import { parseIsoDate } from "@/components/shell/period-state";
import { dataCoverage } from "@/server/data/core/period";
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
import {
  ourMarginLabel,
  ourProfitLabel,
  storeShareLabel,
  storeShareTerms,
} from "@/lib/store-share";
import type {
  DataScope,
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
  OtherRow,
  PlacementLine,
  StockLine,
  TitleShare,
  UnitEconomicsView,
  UnpricedView,
} from "./types";
import { refillByText } from "./refill-text";

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

// ---------------------------------------------------------------------------
// Dagar med data
// ---------------------------------------------------------------------------

/**
 * Dagarna med data i perioden: från första ordern (organisationens) och, om perioden
 * slutar i dag och ingen order kommit i dag, bara t.o.m. i går (som Hem). null om inga
 * dagar återstår. Rubriker, snitt per dag och dagsdiagrammet räknas på dessa dagar;
 * beloppen gäller hela perioden (dagarna utanför har ingen försäljning).
 */
export const coverageOf = dataCoverage;

/**
 * Automatens faktiska driftstart: den tidigaste av registrerad driftstart, första
 * placeringen och första ordern. En automat som kopplas in i efterhand har order från
 * före den dag den lades upp; de dagarna räknas (samma regel som placedInStore).
 */
export function startedOn(
  activeFrom: IsoDate | null,
  firstPlacementFrom: IsoDate | null,
  firstOrderDate: IsoDate | null,
): IsoDate | null {
  const dates = [activeFrom, firstPlacementFrom, firstOrderDate].filter(
    (d): d is IsoDate => d !== null,
  );
  return dates.length === 0 ? null : dates.reduce((a, b) => (b < a ? b : a));
}

/** Den del av `range` som automaten var i drift (driftstart till sista dag), eller null. */
export function machineSpan(
  range: Period | null,
  activeFrom: IsoDate | null,
  activeTo: IsoDate | null,
): Period | null {
  if (range === null) return null;
  const start = activeFrom !== null ? maxDate(range.start, activeFrom) : range.start;
  const end = activeTo !== null ? minDate(range.end, activeTo) : range.end;
  return start <= end ? { start, end } : null;
}

/** Hur länge, i rubriker: antal dagar och texten "på 20 dagar", "i dag", "i går", "den 31 okt.". */
export interface Span {
  readonly days: number;
  readonly text: string;
}

export function spanOf(range: Period, today: IsoDate): Span {
  const days = periodDays(range);
  if (days > 1) return { days, text: `på ${formatInt(days)}${NBSP}dagar` };
  if (range.start === today) return { days, text: "i dag" };
  if (range.start === addDays(today, -1)) return { days, text: "i går" };
  return { days, text: `den ${dayText(range.start, today)}` };
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
  /**
   * Intäkt i risk de närmaste 7 dagarna per automat (öre): påfyllningspunkterna och
   * "automaten har slutat sälja", samma belopp som på Att göra (machineStake).
   */
  readonly stake: Map<string, number>;
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
  /**
   * Hälsan som Drift räknar den (loadMachineHealth: försäljningen ur lagret och hur långt
   * den är importerad). Saknas den räknas hälsan här på orderna, utan täckningen.
   */
  health?: readonly MachineHealth[] | null;
}): MachineSignals {
  const { recent, stock, master, now, timeZone } = args;
  const refill = new Map<string, TodoItem[]>();
  const health = new Map<string, MachineHealth>();
  let stake = new Map<string, number>();
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
    stake = machineStake(todos);
  } catch (error) {
    console.error("[automater] Påfyllningsregeln kunde inte räknas:", error);
  }
  if (args.health) {
    for (const h of args.health) health.set(h.machineId, h);
    return { refill, health, stake };
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
  return { refill, health, stake };
}

/** Sorterna vars kronor står på raden: tomt eller snart tomt fack, och automat som står still. */
const STAKE_KINDS: ReadonlySet<TodoItem["kind"]> = new Set(["refill", "stale-machine"]);

/**
 * Intäkt i risk de närmaste 7 dagarna per automat (öre). Varje punkt avrundas till hela
 * kronor innan summan tas, som på Att göra (stakeOf), så att samma punkter ger samma summa
 * på båda sidorna. Punkter utan belopp eller utan automat räknas inte.
 */
export function machineStake(todos: readonly TodoItem[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const t of todos) {
    if (!STAKE_KINDS.has(t.kind)) continue;
    const machineId = t.evidence.machineIds[0];
    if (!machineId) continue;
    const ore = Math.round(Math.max(t.atStakeOre ?? 0, 0) / 100) * 100;
    out.set(machineId, (out.get(machineId) ?? 0) + ore);
  }
  return out;
}

const HEALTH_VIEW: Record<
  HealthStatus,
  { status: MachineStatusView["status"]; label: string; flagged: boolean }
> = {
  ok: { status: "ok", label: "I drift", flagged: false },
  suspected_fault: { status: "warning", label: "Misstänkt fel", flagged: false },
  fault: { status: "critical", label: "Fel", flagged: true },
  // Ur drift = automaten kan inte sälja (design.md §11): en åtgärd, som på Drift.
  offline: { status: "critical", label: "Ur drift", flagged: true },
  empty: { status: "critical", label: "Tom", flagged: true },
  unknown: { status: "neutral", label: "Okänt", flagged: false },
  inactive: { status: "offline", label: "Inte i drift", flagged: false },
};

/**
 * Status att visa för en automat. Ordning: avvecklad/planerad, fel, tom, ur drift, fyll
 * på nu, misstänkt fel, fyll på snart, okänt, i drift. Fel, tom, ur drift och "fyll på
 * nu" kräver åtgärd (signal, samma som Drift); övrigt är grått och bärs av form och text.
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

  if (h === "fault" || h === "empty" || h === "offline") {
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
  if (h === "suspected_fault") {
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
  /** Filtret i URL:en. Vid automatfilter är `input` hela organisationens (se loadOverview). */
  readonly scope: DataScope;
  /** Dagarna med data (coverageOf), eller null. */
  readonly coverage: Period | null;
  /** Perioden är bara i dag och dagens order har inte kommit än. */
  readonly pendingToday: boolean;
  /** Query-strängen som följer med länkarna (period och filter). */
  readonly query: string;
}

/** Order utan inköpspris i en lönsamhet: antal, intäkt, andel och titlar, eller null. */
export function unpricedOf(
  result: ProfitabilityResult,
  master: MasterData,
  rentOre = 0,
): UnpricedView | null {
  const u = result.unpriced;
  if (u.orders === 0) return null;
  const name = new Map(master.titles.map((t) => [t.id, t.name]));
  const only = u.titleIds.length === 1 ? u.titleIds[0] : undefined;
  return {
    orders: u.orders,
    revenueOre: u.revenueOre,
    shareBp: u.shareBp,
    titles: u.byTitle.map((t) => name.get(t.titleId) ?? "Okänd titel"),
    href: only ? `/inkopspriser?titel=${encodeURIComponent(only)}` : "/inkopspriser?saknar=pris",
    rentOre,
  };
}

/**
 * Automatdagar i `range`: dagar då automaterna stod i en butik (unitEconomics.activeDays;
 * en automat utan placeringar räknas alla dagar den var i drift).
 */
export function machineDaysIn(
  input: ProfitabilityInput,
  range: Period,
  machines: readonly Pick<MachineRecord, "id" | "activeFrom" | "activeTo">[],
): number {
  const ids = machines
    .filter((m) => machineSpan(range, m.activeFrom, m.activeTo) !== null)
    .map((m) => m.id);
  if (ids.length === 0) return 0;
  const wanted = new Set(ids);
  const result = unitEconomics({
    ...input,
    period: range,
    orders: input.orders.filter(
      (o) => o.businessDate >= range.start && o.businessDate <= range.end,
    ),
    investments: [],
    machineIds: ids,
  });
  // Minst dagarna sedan automatens första order (som Enhetsekonomi).
  return result
    .filter((u) => wanted.has(u.machineId))
    .reduce(
      (n, u) => n + Math.max(u.activeDays, sellingSpan(input.orders, u.machineId, range).days),
      0,
    );
}

const OTHER_LABEL: Partial<Record<ProfitabilityRow["kind"], string>> = {
  unallocated: "Ej fördelad hyra",
  "no-machine": "Order utan automat",
};

function currentPlacementSince(master: MasterData, machineId: string, today: IsoDate) {
  const p = master.placements.find(
    (x) => x.machineId === machineId && x.from <= today && (x.to === null || x.to >= today),
  );
  return p ?? null;
}

/** Listan över automater med nyckeltal och rubrik för perioden. */
export function buildOverview(args: OverviewArgs): MachinesOverview {
  const { input, master, stock, signals, lastOrderAt, today, scope, coverage, query } = args;
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

  // Vid automatfilter är indata hela organisationens (butikens hyra delas mellan dess
  // automater, som på automatens sida); summan är då automatens rad.
  const focus = scope.machineId ? cur.get(scope.machineId) : undefined;
  const focusPrev = scope.machineId ? prev?.get(scope.machineId) : undefined;
  const t = scope.machineId ? (focus ?? null) : current.totals;
  const pt = previous ? (scope.machineId ? (focusPrev ?? null) : previous.totals) : null;
  const totalRevenue = rowRevenue(t ?? undefined);
  const scoped = master.machines.filter(inScope);
  const rows: MachineListRow[] = scoped.map((m) => {
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
      atStakeOre: lifecycle === "active" ? (signals.stake.get(m.id) ?? 0) : 0,
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
  // Ur drift (hälsan offline): i drift enligt livscykeln men kan inte sälja.
  const offlineMachines = rows.filter(
    (r) => r.lifecycle === "active" && r.status.health === "offline",
  ).length;
  const machineDays = coverage ? machineDaysIn(input.current, coverage, scoped) : 0;
  const totals = {
    revenueOre: totalRevenue,
    profitOre: t?.profitOre ?? 0,
    marginBp: t?.marginBp ?? null,
    orders: t?.orders ?? 0,
    revenuePerMachineDayOre:
      machineDays > 0 && totalRevenue > 0 ? roundHalfUp(totalRevenue, machineDays) : null,
    revenueChange: pt ? changeShare(totalRevenue, rowRevenue(pt)) : null,
    profitChange: pt && t ? changeShare(t.profitOre, pt.profitOre) : null,
    ordersChange: pt && t ? changeShare(t.orders, pt.orders) : null,
    previousMarginBp: pt?.marginBp ?? null,
    activeMachines,
    offlineMachines,
    storeShareDeducted: current.storeShareDeducted,
    // Andelen bredvid vår del (som Lönsamhet): med vald butik dess namn och villkor.
    ...(current.storeShareDeducted && t
      ? {
          storeShareOre: t.profitBeforeShareOre - t.profitOre,
          storeShareLabel: storeShareLabel(
            scope.storeId && !scope.machineId
              ? {
                  name: storeName.get(scope.storeId) ?? "butiken",
                  terms: storeShareTerms(input.current.agreements, scope.storeId, input.period),
                }
              : null,
          ),
        }
      : {}),
  };

  // Rader utanför automaterna (ej fördelad hyra, order utan automat), så att raderna
  // summerar till totalen. Vid automatfilter är summan automatens egen rad.
  const others: OtherRow[] = scope.machineId
    ? []
    : current.rows
        .filter((r) => r.kind !== "item" && r.kind !== "total")
        .map((r) => ({
          key: r.key,
          label: OTHER_LABEL[r.kind] ?? "Övrigt",
          revenueOre: rowRevenue(r),
          profitOre: r.profitOre,
          orders: r.orders,
        }))
        .filter((r) => r.revenueOre !== 0 || r.profitOre !== 0 || r.orders !== 0);

  const unpriced = scope.machineId
    ? unpricedOf(
        profitability(machineInput(input.current, scope.machineId), "title"),
        master,
        focus?.unpricedRentOre ?? 0,
      )
    : unpricedOf(current, master);

  const flagged = rows.filter((r) => r.status.flagged).length;
  const top = scope.machineId ? null : topContributor(current);
  const topRow = top ? rows.find((r) => r.id === top.key) : undefined;
  return {
    rows,
    others,
    totals,
    unpriced,
    flagged,
    headline: overviewHeadline({
      rows,
      totals,
      span: coverage ? spanOf(coverage, today) : spanOf(input.period, today),
      pendingToday: args.pendingToday,
      flagged,
      top: topRow && top ? { code: topRow.code, shareBp: top.shareOfProfitBp } : null,
    }),
  };
}

/** Rubriken på listan: vad automaterna drog in och vad som sticker ut. */
export function overviewHeadline(args: {
  rows: readonly MachineListRow[];
  totals: MachinesOverview["totals"];
  /** Dagarna med data (eller perioden, om ingen order finns). */
  span: Span;
  /** Perioden är bara i dag och dagens order har inte kommit än. */
  pendingToday?: boolean;
  flagged: number;
  top: { code: string; shareBp: number | null } | null;
}): { title: string; aside: string } {
  const { rows, totals, span, flagged, top } = args;
  if (rows.length === 0) {
    return {
      title: "Inga automater ännu.",
      aside: "Intäkt, vinst och lager per automat visas här när den första är tillagd.",
    };
  }
  const n = totals.activeMachines;
  const offline = totals.offlineMachines ?? 0;
  const machinesText = plural(n, "automat", "automater");
  if (totals.orders === 0) {
    const need = flagged > 0 ? `${plural(flagged, "automat", "automater")} kräver åtgärd.` : "";
    const running =
      offline > 0
        ? `${formatInt(n - offline)} av ${machinesText} i drift, ${formatInt(offline)} ur drift.`
        : `${machinesText} i drift.`;
    return {
      title: args.pendingToday ? "Inga order i dag ännu." : `Ingen försäljning ${span.text}.`,
      aside: joinClauses(need ? [running, need] : [running]),
    };
  }
  const title = `${kr(totals.revenueOre)} ${span.text} från ${machinesText}.`;
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
  // En mening i andra delen: rubriken har högst två (design.md §5.5).
  return { title, aside: joinClauses(parts) };
}

/** ["14 % bättre än perioden innan.", "3 automater kräver åtgärd."] → en mening med komma. */
export function joinClauses(parts: readonly string[]): string {
  return parts
    .map((p, i) => {
      // Ett vanligt ord efter kommat får liten bokstav ("Står i" → "står i"), en kod inte.
      const lead = i > 0 && /^[A-ZÅÄÖ][a-zåäö]/.test(p) ? p[0]!.toLowerCase() + p.slice(1) : p;
      return i < parts.length - 1 ? lead.replace(/\.$/, "") : lead;
    })
    .join(", ");
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
  /** Vinsten är efter butikernas andel (vyknappen). Utelämnad = före andelen. */
  readonly storeShareDeducted?: boolean;
  /** Andelen som dragits från automatens vinst (bara när den dras). */
  readonly storeShareOre?: number;
}

/**
 * Automatens nyckeltal. Intäkt, order och snittorder räknas på automatens order
 * (keyMetrics); vinst och marginal tas ur lönsamheten per automat på hela indata, så att
 * butikens hyra fördelas mellan butikens automater som på Lönsamhet.
 */
export function machineFigures(input: ProfitabilityInput, machineId: string): MachineFigures {
  const own = keyMetrics(machineInput(input, machineId));
  const result = profitability(input, "machine");
  const row = byKey(result.rows).get(machineId);
  return {
    revenueOre: own.revenueOre,
    profitOre: row?.profitOre ?? 0,
    marginBp: row?.marginBp ?? null,
    orders: own.orderCount,
    averageOrderOre: own.averageOrderValueOre,
    storeShareDeducted: result.storeShareDeducted,
    ...(result.storeShareDeducted && row
      ? { storeShareOre: row.profitBeforeShareOre - row.profitOre }
      : {}),
  };
}

/**
 * Automatens order utan inköpspris, med butikshyran på dem (som dras från organisationens
 * vinst som ej fördelad hyra, inte från automatens; lönsamheten per automat på hela indata).
 */
export function machineUnpriced(
  input: ProfitabilityInput,
  machineId: string,
  master: MasterData,
): UnpricedView | null {
  const row = byKey(profitability(input, "machine").rows).get(machineId);
  return unpricedOf(
    profitability(machineInput(input, machineId), "title"),
    master,
    row?.unpricedRentOre ?? 0,
  );
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
  /** Andelens etikett ("Butikernas andel" eller butikens namn och villkor). */
  shareLabel = "Butikernas andel",
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
      label: ourProfitLabel(cur.storeShareDeducted === true, cur.profitOre),
      value: cur.profitOre,
      kind: "sek",
      delta: prev ? rel(cur.profitOre, prev.profitOre) : null,
    },
    ...(cur.storeShareDeducted === true && cur.storeShareOre !== undefined
      ? [
          {
            id: "store-share",
            label: shareLabel,
            value: cur.storeShareOre,
            kind: "sek" as const,
            delta: null,
          },
        ]
      : []),
    {
      id: "margin",
      label: ourMarginLabel(cur.storeShareDeducted === true, "Marginal"),
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
  const top = Math.max(0, ...values.flat());
  return {
    values,
    thresholds: heatThresholds(top),
    rowLabels: [...weekdaysShort],
    colLabels: Array.from({ length: last - first + 1 }, (_, i) =>
      String(first + i).padStart(2, "0"),
    ),
    firstHour: first,
    total,
    peak,
  };
}

/**
 * Heltalsgränser för värmekartans steg (antal köp): högst fem fyllda steg, lika breda,
 * t.ex. topp 6 → [3, 5] (1–2, 3–4, 5+), topp 4 → [2, 3, 4] (1, 2, 3, 4+).
 */
export function heatThresholds(top: number): number[] {
  const max = Math.max(1, Math.floor(top));
  const step = Math.ceil(max / 5);
  const out: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const t = 1 + i * step;
    if (t > max) break;
    out.push(t);
  }
  return out.length > 0 ? out : [2];
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
  /**
   * Automatens veckoform (andel av veckans försäljning per veckodag, måndag först), eller
   * utelämnad: jämn takt. Skickas in av sidan när den finns (ingen räknas ut här).
   */
  weekShare?: WeekShare | readonly number[] | null;
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
      // En gemensam funktion för slutdagen (@/analytics/sellout): utan veckoform samma dag
      // och samma antal dagar som förut; med `weekShare` räknar den med helgen.
      const out = sellOut({
        onHand,
        dailyAvg: v,
        from: asOf,
        ...(args.weekShare ? { weekShare: args.weekShare } : {}),
      });
      return {
        titleId: r.titleId,
        name: name.get(r.titleId) ?? "Okänd titel",
        onHand: r.onHand,
        perDay: v.units > 0 ? v.perDay : null,
        daysLeft: out?.daysLeft ?? null,
        stockoutDate: out?.date ?? null,
        // Registrerad påfyllning, inte inventeringen (kolumnen "Senast påfylld").
        lastRestockedAt: r.lastRefilledAt ?? null,
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
  const raw = unitEconomics({
    ...input.current,
    investments: input.investments,
    machineIds: [machineId],
  }).find((x) => x.machineId === machineId);
  if (!raw || raw.investmentOre === 0) return null;
  // Minst dagarna sedan första ordern (som Enhetsekonomi), om placeringen är sent inlagd.
  const u = withSellingDays(
    raw,
    sellingSpan(input.current.orders, machineId, input.current.period),
  );
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
  /** Automatens dagar med data i perioden (eller perioden, om ingen order finns). */
  span: Span;
  /** Perioden är bara i dag och dagens order har inte kommit än. */
  pendingToday?: boolean;
  store: { name: string; since: IsoDate } | null;
  today: IsoDate;
}): { title: string; aside: string } {
  const { code, lifecycle, figures, previous, span, store, today } = args;
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
          ? `${kr(figures.revenueOre)} i intäkt ${span.text}. Historiken finns kvar.`
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
    return {
      title: args.pendingToday
        ? `${code} har inga order i dag ännu.`
        : `${code} har inte sålt något ${span.text}.`,
      aside: storeText,
    };
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
      // "Vår vinst" (före butikernas andel) som på Hem, Lönsamhet och i tabellerna, "Vår
      // del" efter andelen med vyknappen.
      `${figures.profitOre < 0 ? "Vår förlust" : ourProfitLabel(figures.storeShareDeducted === true)} ${kr(Math.abs(figures.profitOre))}.`,
    );
  }
  if (storeText) parts.push(storeText);
  return {
    title: `${code}: ${kr(figures.revenueOre)} ${span.text}.`,
    aside: joinClauses(parts),
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
      // Samma regel överallt: vår vinst före butikernas andel, vår del efter den (som Hem
      // och Lönsamhet).
      label: ourProfitLabel(totals.storeShareDeducted === true, totals.profitOre),
      value: totals.profitOre,
      kind: "sek",
      delta: rel(totals.profitChange),
    },
    // Andelen som dragits, bara när den dras (vyknappen eller vald butik).
    ...(totals.storeShareDeducted === true && totals.storeShareOre !== undefined
      ? [
          {
            id: "store-share",
            label: totals.storeShareLabel ?? "Butikernas andel",
            value: totals.storeShareOre,
            kind: "sek" as const,
            delta: null,
          },
        ]
      : []),
    {
      id: "margin",
      label: ourMarginLabel(totals.storeShareDeducted === true, "Marginal"),
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
      label: "Efter avskrivning",
      value: u.profitPerMonthAfterDepreciationOre ?? Number.NaN,
      kind: "sek",
      delta: null,
    },
  ];
}

// ---------------------------------------------------------------------------
// Överst: vad som behöver göras
// ---------------------------------------------------------------------------

/** En automat i listan överst: vad som är fel och vart knappen går. */
export interface MachineNeed {
  readonly id: string;
  readonly place: string;
  readonly code: string;
  readonly label: string;
  readonly reason: string | null;
  readonly status: MachineStatusView["status"];
  /** Intäkt i risk de närmaste 7 dagarna (öre). 0 när inget står på spel eller inte visas. */
  readonly stakeOre: number;
  /** "Tappar ca 1 700 kr den här veckan", eller null. */
  readonly stakeText: string | null;
  /** "Fyll på senast torsdag." (besöksplanens dag) för "Fyll på snart", annars null. */
  readonly refillBy: string | null;
  /** "Fyll på" (till Fyll på-appen) eller "Öppna" (automatens sida). */
  readonly action: { readonly label: string; readonly href: string };
}

export interface NeedOptions {
  /** Användaren ser ekonomi (ägare, admin, läsare). Annars visas inga kronor. Standard ja. */
  readonly economy?: boolean;
  /** Besöksplanens senaste dag per automat (refillByDates), för "Fyll på senast torsdag.". */
  readonly refillBy?: ReadonlyMap<string, IsoDate>;
  /** Dagens affärsdatum (behövs med `refillBy`). */
  readonly today?: IsoDate;
}

/**
 * Automaterna som behöver något, värst först: fel/tom/ur drift och "Fyll på nu" (signal),
 * sedan "Fyll på snart" och "Misstänkt fel". Inom varje nivå den som tappar mest pengar
 * först. Påfyllning går till Fyll på-appen.
 */
export function machineNeeds(
  rows: readonly MachineListRow[],
  options: NeedOptions = {},
): MachineNeed[] {
  const economy = options.economy !== false;
  const rank = (r: MachineListRow) =>
    r.status.flagged ? 0 : r.status.status === "warning" ? 1 : 2;
  const stake = (r: MachineListRow) => (economy ? Math.max(r.atStakeOre ?? 0, 0) : 0);
  return rows
    .filter((r) => r.lifecycle === "active" && rank(r) < 2)
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        stake(b) - stake(a) ||
        a.code.localeCompare(b.code, "sv", { numeric: true }),
    )
    .map((r) => {
      const refill = r.refillNow + r.refillSoon > 0 || r.status.health === "empty";
      const stakeOre = stake(r);
      const by = r.status.label === "Fyll på snart" ? options.refillBy?.get(r.id) : undefined;
      return {
        id: r.id,
        place: r.storeName ?? r.name,
        code: r.code,
        label: r.status.label,
        reason: r.status.reason,
        status: r.status.status,
        stakeOre,
        stakeText: stakeOre > 0 ? `Tappar ca ${kr(stakeOre)} den här veckan` : null,
        refillBy: by && options.today ? refillByText(by, options.today) : null,
        action: refill
          ? { label: "Fyll på", href: `/fyll-pa/${r.id}` }
          : { label: "Öppna", href: r.href },
      };
    });
}

/**
 * Sidans rubrik: hur många automater som behöver något, och hur mycket som står på spel i
 * veckan (summan av raderna, samma 7-dagarsbelopp som Att göra).
 */
export function needsHeadline(needs: readonly MachineNeed[], machines: number): string {
  if (machines === 0) return "Inga automater ännu.";
  const urgent = needs.filter((n) => n.status === "critical").length;
  if (needs.length === 0) return "Alla automater rullar.";
  const total = needsStake(needs);
  const money = total > 0 ? ` Ca ${kr(total)} står på spel i veckan.` : "";
  // Kronorna är summan av alla rader: finns det också rader som bara är "snart" nämns de,
  // så att antalet och beloppet gäller samma automater.
  const later = needs.length - urgent;
  if (urgent > 0) {
    const also = later > 0 && total > 0 ? `, ${formatInt(later)} snart` : "";
    return `${plural(urgent, "automat", "automater")} behöver dig nu${also}.${money}`;
  }
  return `${plural(needs.length, "automat", "automater")} behöver dig snart.${money}`;
}

/** Summan av radernas kronor (öre). */
export function needsStake(needs: readonly Pick<MachineNeed, "stakeOre">[]): number {
  return needs.reduce((n, x) => n + x.stakeOre, 0);
}

/**
 * Besöksplanens senaste dag per automat (samma plan som Drift → Besök och Lager): bara
 * automater som har ett besök i planen.
 */
export function refillByDates(plan: Pick<VisitPlan, "days">): Map<string, IsoDate> {
  const out = new Map<string, IsoDate>();
  for (const d of plan.days) for (const stop of d.stops) out.set(stop.machineId, stop.needBy);
  return out;
}
