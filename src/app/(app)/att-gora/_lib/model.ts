/**
 * Vymodellen för Att göra: punkterna från @/analytics/todos översatta till det sidan
 * visar (grupper efter brådska, rubrik, mått, åtgärd). Ren och utan I/O; testas i
 * model.test.ts. Inga egna beräkningar av ekonomi: belopp och dagar kommer ur punkternas
 * underlag (evidence) och summeras bara för rubriken (sumOre).
 */

import {
  LOST_REVENUE_FIGURE,
  todoInScope,
  type EvidenceFigure,
  type TodoItem,
  type TodoKind,
  type TodoLevel,
} from "@/analytics/todos";
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
  /** Rubrikens första del: hur många punkter. */
  readonly title: string;
  /** Rubrikens andra del: hur många som måste göras i dag. */
  readonly aside: string;
  /** Raden under rubriken: det mest brådskande, intäkten i risk och filtret. */
  readonly description: string;
  readonly meta: { label: string; value: string }[];
}

/** En avbockad punkt i listan "Avbockade". */
export interface DismissedView {
  readonly key: string;
  /** Mono-etikett, t.ex. "Påfyllning". */
  readonly eyebrow: string;
  readonly title: string;
  /** "Avbockad för 4 min sedan av dig." */
  readonly meta: string;
}

export interface PageView {
  readonly header: HeaderView;
  readonly groups: GroupView[];
  readonly total: number;
  /** Punkter som döljs av filtret (butik/automat). */
  readonly hiddenByScope: number;
  readonly economy: boolean;
  /** Avbockade punkter (inom filtret), nyast först. */
  readonly dismissed: DismissedView[];
}

/** En sparad avbockning som sidan laddat (service.loadDismissedFor), med tiden formaterad. */
export interface DismissedInput {
  readonly key: string;
  readonly title: string | null;
  /** Relativ tid i organisationens tidszon, t.ex. "för 4 min sedan". */
  readonly when: string;
  readonly by: string | null;
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
  /** Avbockade punkter som inte står i listan just nu. */
  readonly dismissed?: readonly DismissedInput[];
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

/** Hårt bindestreck (U+2011) i id som BL-002 så att de aldrig bryts (docs/design.md §4). */
export const NBHYPHEN = "\u2011";

export function unbreakable(code: string): string {
  return code.replace(/-/g, NBHYPHEN);
}

const KIND_NOUN: Record<TodoKind, [string, string]> = {
  refill: ["påfyllning", "påfyllningar"],
  "stale-machine": ["tyst automat", "tysta automater"],
  "report-due": ["rapport att skicka", "rapporter att skicka"],
  "report-review": ["utkast att granska", "utkast att granska"],
  contract: ["avtal att se över", "avtal att se över"],
  alert: ["larm", "larm"],
  "missing-price": ["titel utan inköpspris", "titlar utan inköpspris"],
  "duplicate-title": ["möjlig dubblett", "möjliga dubbletter"],
};

const KIND_LABEL: Record<TodoKind, string> = {
  refill: "Påfyllning",
  "stale-machine": "Ingen försäljning",
  "report-due": "Rapport",
  "report-review": "Rapportutkast",
  contract: "Avtal",
  alert: "Larm",
  "missing-price": "Inköpspris",
  "duplicate-title": "Datakvalitet",
};

const KIND_ORDER: readonly TodoKind[] = [
  "refill",
  "stale-machine",
  "alert",
  "report-review",
  "report-due",
  "contract",
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
  const deadline = () => {
    if (item.daysLeft === null) return;
    out.push(
      item.daysLeft < 0
        ? { label: "Försenad", value: plural(-item.daysLeft, "dag", "dagar") }
        : { label: "Dagar kvar", value: formatInt(item.daysLeft) },
    );
  };
  switch (item.kind) {
    case "refill": {
      const tenths = figureValue(item, "daysLeftTenths");
      const onHand = figureValue(item, "onHand");
      const lostOre = figureValue(item, LOST_REVENUE_FIGURE);
      const lost = economy && lostOre !== null && lostOre > 0 ? lostOre : null;
      if (onHand !== null)
        out.push({ label: "I automaten", value: formatFigure({ value: onHand, unit: "packs" }) });
      if (onHand !== null && onHand <= 0) {
        // "0 pack" säger redan att den är slut; då får förlorad försäljning platsen.
        if (lost === null) out.push({ label: "Räcker", value: "Slut" });
      } else if (tenths !== null) {
        out.push({ label: "Räcker", value: `${formatDecimal(tenths / 10)}${NBSP}d` });
      }
      stake();
      if (lost !== null) out.push({ label: "Förlorat 14 d", value: kr(lost) });
      break;
    }
    case "stale-machine": {
      const hours = figureValue(item, "silentHours");
      if (hours !== null) out.push({ label: "Tyst", value: `${formatInt(hours)}${NBSP}h` });
      stake();
      break;
    }
    case "report-due": {
      deadline();
      const failed = figureValue(item, "failedDeliveries");
      if (failed !== null && failed > 0)
        out.push({ label: "Misslyckade", value: formatInt(failed) });
      break;
    }
    case "report-review": {
      const drafts = figureValue(item, "drafts");
      if (drafts !== null) out.push({ label: "Utkast", value: formatInt(drafts) });
      deadline();
      break;
    }
    case "contract": {
      const toDeadline = figureValue(item, "daysToDeadline");
      const toEnd = figureValue(item, "daysToEnd");
      if (toDeadline !== null && toDeadline >= 0)
        out.push({ label: "Säg upp inom", value: plural(toDeadline, "dag", "dagar") });
      if (toEnd !== null)
        out.push(
          toEnd < 0
            ? { label: "Gick ut för", value: plural(-toEnd, "dag", "dagar") }
            : { label: "Slutar om", value: plural(toEnd, "dag", "dagar") },
        );
      break;
    }
    case "alert": {
      const hours = figureValue(item, "openHours");
      if (hours !== null) out.push({ label: "Öppet", value: `${formatInt(hours)}${NBSP}h` });
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
        machineCode: machine ? unbreakable(machine.code) : "",
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
    case "review-report":
      return canOpen(input.role, "rapporter")
        ? { kind: "link", label: a.label, href: item.link }
        : null;
    case "open-contract":
      return canOpen(input.role, "avtal")
        ? { kind: "link", label: a.label, href: item.link }
        : null;
    case "open-alert":
      return canOpen(input.role, item.link.startsWith("/datakallor") ? "datakallor" : "drift")
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
    eyebrow: code ? `${KIND_LABEL[item.kind]} · ${unbreakable(code)}` : KIND_LABEL[item.kind],
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

/** Minst en av automaterna matchar filtret (?automat, eller automatens butik för ?butik). */
function machinesInScope(
  ids: readonly string[],
  input: Pick<ModelInput, "scope" | "machines">,
): boolean {
  const { storeId, machineId } = input.scope;
  return ids.some((id) => {
    if (machineId && id !== machineId) return false;
    if (storeId) return input.machines.find((m) => m.id === id)?.storeId === storeId;
    return true;
  });
}

/**
 * Filtret i URL:en (?butik, ?automat): punkter som gäller automater visas bara om någon
 * av dem matchar. Punkter utan automat (inköpspris, dubbletter, rapporter till revisor)
 * gäller hela organisationen och visas alltid; rapporter och avtal för en butik följer
 * butiken, med bara automatfilter automatens butik. Samma regel som Hem (`todoInScope`).
 */
export function inScope(item: TodoItem, input: Pick<ModelInput, "scope" | "machines">): boolean {
  return todoInScope(item, input.scope, input.machines);
}

/**
 * Sorterna där intäkt faktiskt står på spel: tomt eller snart tomt lager och automater
 * som slutat sälja. En titel utan inköpspris säljer som vanligt (bara vinsten blir
 * ofullständig) och en dubblett är datakvalitet, så deras belopp räknas inte hit.
 */
const RISK_KINDS: ReadonlySet<TodoKind> = new Set(["refill", "stale-machine"]);

/** Intäkt i risk de närmaste 7 dagarna (öre), bara för RISK_KINDS. */
/**
 * Varje punkt avrundad till hela kronor innan summan tas, så att rubrikens summa är summan
 * av beloppen på raderna (11 840 kr, inte 11 841 kr när raderna säger 11 840 kr).
 */
function wholeKronor(ore: number): number {
  return Math.round(Math.max(ore, 0) / 100) * 100;
}

export function stakeOf(items: readonly TodoItem[]): number {
  return sumOre(
    items.filter((i) => RISK_KINDS.has(i.kind)).map((i) => wholeKronor(i.atStakeOre ?? 0)),
  );
}

/** Intäkt utan inköpspris (öre), ur punkternas underlag. */
export function unpricedOf(items: readonly TodoItem[]): number {
  return sumOre(
    items
      .filter((i) => i.kind === "missing-price")
      .map((i) => wholeKronor(figureValue(i, "unpricedRevenueOre") ?? 0)),
  );
}

function groupAside(items: readonly TodoItem[], economy: boolean): string {
  const parts = [capitalize(kindSummary(items))];
  const stake = economy ? stakeOf(items) : 0;
  if (stake > 0) parts.push(`${kr(stake)} i intäkt i risk de närmaste 7 dagarna`);
  const unpriced = economy ? unpricedOf(items) : 0;
  // "titlar utan inköpspris" står redan i första delen; beloppet säger vad det betyder.
  if (unpriced > 0) parts.push(`${kr(unpriced)} i intäkt räknas inte in i vinsten`);
  return withPeriod(parts.join(", "));
}

function stripPeriod(s: string): string {
  return s.trim().replace(/[.]$/, "");
}

/** Den mest brådskande punkten i en mening: "Först: Fyll på X i Y, räcker 0,5 d." */
function leadText(item: TodoItem): string {
  let fact = "";
  if (item.kind === "refill") {
    const onHand = figureValue(item, "onHand");
    const tenths = figureValue(item, "daysLeftTenths");
    if (onHand !== null && onHand <= 0) fact = "";
    else if (tenths !== null) fact = `, räcker ${formatDecimal(tenths / 10)}${NBSP}d`;
  }
  // En tyst automat: titeln säger redan hur länge ("har inte sålt på 66 timmar").
  return `Först: ${stripPeriod(item.title)}${fact}.`;
}

function hiddenText(hidden: number, scope: ModelInput["scope"]): string {
  const where = scope.machineId ? "andra automater" : "andra butiker";
  return `Filtret döljer ${plural(hidden, "punkt", "punkter")} för ${where}.`;
}

function headerView(
  visible: readonly TodoItem[],
  lead: TodoItem | null,
  hidden: number,
  input: ModelInput,
): HeaderView {
  const count = (l: TodoLevel) => visible.filter((i) => i.level === l).length;
  const now = count("now");
  const stake = input.economy ? stakeOf(visible) : 0;
  const unpriced = input.economy ? unpricedOf(visible) : 0;

  let title: string;
  let aside: string;
  const parts: string[] = [];
  if (visible.length === 0) {
    title = "Inget att göra.";
    aside =
      input.role === "refiller"
        ? "Lagret räcker minst 2,5 dagar i alla automater, och alla har sålt de senaste 48 timmarna."
        : "Lagret räcker, automaterna säljer, alla titlar har inköpspris, rapporterna är skickade och inget larm eller avtal väntar.";
  } else {
    const onlyRefills = visible.every((i) => i.kind === "refill");
    title = onlyRefills
      ? `${plural(visible.length, "påfyllning", "påfyllningar")} att göra.`
      : `${plural(visible.length, "sak", "saker")} att göra.`;
    aside = now > 0 ? `${formatInt(now)} måste göras i dag.` : "Inget måste göras i dag.";
    if (lead) parts.push(leadText(lead));
    if (stake > 0) {
      // Beloppet gäller påfyllningar och tysta automater; när den första punkten är något
      // annat (utkast, avtal, larm) sägs det, så att beloppet inte kopplas till den.
      parts.push(
        lead && RISK_KINDS.has(lead.kind)
          ? `${kr(stake)} i intäkt står på spel de närmaste 7 dagarna.`
          : `${
              visible.some((i) => i.kind === "stale-machine")
                ? "Påfyllningar och tysta automater"
                : "Påfyllningarna"
            }: ${kr(stake)} i intäkt i risk de närmaste 7 dagarna.`,
      );
    }
  }
  if (hidden > 0) parts.push(hiddenText(hidden, input.scope));

  const meta: { label: string; value: string }[] = [];
  for (const level of LEVELS) {
    const n = count(level);
    if (n > 0) meta.push({ label: LEVEL_TEXT[level], value: formatInt(n) });
  }
  if (input.economy && stake > 0) meta.push({ label: "I risk 7 d", value: kr(stake) });
  // Intäkt utan inköpspris är inte i risk (bara vinsten blir ofullständig): eget mått.
  if (unpriced > 0) meta.push({ label: "Utan inköpspris", value: kr(unpriced) });
  meta.push({ label: "Beräknat", value: input.computedAt });
  return { title, aside, description: parts.join(" "), meta };
}

/** Nyckelns automat ('refill:<automat>:<titel>', 'stale-machine:<automat>'), annars null. */
function machineOfKey(key: string): string | null {
  const [kind, id] = key.split(":");
  return (kind === "refill" || kind === "stale-machine") && id ? id : null;
}

const KIND_BY_PREFIX: Record<string, TodoKind> = {
  refill: "refill",
  "stale-machine": "stale-machine",
  "report-due": "report-due",
  "report-review": "report-review",
  contract: "contract",
  alert: "alert",
  "missing-price": "missing-price",
  "duplicate-title": "duplicate-title",
};

/** Avbockade punkter inom filtret, med samma etikett som i listan. */
export function dismissedViews(input: ModelInput): DismissedView[] {
  return (input.dismissed ?? [])
    .filter((d) => {
      const machineId = machineOfKey(d.key);
      return machineId === null || machinesInScope([machineId], input);
    })
    .map((d) => {
      const kind = KIND_BY_PREFIX[d.key.slice(0, d.key.indexOf(":"))];
      const machineId = machineOfKey(d.key);
      const code = machineId ? input.machines.find((m) => m.id === machineId)?.code : undefined;
      const label = kind ? KIND_LABEL[kind] : "Punkt";
      return {
        key: d.key,
        eyebrow: code ? `${label} · ${unbreakable(code)}` : label,
        title: d.title ? withPeriod(d.title) : "Punkt utan sparad rubrik.",
        meta: `Avbockad ${d.when}${d.by ? ` av ${d.by}` : ""}.`,
      };
    });
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
  // Punkterna är sorterade efter brådska: den första är den mest brådskande.
  const lead = visible[0] ?? null;
  return {
    header: headerView(visible, lead, hidden, input),
    groups,
    total: visible.length,
    hiddenByScope: hidden,
    economy: input.economy,
    dismissed: dismissedViews(input),
  };
}
