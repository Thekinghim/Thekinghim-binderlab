/**
 * Dagens brief: korten i rutan som öppnas första gången appen öppnas varje dag
 * (src/app/(app)/_hem/brief). Ren funktion: underlaget kommer ur Hems laddare (Kräver åtgärd,
 * Dagens rutt), Att göra (avräkningar, inköpspriser, larm) och försäljningen i går.
 *
 * Ordning, viktigast först:
 *   larm (automater offline, öppna larm) → påfyllning → dagens rutt → betala butikerna
 *   (först om sista dagen är i dag eller passerad) → priser med förlust → inköpspris saknas
 *   → i går. Högst MAX_BRIEF_CARDS kort. Inget att göra: ett kort "Allt är klart i dag".
 *
 * Roller (servern skickar bara det rollen får se; funktionen filtrerar en gång till):
 *   ägare, admin  allt, med knappar som gör något (Fyll på, Betala, Lägg in pris …)
 *   läsare        allt, men knappen bara visar (Visa) och leder aldrig till en ändring
 *   påfyllare     bara påfyllning och dagens rutt, och aldrig kronor
 */

import { daysBetween, type IsoDate } from "@/domain";
import { formatInt, NBSP } from "@/lib/format";

export const MAX_BRIEF_CARDS = 6;

export type BriefRole = "owner" | "admin" | "viewer" | "refiller";

export type BriefArt = "alert" | "refill" | "route" | "money" | "price" | "chart" | "done";

export type BriefCardKind =
  | "alert"
  | "refill"
  | "route"
  | "settlement"
  | "loss-price"
  | "missing-price"
  | "yesterday"
  | "done";

export type BriefTone = "crit" | "warn" | "info" | "profit";

export interface BriefCard {
  readonly key: BriefCardKind;
  readonly art: BriefArt;
  readonly tone: BriefTone;
  /** Fet rubrik med nyckeltalet ("3 automater behöver fyllas på"). */
  readonly title: string;
  /** En kort grå rad ("Lerum är nästan tom · ta med 24 pack"). */
  readonly line: string;
  /** Knappen till höger; saknas på "Allt är klart". */
  readonly action: { readonly label: string; readonly href: string } | null;
}

export interface BriefMachine {
  readonly id: string;
  readonly name: string;
  readonly kind: "tom" | "fyll-pa" | "offline" | "startklar";
  readonly packs: number | null;
  /** Bara ekonomiroller: förlorad vinst per dag (öre). */
  readonly lossOre?: number;
}

export interface BriefInput {
  readonly role: BriefRole;
  readonly today: IsoDate;
  /** Kräver åtgärd i Hems ordning (störst förlust eller brådska först). */
  readonly machines: readonly BriefMachine[];
  readonly route: {
    readonly stops: number;
    readonly done: number;
    readonly cities: readonly string[];
    readonly totalPacks: number;
    readonly km: number | null;
  } | null;
  /** Öppna larm som inte gäller en automat som redan är offline. */
  readonly alerts?: readonly { readonly title: string; readonly href: string }[];
  /** Obetalda avräkningar (en per månad). */
  readonly settlements?: readonly {
    readonly count: number;
    readonly totalOre: number;
    readonly due: IsoDate | null;
    readonly href: string;
  }[];
  readonly lossPrices?: readonly {
    readonly name: string;
    readonly lossOre: number | null;
    readonly suggestedPriceOre: number | null;
  }[];
  readonly missingPrices?: readonly { readonly name: string; readonly href: string }[];
  readonly yesterday?: {
    readonly units: number;
    readonly revenueOre: number;
    /** Snitt per dag de senaste veckorna (öre), null utan underlag. */
    readonly normalRevenueOre: number | null;
  } | null;
}

const MONTHS = [
  "jan",
  "feb",
  "mars",
  "apr",
  "maj",
  "juni",
  "juli",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
];

/** "15 dec" ur "2026-12-15". */
export function shortDate(d: IsoDate): string {
  const [, m, day] = d.split("-").map(Number);
  return `${day ?? ""}${NBSP}${MONTHS[(m ?? 1) - 1] ?? ""}`;
}

/** Hela kronor ur öre: "12 400 kr". */
export function kr(ore: number): string {
  return `${formatInt(Math.round(ore / 100))}${NBSP}kr`;
}

function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)} ${n === 1 ? one : many}`;
}

export function isEconomyRole(role: BriefRole): boolean {
  return role !== "refiller";
}

function canAct(role: BriefRole): boolean {
  return role === "owner" || role === "admin";
}

/** Rollen ser kort av den här sorten. */
export function roleSees(role: BriefRole, kind: BriefCardKind): boolean {
  if (kind === "done") return true;
  if (role === "refiller") return kind === "refill" || kind === "route";
  return true;
}

/** Tar bort allt som ser ut som kronor (sista spärren för påfyllaren). */
function noKronor(text: string): string {
  return text
    .replace(/[−+-]?\s?[\d   .,]*\d\s?(?:kr|kronor)\b(?:\/dag)?/gi, "")
    .replace(/\s*·\s*$/g, "")
    .replace(/^\s*·\s*/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

interface Ranked {
  readonly card: BriefCard;
  readonly rank: number;
}

function alertCard(input: BriefInput, view: boolean): Ranked | null {
  const offline = input.machines.filter((m) => m.kind === "offline");
  const alerts = input.alerts ?? [];
  if (offline.length === 0 && alerts.length === 0) return null;
  const first = offline[0];
  if (first) {
    const more = alerts.length > 0 ? ` · ${plural(alerts.length, "larm", "larm")} till` : "";
    return {
      rank: 0,
      card: {
        key: "alert",
        art: "alert",
        tone: "crit",
        title:
          offline.length === 1
            ? "1 automat är offline"
            : `${formatInt(offline.length)} automater är offline`,
        line: `${first.name} svarar inte${more}`,
        action: {
          label: view ? "Visa" : "Se larm",
          href: "/automater?f=offline",
        },
      },
    };
  }
  const a = alerts[0]!;
  return {
    rank: 0,
    card: {
      key: "alert",
      art: "alert",
      tone: "crit",
      title:
        alerts.length === 1
          ? "1 larm att titta på"
          : `${formatInt(alerts.length)} larm att titta på`,
      line: a.title,
      action: {
        label: view ? "Visa" : "Se larm",
        href: alerts.length === 1 ? a.href : "/drift#larm",
      },
    },
  };
}

function refillCard(input: BriefInput, economy: boolean, view: boolean): Ranked | null {
  const rows = input.machines.filter((m) => m.kind === "tom" || m.kind === "fyll-pa");
  const first = rows[0];
  if (!first) return null;
  const state = first.kind === "tom" ? "är tom" : "är nästan tom";
  const packs = first.packs && first.packs > 0 ? ` · ta med ${formatInt(first.packs)} pack` : "";
  const loss = economy
    ? rows.reduce((s, m) => s + (m.lossOre !== undefined && m.lossOre > 0 ? m.lossOre : 0), 0)
    : 0;
  const lossText = economy && loss >= 500 && !packs ? ` · tappar ${kr(loss)}/dag` : "";
  return {
    rank: 1,
    card: {
      key: "refill",
      art: "refill",
      tone: first.kind === "tom" ? "crit" : "warn",
      title:
        rows.length === 1
          ? "1 automat behöver fyllas på"
          : `${formatInt(rows.length)} automater behöver fyllas på`,
      line: `${first.name} ${state}${packs}${lossText}`,
      action: view
        ? { label: "Visa", href: "/automater?f=behover" }
        : { label: "Fyll på", href: `/fyll-pa/${encodeURIComponent(first.id)}?fran=hem` },
    },
  };
}

function routeCard(input: BriefInput): Ranked | null {
  const r = input.route;
  if (!r || r.stops === 0) return null;
  const left = r.stops - r.done;
  if (left <= 0) return null;
  const parts = [
    r.cities.slice(0, 2).join(", "),
    r.totalPacks > 0 ? `${formatInt(r.totalPacks)} pack` : "",
    r.km !== null && r.km > 0 ? `${formatInt(Math.round(r.km))} km` : "",
  ].filter(Boolean);
  return {
    rank: 2,
    card: {
      key: "route",
      art: "route",
      tone: "info",
      title:
        r.done > 0
          ? `${plural(left, "stopp", "stopp")} kvar på rutten`
          : `Dagens rutt: ${plural(r.stops, "stopp", "stopp")}`,
      line: parts.join(" · ") || "Packa och kör",
      action: { label: "Öppna rutt", href: "/rutt" },
    },
  };
}

function settlementCard(input: BriefInput, view: boolean): Ranked | null {
  const list = (input.settlements ?? []).filter((s) => s.count > 0 && s.totalOre > 0);
  if (list.length === 0) return null;
  const total = list.reduce((s, x) => s + x.totalOre, 0);
  const count = list.reduce((s, x) => s + x.count, 0);
  const dues = list
    .map((s) => s.due)
    .filter((d): d is IsoDate => d !== null)
    .sort();
  const due = dues[0] ?? null;
  const left = due ? daysBetween(input.today, due) : null;
  const when =
    left === null
      ? ""
      : left < 0
        ? ` · skulle betalats ${shortDate(due!)}`
        : left === 0
          ? " · senast i dag"
          : ` · senast ${shortDate(due!)}`;
  return {
    // Bråttom (i dag eller passerat): direkt efter larmen.
    rank: left !== null && left <= 0 ? 0.5 : 3,
    card: {
      key: "settlement",
      art: "money",
      tone: left !== null && left < 0 ? "crit" : "profit",
      title: `Betala butikerna ${kr(total)}`,
      line: `${plural(count, "butik", "butiker")}${when}`,
      action: {
        label: view ? "Visa" : "Betala",
        href: list.length === 1 ? list[0]!.href : "/butiker?vy=utbetalning",
      },
    },
  };
}

function lossPriceCard(input: BriefInput, view: boolean): Ranked | null {
  const list = input.lossPrices ?? [];
  const first = list[0];
  if (!first) return null;
  const hint =
    first.suggestedPriceOre !== null && first.suggestedPriceOre > 0
      ? ` · höj till ${kr(first.suggestedPriceOre)}`
      : "";
  return {
    rank: 4,
    card: {
      key: "loss-price",
      art: "price",
      tone: "crit",
      title:
        list.length === 1
          ? "1 pris går med förlust"
          : `${formatInt(list.length)} priser går med förlust`,
      line: `${first.name}${hint}`,
      action: { label: view ? "Visa" : "Ändra pris", href: "/lonsamhet#prisrad" },
    },
  };
}

function missingPriceCard(input: BriefInput, view: boolean): Ranked | null {
  const list = input.missingPrices ?? [];
  const first = list[0];
  if (!first) return null;
  return {
    rank: 5,
    card: {
      key: "missing-price",
      art: "price",
      tone: "warn",
      title:
        list.length === 1
          ? "1 titel saknar inköpspris"
          : `${formatInt(list.length)} titlar saknar inköpspris`,
      line: `${first.name} räknas inte i vinsten`,
      action: {
        label: view ? "Visa" : "Lägg in pris",
        href: list.length === 1 ? first.href : "/inkopspriser",
      },
    },
  };
}

function yesterdayCard(input: BriefInput): Ranked | null {
  const y = input.yesterday;
  if (!y) return null;
  const n = y.normalRevenueOre;
  const ratio = n !== null && n > 0 ? y.revenueOre / n : null;
  const vs =
    ratio === null
      ? ""
      : ratio >= 1.15
        ? " · bättre än vanligt"
        : ratio <= 0.85
          ? " · lugnare än vanligt"
          : " · som vanligt";
  return {
    rank: 9,
    card: {
      key: "yesterday",
      art: "chart",
      tone: "profit",
      title: y.units === 0 ? "I går: inget sålt" : `I går: ${kr(y.revenueOre)}`,
      line: `${plural(y.units, "pack", "pack")} sålda${vs}`,
      action: { label: "Se mer", href: "/pengar?period=igar" },
    },
  };
}

const DONE: BriefCard = {
  key: "done",
  art: "done",
  tone: "profit",
  title: "Allt är klart i dag",
  line: "Inget behöver göras just nu",
  action: null,
};

/** Korten i Dagens brief för rollen, viktigast först (högst MAX_BRIEF_CARDS). */
export function buildBriefCards(input: BriefInput): BriefCard[] {
  const role = input.role;
  const economy = isEconomyRole(role);
  const view = !canAct(role) && role !== "refiller";
  const ranked = [
    alertCard(input, view),
    refillCard(input, economy, view),
    routeCard(input),
    settlementCard(input, view),
    lossPriceCard(input, view),
    missingPriceCard(input, view),
    economy ? yesterdayCard(input) : null,
  ]
    .filter((r): r is Ranked => r !== null && roleSees(role, r.card.key))
    .sort((a, b) => a.rank - b.rank)
    .map((r) => r.card);

  const todo = ranked.filter((c) => c.key !== "yesterday");
  const cards = todo.length === 0 ? [DONE, ...ranked] : ranked;
  const out = cards.slice(0, MAX_BRIEF_CARDS);
  if (economy) return out;
  return out.map((c) => ({ ...c, title: noKronor(c.title), line: noKronor(c.line) }));
}
