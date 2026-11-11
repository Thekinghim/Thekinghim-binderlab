/**
 * Vymodellen för Att göra: punkterna från @/analytics/todos översatta till det sidan
 * visar (grupper efter brådska, rubrik, mått, åtgärd). Ren och utan I/O; testas i
 * model.test.ts. Inga egna beräkningar av ekonomi: belopp och dagar kommer ur punkternas
 * underlag (evidence) och summeras bara för rubriken (sumOre).
 */

import {
  groupVisits,
  LOST_REVENUE_FIGURE,
  todoInScope,
  visitTitle,
  type EvidenceFigure,
  type TodoEntry,
  type TodoItem,
  type TodoKind,
  type TodoLevel,
  type TodoVisit,
  type VisitPlanDays,
} from "@/analytics/todos";
import { googleMapsUrls, type GeoPoint } from "@/analytics/visits";
import type { Role } from "@/components/shell/nav";
import { routeById } from "@/components/shell/nav";
import type { Status } from "@/components/ui/status-tag";
import { sumOre, type IsoDate } from "@/domain";
import { formatDecimal, formatInt, formatPercent, formatSek, NBSP } from "@/lib/format";

// Samma förslag och samma tak som Fyll på (läses bara, ändras aldrig här).
import { maxFill, suggestFill } from "@/app/fyll-pa/_lib/model";

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
  /** Fackens kapacitet för titeln i automaten (Awish), eller null om den är okänd. */
  readonly capacity: number | null;
  /** Mystery pack: pack per omgång (fylls bara på när facket är tomt), annars null. */
  readonly batchSize: number | null;
  /**
   * Pack av titeln i lagret automaten fylls på från ("Fylls på från", annars standardlagret),
   * eller null om det saknas ett eget lager.
   */
  readonly warehouseOnHand: number | null;
  /** Lagrets namn ("Kontoret"), eller null. */
  readonly warehouseName: string | null;
  /** Sålda pack de senaste 14 dagarna (underlaget), eller null. */
  readonly unitsInWindow: number | null;
  readonly windowDays: number | null;
  /** Förslaget, samma som Fyll på (suggestFill): det som får plats, högst packen i lagret. */
  readonly suggested: number;
  /** Största antal som går att fylla på, samma tak som Fyll på (maxFill). */
  readonly max: number;
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
  /** Måtten som en grå rad under rubriken i telefonen: "5 pack kvar · räcker 1,8 d · 2 300 kr i risk". */
  readonly facts: string;
  readonly rule: string;
  /** Hela underlaget, formaterat. */
  readonly evidence: FigureView[];
  readonly action: ActionView | null;
  /** Sekundär länk ("Visa i lager"), om rollen får öppna sidan. */
  readonly link: LinkActionView | null;
  /** Vem som gör punkten: användar-id, "" = Båda (@/analytics/team). */
  readonly assignee: string;
}

/**
 * Ett besök: automatens alla påfyllningar som en rad, "Åk till BL-003 senast torsdag".
 * Titlarna (items) är samma punkter som förut och bockas av var för sig.
 */
export interface VisitView {
  /** 'visit:<automat>'. Bara för visning, sparas aldrig. */
  readonly key: string;
  readonly level: TodoLevel;
  readonly status: Status;
  readonly statusText: string;
  /** "Åk till BL-003 senast torsdag." */
  readonly title: string;
  /** "4 titlar · 38 pack · 2 300 kr i risk" (kronor bara för roller som ser ekonomi). */
  readonly facts: string;
  readonly machineId: string;
  /** Titlarna att fylla på, i listans ordning. */
  readonly items: TodoView[];
  /** Vägbeskrivning till butiken, om den har adress eller plats. */
  readonly mapsHref: string | null;
  /** Fyll på-appen för automaten (ägare, admin och påfyllare). */
  readonly fillHref: string;
  /** Ta med-listan ligger överst i Fyll på. */
  readonly bringHref: string;
}

/** En rad i en grupp: en vanlig punkt eller ett besök. */
export type RowView =
  | { readonly type: "todo"; readonly item: TodoView }
  | { readonly type: "visit"; readonly visit: VisitView };

export interface GroupView {
  readonly level: TodoLevel;
  readonly id: string;
  readonly index: number;
  readonly eyebrow: string;
  readonly title: string;
  readonly aside: string;
  /** Raderna som visas: besök (en rad per automat) och övriga punkter. */
  readonly rows: RowView[];
  /** Alla punkter i gruppen, också de som ligger i ett besök. */
  readonly items: TodoView[];
}

export interface HeaderView {
  /** Rubrikens första del: hur många punkter. */
  readonly title: string;
  /** Rubrikens andra del: hur många som måste göras i dag. */
  readonly aside: string;
  /** Raden under rubriken: det mest brådskande, okänt saldo och filtret. */
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
  /** Alla punkter på sidan: reglernas inom filtret plus extras. */
  readonly total: number;
  /** Punkter som döljs av filtret (butik/automat). */
  readonly hiddenByScope: number;
  readonly economy: boolean;
  /** Automater inom filtret med okänt saldo (se ModelInput.unknownStockMachineIds). */
  readonly unknownStock: number;
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

/**
 * En punkt som inte kommer ur reglerna men står på sidan (bokföringen att ladda ner, en ny
 * automat att koppla). Den räknas i rubriken, så att rubriken aldrig säger "Inget att göra"
 * när sidan visar något att göra.
 */
export interface ExtraTodo {
  readonly key: string;
  /** Kort åtgärd utan punkt: "Ladda ner bokföringen för oktober 2026". */
  readonly title: string;
  readonly level: TodoLevel;
}

/**
 * Raderna överst på Att göra som inte kommer ur reglerna: Awish-kontot som går ut, nya
 * automater att koppla och månadens bokföring att ladda ner (månaden som text, "oktober
 * 2026", eller null).
 */
export function extraTodos(input: {
  readonly bokforingMonth: string | null;
  readonly newMachines: number;
  /** Awish-kontot går ut inom 30 dagar (src/server/awish/expiry.ts), annars null. */
  readonly awishExpiry?: { readonly text: string; readonly level: "now" | "soon" } | null;
}): ExtraTodo[] {
  const out: ExtraTodo[] = [];
  if (input.awishExpiry) {
    out.push({
      key: "awish-expiry",
      title: input.awishExpiry.text,
      level: input.awishExpiry.level,
    });
  }
  if (input.newMachines > 0) {
    out.push({
      key: "new-machines",
      title:
        input.newMachines === 1
          ? "Välj butik för den nya automaten"
          : `Välj butik för ${plural(input.newMachines, "ny automat", "nya automater")}`,
      level: "now",
    });
  }
  if (input.bokforingMonth) {
    out.push({
      key: "bokforing",
      title: `Ladda ner bokföringen för ${input.bokforingMonth}`,
      level: "soon",
    });
  }
  return out;
}

/** Det sidan behöver veta om stamdata och lager. */
export interface ModelInput {
  readonly todos: readonly TodoItem[];
  readonly role: Role;
  readonly economy: boolean;
  readonly titles: ReadonlyArray<{ id: string; name: string; mysteryBatchSize?: number | null }>;
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
  /** Fackens kapacitet per automat och titel (Awish). Utelämnad = okänd. */
  readonly capacities?: ReadonlyArray<{
    readonly machineId: string;
    readonly titleId: string;
    readonly capacity: number;
  }>;
  /**
   * Våra lager: saldo per lager och titel, automatens "Fylls på från" och standardlagret.
   * Påfyllningen tar packen därifrån (register_refill). Utelämnad = `warehouse` används.
   */
  readonly sources?: {
    readonly places: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    readonly stock: Readonly<Record<string, Readonly<Record<string, number>>>>;
    readonly machineSource: Readonly<Record<string, string>>;
    readonly defaultPlaceId: string | null;
  } | null;
  /**
   * Automater med platser vars saldo är okänt (bara försäljning, ingen inventering).
   * Påfyllningsregeln hoppar över dem, så sidan får inte påstå att lagret räcker.
   */
  readonly unknownStockMachineIds?: readonly string[];
  readonly scope: { readonly storeId: string | null; readonly machineId: string | null };
  /** Klockslaget punkterna räknades, t.ex. "09:42". */
  readonly computedAt: string;
  /** Avbockade punkter som inte står i listan just nu. */
  readonly dismissed?: readonly DismissedInput[];
  /** Vem som gör punkten (nyckel → användar-id, null = Båda). Saknas = Båda. */
  readonly assignees?: ReadonlyMap<string, string | null>;
  /** Punkter utanför reglerna som sidan visar (räknas i rubriken). */
  readonly extras?: readonly ExtraTodo[];
  /** Dagens affärsdatum: behövs för att säga besökets dag i ord ("senast torsdag"). */
  readonly today?: IsoDate;
  /** Veckans besöksplan (samma som Drift > Besök). Utan den står besöken utan dag. */
  readonly visitPlan?: VisitPlanDays | null;
  /** Butikernas adress och plats (butikens id), för "Öppna i Google Maps". */
  readonly places?: ReadonlyMap<
    string,
    {
      readonly address: string | null;
      readonly city: string | null;
      readonly location: GeoPoint | null;
    }
  >;
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
  "silent-title": ["tyst titel", "tysta titlar"],
  "report-due": ["rapport att skicka", "rapporter att skicka"],
  "report-review": ["utkast att granska", "utkast att granska"],
  contract: ["kontrakt att ordna", "kontrakt att ordna"],
  alert: ["larm", "larm"],
  settlement: ["utbetalning till butik", "utbetalningar till butiker"],
  "settlement-create": ["avräkning att skapa", "avräkningar att skapa"],
  agreement: ["butik utan avtal", "butiker utan avtal"],
  "missing-price": ["titel utan inköpspris", "titlar utan inköpspris"],
  "mystery-cost": ["mystery pack med fel pris", "mystery packs med fel pris"],
  "price-advice": ["prisråd", "prisråd"],
  "duplicate-title": ["möjlig dubblett", "möjliga dubbletter"],
  team: ["delägare att bjuda in", "delägare att bjuda in"],
  "stock-count": ["lager att inventera", "lager att inventera"],
};

const KIND_LABEL: Record<TodoKind, string> = {
  refill: "Påfyllning",
  "stale-machine": "Ingen försäljning",
  "silent-title": "Tyst titel",
  "report-due": "Rapport",
  "report-review": "Rapportutkast",
  contract: "Kontrakt",
  alert: "Larm",
  settlement: "Utbetalning",
  "settlement-create": "Utbetalning",
  agreement: "Avtal",
  "missing-price": "Inköpspris",
  "mystery-cost": "Mystery pack",
  "price-advice": "Prisråd",
  "duplicate-title": "Datakvalitet",
  team: "Delägare",
  "stock-count": "Inventering",
};

const KIND_ORDER: readonly TodoKind[] = [
  "refill",
  "stale-machine",
  "silent-title",
  "alert",
  "report-review",
  "report-due",
  "settlement",
  "settlement-create",
  "agreement",
  "contract",
  "missing-price",
  "mystery-cost",
  "price-advice",
  "duplicate-title",
  "team",
  "stock-count",
];

/**
 * "3 påfyllningar och 1 tyst automat". Med `visits` (antal besök) står påfyllningarna som
 * besök, en per automat: "2 besök och 1 tyst automat".
 */
export function kindSummary(items: readonly { kind: TodoKind }[], visits?: number): string {
  const counts = new Map<TodoKind, number>();
  for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
  return joinSv(
    KIND_ORDER.filter((k) => counts.has(k)).map((k) => {
      if (k === "refill" && visits !== undefined) return plural(visits, "besök", "besök");
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
    case "silent-title": {
      const hours = figureValue(item, "silentHours");
      const onHand = figureValue(item, "onHand");
      if (hours !== null) out.push({ label: "Tyst", value: `${formatInt(hours)}${NBSP}h` });
      if (onHand !== null)
        out.push({ label: "I automaten", value: formatFigure({ value: onHand, unit: "packs" }) });
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
    case "settlement": {
      const total = figureValue(item, "totalOre");
      if (economy && total !== null) out.push({ label: "Att betala", value: kr(total) });
      deadline();
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

/**
 * Måtten som en mening under rubriken (telefonen): "5 pack kvar · räcker 1,8 d · 2 300 kr i
 * risk". Samma tal som primaryFigures, i ord i stället för etikett och värde. Tom utan mått.
 */
export function factLine(item: TodoItem, economy: boolean): string {
  if (item.kind === "refill") {
    const parts: string[] = [];
    const onHand = figureValue(item, "onHand");
    const tenths = figureValue(item, "daysLeftTenths");
    const lostOre = figureValue(item, LOST_REVENUE_FIGURE);
    if (onHand !== null) {
      parts.push(onHand <= 0 ? "slut" : `${formatInt(onHand)}${NBSP}pack kvar`);
      if (onHand > 0 && tenths !== null) parts.push(`räcker ${formatDecimal(tenths / 10)}${NBSP}d`);
    }
    if (economy && item.atStakeOre !== null && item.atStakeOre > 0) {
      parts.push(`${kr(item.atStakeOre)} i risk`);
    }
    if (economy && lostOre !== null && lostOre > 0)
      parts.push(`förlorat ${kr(lostOre)} på 14${NBSP}d`);
    return capitalize(parts.join(" · "));
  }
  return primaryFigures(item, economy)
    .map((f) => (f.label === "I risk 7 d" ? `${f.value} i risk` : `${f.label} ${f.value}`))
    .join(" · ");
}

/** "1 förslag från AI · ca 1 000 kr/mån": raden som fäller ut AI-förslagen under listan. */
export function suggestionsLine(items: readonly { readonly effectSekMonth: number }[]): string {
  const sum = items.reduce((a, s) => a + Math.max(0, s.effectSekMonth), 0);
  return `${plural(items.length, "förslag", "förslag")} från AI${
    sum > 0 ? ` · ca${NBSP}${formatInt(sum)}${NBSP}kr/mån` : ""
  }`;
}

/** Hela underlaget, formaterat. Belopp tas bort för roller som inte ser ekonomi. */
export function evidenceFigures(item: TodoItem, economy: boolean): FigureView[] {
  return item.evidence.figures
    .filter((f) => economy || f.unit !== "ore")
    .map((f) => ({ label: plainWords(f.label), value: formatFigure(f) }));
}

/** Inga facktermer för delägaren: "i facket" heter "i automaten" på sidan. */
export function plainWords(text: string): string {
  return text.replace(/\b([Ii]) facket\b/g, "$1 automaten");
}

// ---------------------------------------------------------------------------
// Åtgärder
// ---------------------------------------------------------------------------

function canOpen(role: Role, id: Parameters<typeof routeById>[0]): boolean {
  return routeById(id).roles.includes(role);
}

/**
 * Lagret en påfyllning i automaten tar packen från och hur många pack av titeln som finns
 * där: automatens "Fylls på från", annars standardlagret (samma val som register_refill).
 * null = inget eget lager.
 */
export function refillHome(
  input: Pick<ModelInput, "sources" | "warehouse">,
  machineId: string,
  titleId: string,
): { readonly onHand: number; readonly name: string | null } | null {
  const src = input.sources;
  if (src) {
    const placeId = src.machineSource[machineId] ?? src.defaultPlaceId;
    if (!placeId) return null;
    return {
      onHand: src.stock[placeId]?.[titleId] ?? 0,
      name: src.places.find((p) => p.id === placeId)?.name ?? null,
    };
  }
  return input.warehouse ? { onHand: input.warehouse.get(titleId) ?? 0, name: null } : null;
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
      const home = refillHome(input, machineId, titleId);
      const capacity =
        input.capacities?.find((c) => c.machineId === machineId && c.titleId === titleId)
          ?.capacity ?? null;
      const batchSize =
        input.titles.find((t) => t.id === titleId)?.mysteryBatchSize ??
        figureValue(item, "batchSize");
      const unitsInWindow = figureValue(item, "unitsInWindow");
      return {
        kind: "register-refill",
        // Ett ord för delägaren: knappen betyder "jag har fyllt på".
        label: "Fyllt på",
        machineId,
        titleId,
        machineName: machine?.name ?? machineId,
        machineCode: machine ? unbreakable(machine.code) : "",
        titleName: input.titles.find((t) => t.id === titleId)?.name ?? titleId,
        onHand,
        capacity,
        batchSize,
        warehouseOnHand: home?.onHand ?? null,
        warehouseName: home?.name ?? null,
        unitsInWindow,
        windowDays: figureValue(item, "windowDays"),
        // Utan eget lager begränsar inget lager förslaget: det som får plats.
        suggested: suggestFill(
          onHand,
          capacity,
          home ? home.onHand : Number.MAX_SAFE_INTEGER,
          unitsInWindow ?? 0,
          batchSize,
        ),
        max: maxFill({ now: Math.max(0, onHand), capacity, batchSize }),
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
    case "open-machine":
      return canOpen(input.role, "drift")
        ? { kind: "link", label: a.label, href: item.link }
        : null;
    case "open-mystery":
      return canOpen(input.role, "mystery")
        ? { kind: "link", label: a.label, href: item.link }
        : null;
    case "open-pricing":
      return canOpen(input.role, "lonsamhet")
        ? { kind: "link", label: a.label, href: item.link }
        : null;
    case "invite-member":
      return canOpen(input.role, "installningar")
        ? { kind: "link", label: a.label, href: item.link }
        : null;
    case "count-stock":
      return canOpen(input.role, "vart-lager")
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
  now: { id: "i-dag", eyebrow: "I dag", title: "I dag." },
  soon: { id: "snart", eyebrow: "Snart", title: "Snart." },
  later: { id: "senare", eyebrow: "Senare", title: "Senare." },
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
    detail: plainWords(item.detail),
    figures: primaryFigures(item, input.economy),
    facts: factLine(item, input.economy),
    rule: item.evidence.rule,
    evidence: evidenceFigures(item, input.economy),
    action: actionFor(item, input),
    link: secondaryLink(item, input.role),
    assignee: input.assignees?.get(item.key) ?? "",
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
const RISK_KINDS: ReadonlySet<TodoKind> = new Set(["refill", "stale-machine", "silent-title"]);

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

function groupAside(items: readonly TodoItem[], economy: boolean, visits: number): string {
  const parts = [capitalize(kindSummary(items, visits))];
  const stake = economy ? stakeOf(items) : 0;
  if (stake > 0) parts.push(`${kr(stake)} i risk`);
  const unpriced = economy ? unpricedOf(items) : 0;
  // "titlar utan inköpspris" står redan i första delen; beloppet säger vad det betyder.
  if (unpriced > 0) parts.push(`${kr(unpriced)} ej i vinsten`);
  return withPeriod(parts.join(" · "));
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

/** Automater inom filtret vars saldo är okänt. */
export function unknownStockInScope(input: ModelInput): number {
  const ids = new Set(input.unknownStockMachineIds ?? []);
  if (ids.size === 0) return 0;
  const { storeId, machineId } = input.scope;
  return input.machines.filter(
    (m) =>
      ids.has(m.id) &&
      (machineId === null || m.id === machineId) &&
      (storeId === null || m.storeId === storeId),
  ).length;
}

function unknownText(n: number): string {
  return `Saldo okänt i ${plural(n, "automat", "automater")}.`;
}

const LEVEL_RANK: Record<TodoLevel, number> = { now: 0, soon: 1, later: 2 };

function entryLevelOf(e: TodoEntry): TodoLevel {
  return e.type === "visit" ? e.visit.level : e.item.level;
}

function headerView(
  visible: readonly TodoItem[],
  entries: readonly TodoEntry[],
  extras: readonly ExtraTodo[],
  hidden: number,
  input: ModelInput,
  unknown: number,
): HeaderView {
  // Ett besök räknas som en sak (som menyns räknare och Hem).
  const count = (l: TodoLevel) =>
    entries.filter((e) => entryLevelOf(e) === l).length +
    extras.filter((e) => e.level === l).length;
  const total = entries.length + extras.length;
  const now = count("now");
  const stake = input.economy ? stakeOf(visible) : 0;
  const unpriced = input.economy ? unpricedOf(visible) : 0;

  let title: string;
  let aside: string;
  const parts: string[] = [];
  if (total === 0 && unknown > 0) {
    // Påfyllningar räknas bara på inräknat saldo: inget "lagret räcker" utan underlag.
    title = unknownText(unknown);
    aside = "Räkna in lagret.";
  } else if (total === 0) {
    title = "Inget att göra.";
    aside = "Allt ser bra ut.";
  } else {
    const onlyVisits = extras.length === 0 && entries.every((e) => e.type === "visit");
    title = onlyVisits
      ? `${plural(total, "besök", "besök")} att göra.`
      : `${plural(total, "sak", "saker")} att göra.`;
    aside = now > 0 ? `${formatInt(now)} i dag.` : "Inget i dag.";
    // Den mest brådskande: listans första rad, eller en extra punkt om den är brådskare.
    const first = entries[0] ?? null;
    const extra = extras[0] ?? null;
    if (first && (!extra || LEVEL_RANK[entryLevelOf(first)] <= LEVEL_RANK[extra.level])) {
      parts.push(
        first.type === "visit"
          ? `Först: ${visitHeading(first.visit, input)}.`
          : leadText(first.item),
      );
    } else if (extra) {
      parts.push(`Först: ${stripPeriod(extra.title)}.`);
    }
  }
  if (total > 0 && unknown > 0) parts.push(unknownText(unknown));
  if (hidden > 0) parts.push(hiddenText(hidden, input.scope));

  const meta: { label: string; value: string }[] = [];
  for (const level of LEVELS) {
    const n = count(level);
    if (n > 0) meta.push({ label: LEVEL_TEXT[level], value: formatInt(n) });
  }
  if (input.economy && stake > 0) meta.push({ label: "I risk 7 d", value: kr(stake) });
  // Intäkt utan inköpspris är inte i risk (bara vinsten blir ofullständig): eget mått.
  if (unpriced > 0) meta.push({ label: "Utan inköpspris", value: kr(unpriced) });
  if (unknown > 0) meta.push({ label: "Saldo okänt", value: formatInt(unknown) });
  meta.push({ label: "Beräknat", value: input.computedAt });
  return { title, aside, description: parts.join(" "), meta };
}

/**
 * Nyckelns automat ('refill:<automat>:<titel>', 'stale-machine:<automat>',
 * 'silent-title:<automat>:<titel>'), annars null.
 */
function machineOfKey(key: string): string | null {
  const [kind, id] = key.split(":");
  return (kind === "refill" || kind === "stale-machine" || kind === "silent-title") && id
    ? id
    : null;
}

const KIND_BY_PREFIX: Record<string, TodoKind> = {
  refill: "refill",
  "stale-machine": "stale-machine",
  "silent-title": "silent-title",
  "report-due": "report-due",
  "report-review": "report-review",
  contract: "contract",
  alert: "alert",
  settlement: "settlement",
  "settlement-create": "settlement-create",
  agreement: "agreement",
  "missing-price": "missing-price",
  "mystery-cost": "mystery-cost",
  "price-advice": "price-advice",
  "duplicate-title": "duplicate-title",
  team: "team",
  "stock-count": "stock-count",
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
        meta: `Klar ${d.when}${d.by ? ` av ${d.by}` : ""}.`,
      };
    });
}

/** Automatens kod (BL-003, obrytbar), annars namnet. */
function machineLabel(machineId: string, input: Pick<ModelInput, "machines">): string {
  const m = input.machines.find((x) => x.id === machineId);
  return m ? (m.code ? unbreakable(m.code) : m.name) : "automaten";
}

/** "Åk till BL-003 senast torsdag" (utan punkt). Utan dagens datum: utan dag ur planen. */
function visitHeading(visit: TodoVisit, input: ModelInput): string {
  const label = machineLabel(visit.machineId, input);
  return input.today
    ? visitTitle(visit, label, input.today)
    : visitTitle({ needBy: null, level: visit.level }, label, "1970-01-01");
}

/** "4 titlar · 38 pack · 2 300 kr i risk". Pack = besöksplanens packlista för automaten. */
export function visitFacts(
  visit: Pick<TodoVisit, "items" | "packs" | "atStakeOre">,
  economy: boolean,
): string {
  const parts = [plural(visit.items.length, "titel", "titlar")];
  if (visit.packs !== null && visit.packs > 0) parts.push(`${formatInt(visit.packs)}${NBSP}pack`);
  if (economy && visit.atStakeOre > 0) parts.push(`${kr(visit.atStakeOre)} i risk`);
  return parts.join(" · ");
}

/** Vägbeskrivning till automatens butik, eller null utan adress och plats. */
function mapsHrefFor(machineId: string, input: ModelInput): string | null {
  const machine = input.machines.find((m) => m.id === machineId);
  const place = machine?.storeId ? input.places?.get(machine.storeId) : undefined;
  if (!machine || !place) return null;
  return (
    googleMapsUrls([
      {
        machineId,
        label: machine.name,
        storeId: machine.storeId,
        storeName: null,
        address: place.address,
        city: place.city,
        location: place.location,
        packs: 0,
      },
    ])[0] ?? null
  );
}

function visitView(visit: TodoVisit, items: TodoView[], input: ModelInput): VisitView {
  const signal = items.some((t) => t.status === "critical");
  return {
    key: visit.key,
    level: visit.level,
    status:
      visit.level === "now"
        ? signal
          ? "critical"
          : "warning"
        : visit.level === "soon"
          ? "warning"
          : "neutral",
    statusText: LEVEL_TEXT[visit.level],
    title: `${visitHeading(visit, input)}.`,
    facts: visitFacts(visit, input.economy),
    machineId: visit.machineId,
    items,
    mapsHref: mapsHrefFor(visit.machineId, input),
    fillHref: `/fyll-pa/${visit.machineId}`,
    bringHref: "/fyll-pa",
  };
}

/**
 * Hela sidan. Punkterna är redan sorterade efter brådska (computeTodos). Påfyllningarna för
 * en automat slås ihop till ett besök (groupVisits): raden står i sin mest brådskande punkts
 * grupp och innehåller automatens alla titlar.
 */
export function buildPage(input: ModelInput): PageView {
  const visible = input.todos.filter((t) => inScope(t, input));
  const hidden = input.todos.length - visible.length;
  const entries = groupVisits(
    visible,
    input.today ? (input.visitPlan ?? null) : null,
    input.today ?? null,
  );
  let signals = 0;
  const groups: GroupView[] = [];
  for (const level of LEVELS) {
    const levelEntries = entries.filter((e) => entryLevelOf(e) === level);
    if (levelEntries.length === 0) continue;
    const meta = GROUP_META[level];
    const view = (t: TodoItem) => {
      const signal = t.level === "now" && signals < SIGNAL_BUDGET;
      if (signal) signals += 1;
      return toView(t, input, signal);
    };
    const rows: RowView[] = levelEntries.map((e) =>
      e.type === "visit"
        ? { type: "visit", visit: visitView(e.visit, e.visit.items.map(view), input) }
        : { type: "todo", item: view(e.item) },
    );
    const items = levelEntries.flatMap((e) => (e.type === "visit" ? e.visit.items : [e.item]));
    groups.push({
      level,
      id: meta.id,
      index: groups.length + 1,
      eyebrow: meta.eyebrow,
      title: meta.title,
      aside: groupAside(
        items,
        input.economy,
        levelEntries.filter((e) => e.type === "visit").length,
      ),
      rows,
      items: rows.flatMap((r) => (r.type === "visit" ? r.visit.items : [r.item])),
    });
  }
  // Raderna är sorterade efter brådska: den första är den mest brådskande.
  const extras = input.extras ?? [];
  const unknown = unknownStockInScope(input);
  return {
    header: headerView(visible, entries, extras, hidden, input, unknown),
    groups,
    total: entries.length + extras.length,
    hiddenByScope: hidden,
    economy: input.economy,
    unknownStock: unknown,
    dismissed: dismissedViews(input),
  };
}
