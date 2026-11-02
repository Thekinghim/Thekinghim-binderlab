/**
 * Vymodellen för Att göra: punkterna från @/analytics/todos översatta till det sidan
 * visar (grupper efter brådska, rubrik, mått, åtgärd). Ren och utan I/O; testas i
 * model.test.ts. Inga egna beräkningar av ekonomi: belopp och dagar kommer ur punkternas
 * underlag (evidence) och summeras bara för rubriken (sumOre).
 */

import type { EvidenceFigure, TodoItem, TodoKind, TodoLevel } from "@/analytics/todos";
import type { Role } from "@/components/shell/nav";
import { routeById } from "@/components/shell/nav";
import type { Status } from "@/components/ui/status-tag";
import { sumOre } from "@/domain";
import { formatDecimal, formatInt, formatPercent, formatSek, NBSP } from "@/lib/format";

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

export interface FigureView {
  readonly label: string;
  readonly value: string;
}

export interface RefillActionView {
  readonly kind: "register-refill";
  readonly label: string;
  readonly machineId: string;
  readonly titleId: string;
  readonly machineName: string;
  readonly machineCode: string;
  readonly titleName: string;
  /** Pack i automaten nu. */
  readonly onHand: number;
  /** Pack av titeln i centrallagret, eller null om det saknas ett centrallager. */
  readonly warehouseOnHand: number | null;
  /** Sålda pack de senaste 14 dagarna (underlaget), eller null. */
  readonly unitsInWindow: number | null;
  readonly windowDays: number | null;
  /** Förslag på antal: fyll till 14 dagars försäljning, högst det som finns i centrallagret. */
  readonly suggested: number;
}

export interface MergeActionView {
  readonly kind: "merge-titles";
  readonly label: string;
  readonly from: { readonly id: string; readonly name: string; readonly orders: number | null };
  readonly into: { readonly id: string; readonly name: string; readonly orders: number | null };
}

export interface LinkActionView {
  readonly kind: "link";
  readonly label: string;
  readonly href: string;
}

export type ActionView = RefillActionView | MergeActionView | LinkActionView;

export interface TodoView {
  readonly key: string;
  readonly fingerprint: string;
  readonly kind: TodoKind;
  readonly level: TodoLevel;
  /** Mono-etikett, t.ex. "Påfyllning · BL-002". */
  readonly eyebrow: string;
  readonly status: Status;
  readonly statusText: string;
  /** Rubrik, med punkt på slutet. */
  readonly title: string;
  readonly detail: string;
  /** Upp till tre mått som står bredvid punkten. */
  readonly figures: FigureView[];
  readonly rule: string;
  /** Hela underlaget, formaterat. */
  readonly evidence: FigureView[];
  readonly action: ActionView | null;
  /** Sekundär länk ("Visa i lager"), om rollen får öppna sidan. */
  readonly link: LinkActionView | null;
}

export interface GroupView {
  readonly level: TodoLevel;
  readonly id: string;
  readonly index: number;
  readonly eyebrow: string;
  readonly title: string;
  readonly aside: string;
  readonly items: TodoView[];
}

export interface HeaderView {
  readonly title: string;
  readonly aside: string;
  readonly meta: { label: string; value: string }[];
}

export interface PageView {
  readonly header: HeaderView;
  readonly groups: GroupView[];
  readonly total: number;
  /** Punkter som döljs av filtret (butik/automat). */
  readonly hiddenByScope: number;
  readonly economy: boolean;
}

/** Det sidan behöver veta om stamdata och lager. */
export interface ModelInput {
  readonly todos: readonly TodoItem[];
  readonly role: Role;
  readonly economy: boolean;
  readonly titles: ReadonlyArray<{ id: string; name: string }>;
  readonly machines: ReadonlyArray<{
    id: string;
    name: string;
    code: string;
    storeId: string | null;
  }>;
  /** Saldo i automaterna. */
  readonly machineStock: ReadonlyArray<{ machineId: string; titleId: string; onHand: number }>;
  /** Saldo i centrallagret per titel, eller null om det saknas ett centrallager. */
  readonly warehouse: ReadonlyMap<string, number> | null;
  readonly scope: { readonly storeId: string | null; readonly machineId: string | null };
  /** Klockslaget punkterna räknades, t.ex. "09:42". */
  readonly computedAt: string;
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** "1 påfyllning" · "3 påfyllningar". */
export function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

/** "a", "a och b", "a, b och c". */
export function joinSv(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} och ${parts[parts.length - 1]}`;
}

/** Första bokstaven versal. */
function capitalize(s: string): string {
  return s.length > 0 ? s[0]!.toLocaleUpperCase("sv-SE") + s.slice(1) : s;
}

/** Lägger till punkt om texten inte redan slutar med punkt, frågetecken eller utropstecken. */
export function withPeriod(s: string): string {
  const t = s.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

const KIND_NOUN: Record<TodoKind, [string, string]> = {
  refill: ["påfyllning", "påfyllningar"],
  "stale-machine": ["tyst automat", "tysta automater"],
  "report-due": ["rapport att skicka", "rapporter att skicka"],
  "missing-price": ["titel utan inköpspris", "titlar utan inköpspris"],
  "duplicate-title": ["möjlig dubblett", "möjliga dubbletter"],
};

const KIND_LABEL: Record<TodoKind, string> = {
  refill: "Påfyllning",
  "stale-machine": "Ingen försäljning",
  "report-due": "Rapport",
  "missing-price": "Inköpspris",
  "duplicate-title": "Datakvalitet",
};

const KIND_ORDER: readonly TodoKind[] = [
  "refill",
  "stale-machine",
  "report-due",
  "missing-price",
  "duplicate-title",
];

/** "3 påfyllningar och 1 tyst automat". */
export function kindSummary(items: readonly { kind: TodoKind }[]): string {
  const counts = new Map<TodoKind, number>();
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  return joinSv(
    KIND_ORDER.filter((k) => counts.has(k)).map((k) => {
      const [one, many] = KIND_NOUN[k];
      return plural(counts.get(k)!, one, many);
    }),
  );
}

/** Öre → "12 480 kr" (hela kronor). */
export function kr(ore: number): string {
  return formatSek(ore / 100);
}

// ---------------------------------------------------------------------------
// Underlag
// ---------------------------------------------------------------------------

/** Ett tal ur underlaget i sin enhet. */
export function formatFigure(f: Pick<EvidenceFigure, "value" | "unit">): string {
  switch (f.unit) {
    case "ore":
      return kr(f.value);
    case "bp":
      return formatPercent(f.value / 10_000, 0);
    case "packs":
      return `${formatInt(f.value)}${NBSP}pack`;
    case "days":
      return plural(f.value, "dag", "dagar");
    case "hours":
      return `${formatInt(f.value)}${NBSP}h`;
    case "tenths":
      return formatDecimal(f.value / 10);
    case "count":
    default:
      return formatInt(f.value);
  }
}

function figure(item: TodoItem, key: string): EvidenceFigure | undefined {
  return item.evidence.figures.find((f) => f.key === key);
}

function figureValue(item: TodoItem, key: string): number | null {
  return figure(item, key)?.value ?? null;
}

/** Måtten som står bredvid punkten. Belopp bara för roller som ser ekonomi. */
export function primaryFigures(item: TodoItem, economy: boolean): FigureView[] {
  const out: FigureView[] = [];
  const stake = (label = "I risk 7 d") => {
    if (economy && item.atStakeOre !== null && item.atStakeOre > 0) {
      out.push({ label, value: kr(item.atStakeOre) });
    }
  };
  switch (item.kind) {
    case "refill": {
      const tenths = figureValue(item, "daysLeftTenths");
      const onHand = figureValue(item, "onHand");
      if (onHand !== null)
        out.push({ label: "I automaten", value: formatFigure({ value: onHand, unit: "packs" }) });
      if (onHand !== null && onHand <= 0) {
        out.push({ label: "Räcker", value: "Slut" });
      } else if (tenths !== null) {
        out.push({ label: "Räcker", value: `${formatDecimal(tenths / 10)}${NBSP}d` });
      }
      stake();
      break;
    }
    case "stale-machine": {
      const hours = figureValue(item, "silentHours");
      if (hours !== null) out.push({ label: "Tyst", value: `${formatInt(hours)}${NBSP}h` });
      stake();
      break;
    }
    case "report-due": {
      if (item.daysLeft !== null) {
        out.push(
          item.daysLeft < 0
            ? { label: "Försenad", value: plural(-item.daysLeft, "dag", "dagar") }
            : { label: "Dagar kvar", value: formatInt(item.daysLeft) },
        );
      }
      const failed = figureValue(item, "failedDeliveries");
      if (failed !== null && failed > 0)
        out.push({ label: "Misslyckade", value: formatInt(failed) });
      break;
    }
    case "missing-price": {
      const orders = figureValue(item, "unpricedOrders");
      const revenue = figureValue(item, "unpricedRevenueOre");
      if (orders !== null) out.push({ label: "Order", value: formatInt(orders) });
      if (economy && revenue !== null) out.push({ label: "Intäkt utan pris", value: kr(revenue) });
      break;
    }
    case "duplicate-title": {
      const similarity = figureValue(item, "similarityBp");
      if (similarity !== null) {
        out.push({ label: "Likhet", value: formatPercent(similarity / 10_000, 0) });
      }
      const from = figureValue(item, "fromOrders");
      if (from !== null) out.push({ label: "Order att flytta", value: formatInt(from) });
      break;
    }
  }
  return out.slice(0, 3);
}

/** Hela underlaget, formaterat. Belopp tas bort för roller som inte ser ekonomi. */
export function evidenceFigures(item: TodoItem, economy: boolean): FigureView[] {
  return item.evidence.figures
    .filter((f) => economy || f.unit !== "ore")
    .map((f) => ({ label: f.label, value: formatFigure(f) }));
}

// ---------------------------------------------------------------------------
// Åtgärder
// ---------------------------------------------------------------------------

function canOpen(role: Role, id: Parameters<typeof routeById>[0]): boolean {
  return routeById(id).roles.includes(role);
}

/** Förslag på antal vid påfyllning: fyll till fönstrets försäljning, minst 1, högst centrallagret. */
export function suggestRefill(
  onHand: number,
  unitsInWindow: number | null,
  warehouseOnHand: number | null,
): number {
  const target = unitsInWindow !== null && unitsInWindow > 0 ? unitsInWindow : 1;
  let n = Math.max(target - Math.max(onHand, 0), 1);
  if (warehouseOnHand !== null && warehouseOnHand > 0) n = Math.min(n, warehouseOnHand);
  return n;
}

function actionFor(item: TodoItem, input: ModelInput): ActionView | null {
  const a = item.action;
  if (!a) {
    if (item.kind === "stale-machine") {
      const machineId = item.evidence.machineIds[0];
      if (machineId && !canOpen(input.role, "automater") && canOpen(input.role, "lager")) {
        return { kind: "link", label: "Visa lagret", href: `/lager?automat=${machineId}` };
      }
      return canOpen(input.role, "automater")
        ? { kind: "link", label: "Öppna automaten", href: item.link }
        : null;
    }
    return null;
  }
  switch (a.kind) {
    case "register-refill": {
      const machineId = a.params.machineId ?? "";
      const titleId = a.params.titleId ?? "";
      const machine = input.machines.find((m) => m.id === machineId);
      const onHand =
        figureValue(item, "onHand") ??
        input.machineStock.find((s) => s.machineId === machineId && s.titleId === titleId)
          ?.onHand ??
        0;
      const warehouseOnHand = input.warehouse ? (input.warehouse.get(titleId) ?? 0) : null;
      const unitsInWindow = figureValue(item, "unitsInWindow");
      return {
        kind: "register-refill",
        label: a.label,
        machineId,
        titleId,
        machineName: machine?.name ?? machineId,
        machineCode: machine?.code ?? "",
        titleName: input.titles.find((t) => t.id === titleId)?.name ?? titleId,
        onHand,
        warehouseOnHand,
        unitsInWindow,
        windowDays: figureValue(item, "windowDays"),
        suggested: suggestRefill(onHand, unitsInWindow, warehouseOnHand),
      };
    }
    case "merge-titles": {
      const fromId = a.params.fromTitleId ?? "";
      const intoId = a.params.intoTitleId ?? "";
      const name = (id: string) => input.titles.find((t) => t.id === id)?.name ?? id;
      return {
        kind: "merge-titles",
        label: a.label,
        from: { id: fromId, name: name(fromId), orders: figureValue(item, "fromOrders") },
        into: { id: intoId, name: name(intoId), orders: figureValue(item, "intoOrders") },
      };
    }
    case "add-price":
      return canOpen(input.role, "inkopspriser")
        ? { kind: "link", label: a.label, href: item.link }
        : null;
    case "send-report":
      return canOpen(input.role, "rapporter")
        ? { kind: "link", label: a.label, href: item.link }
        : null;
  }
}

function secondaryLink(item: TodoItem, role: Role): LinkActionView | null {
  if (item.kind === "refill" && canOpen(role, "lager")) {
    return { kind: "link", label: "Visa i lager", href: item.link };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Status och grupper
// ---------------------------------------------------------------------------

/** Högst tre signalmarkeringar per vy (docs/design.md, avsnitt 3). */
export const SIGNAL_BUDGET = 3;

const LEVEL_TEXT: Record<TodoLevel, string> = { now: "I dag", soon: "Snart", later: "Senare" };

const GROUP_META: Record<TodoLevel, { id: string; eyebrow: string; title: string }> = {
  now: { id: "i-dag", eyebrow: "I dag", title: "Gör i dag." },
  soon: { id: "snart", eyebrow: "De närmaste dagarna", title: "Gör de närmaste dagarna." },
  later: { id: "senare", eyebrow: "När tid finns", title: "Gör när tid finns." },
};

const LEVELS: readonly TodoLevel[] = ["now", "soon", "later"];

function machineCodeOf(item: TodoItem, input: ModelInput): string | null {
  const id = item.evidence.machineIds[0];
  if (!id) return null;
  return input.machines.find((m) => m.id === id)?.code ?? null;
}

/** Punkten översatt till vyn. `signal` = punkten får signalmarkering (inom budgeten). */
export function toView(item: TodoItem, input: ModelInput, signal: boolean): TodoView {
  const code = machineCodeOf(item, input);
  const status: Status =
    item.level === "now"
      ? signal
        ? "critical"
        : "warning"
      : item.level === "soon"
        ? "warning"
        : "neutral";
  return {
    key: item.key,
    fingerprint: item.fingerprint,
    kind: item.kind,
    level: item.level,
    eyebrow: code ? `${KIND_LABEL[item.kind]} · ${code}` : KIND_LABEL[item.kind],
    status,
    statusText: LEVEL_TEXT[item.level],
    title: withPeriod(item.title),
    detail: item.detail,
    figures: primaryFigures(item, input.economy),
    rule: item.evidence.rule,
    evidence: evidenceFigures(item, input.economy),
    action: actionFor(item, input),
    link: secondaryLink(item, input.role),
  };
}

/**
 * Filtret i URL:en (?butik, ?automat): punkter som gäller automater visas bara om någon
 * av dem matchar. Punkter utan automat (inköpspris, dubbletter, rapporter till revisor)
 * gäller hela organisationen och visas alltid; rapporter till en butik följer butiken.
 */
export function inScope(item: TodoItem, input: Pick<ModelInput, "scope" | "machines">): boolean {
  const { storeId, machineId } = input.scope;
  if (!storeId && !machineId) return true;
  const machines = item.evidence.machineIds;
  if (machines.length > 0) {
    return machines.some((id) => {
      if (machineId && id !== machineId) return false;
      if (storeId) return input.machines.find((m) => m.id === id)?.storeId === storeId;
      return true;
    });
  }
  if (storeId && item.evidence.storeIds.length > 0) return item.evidence.storeIds.includes(storeId);
  return true;
}

function stakeOf(items: readonly TodoItem[]): number {
  return sumOre(items.map((i) => Math.max(i.atStakeOre ?? 0, 0)));
}

function groupAside(items: readonly TodoItem[], economy: boolean): string {
  const parts = [capitalize(kindSummary(items))];
  const stake = economy ? stakeOf(items) : 0;
  if (stake > 0) parts.push(`${kr(stake)} i intäkt i risk de närmaste 7 dagarna`);
  return withPeriod(parts.join(", "));
}

function headerView(visible: readonly TodoItem[], hidden: number, input: ModelInput): HeaderView {
  const count = (l: TodoLevel) => visible.filter((i) => i.level === l).length;
  const now = count("now");
  const stake = input.economy ? stakeOf(visible) : 0;

  let title: string;
  let aside: string;
  if (visible.length === 0) {
    title = "Inget att göra.";
    aside =
      input.role === "refiller"
        ? "Lagret räcker minst 2,5 dagar i alla automater, och alla har sålt de senaste 48 timmarna."
        : "Lagret räcker, automaterna säljer, alla titlar har inköpspris och rapporterna är skickade.";
  } else {
    title = `${plural(visible.length, "sak", "saker")} att göra.`;
    const parts: string[] = [];
    parts.push(now > 0 ? `${formatInt(now)} i dag` : "Inget som måste göras i dag");
    if (stake > 0) parts.push(`${kr(stake)} i intäkt står på spel de närmaste 7 dagarna`);
    aside = withPeriod(capitalize(parts.join(", ")));
  }
  if (hidden > 0) {
    aside = `${aside} ${plural(hidden, "punkt", "punkter")} till gäller annat än filtret.`;
  }

  const meta: { label: string; value: string }[] = [
    { label: "I dag", value: formatInt(now) },
    { label: "Snart", value: formatInt(count("soon")) },
    { label: "Senare", value: formatInt(count("later")) },
  ];
  if (input.economy) meta.push({ label: "I risk 7 d", value: kr(stake) });
  meta.push({ label: "Beräknat", value: input.computedAt });
  return { title, aside, meta };
}

/** Hela sidan. Punkterna är redan sorterade efter brådska (computeTodos). */
export function buildPage(input: ModelInput): PageView {
  const visible = input.todos.filter((t) => inScope(t, input));
  const hidden = input.todos.length - visible.length;
  let signals = 0;
  const groups: GroupView[] = [];
  for (const level of LEVELS) {
    const items = visible.filter((t) => t.level === level);
    if (items.length === 0) continue;
    const meta = GROUP_META[level];
    groups.push({
      level,
      id: meta.id,
      index: groups.length + 1,
      eyebrow: meta.eyebrow,
      title: meta.title,
      aside: groupAside(items, input.economy),
      items: items.map((t) => {
        const signal = t.level === "now" && signals < SIGNAL_BUDGET;
        if (signal) signals += 1;
        return toView(t, input, signal);
      }),
    });
  }
  return {
    header: headerView(visible, hidden, input),
    groups,
    total: visible.length,
    hiddenByScope: hidden,
    economy: input.economy,
  };
}
