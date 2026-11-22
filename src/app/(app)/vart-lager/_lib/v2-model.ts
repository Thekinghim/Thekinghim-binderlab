/**
 * Vårt lager i V2 (byggplanen 2.6): det som den nya sidan visar utöver Vårt lagers vymodell
 * (./model.ts, som räknar antal, Räcker, Packa/Beställ och värde). Ren och klientsäker.
 *
 * - Filter: Alla, Lågt (räcker kortare än WAREHOUSE_LOW_DAYS men något finns hemma) och Slut
 *   (inget hemma och titeln behövs: står i automaterna eller ska köpas). Utgångna titlar
 *   räknas inte som lågt eller slut.
 * - Köpa: titlarna där inköpsplanen säger Beställ eller Packa (samma antal som /prognos),
 *   brådskande först (Räcker, sedan namn), med ledtiden och leverantören ur planen.
 * - Lagervärde: hemma = modellens värde (dagens inköpspris); i automaterna = Σ pack i
 *   automaterna × samma pris, bara titlar med pris.
 * - Senaste händelser: lagrets händelser (inte försäljning) ihopslagna så att en påfyllning
 *   (många titlar på en gång), en inventering och ett produktbyte blir en rad var.
 */

import { formatInt, MINUS } from "@/lib/format";

import type { VartLagerRow } from "./model";

export type StockFilter = "alla" | "lagt" | "slut";

export function isOut(r: VartLagerRow): boolean {
  return !r.retired && r.home <= 0 && (r.inMachines > 0 || (r.needQty ?? 0) > 0);
}

export function isLow(r: VartLagerRow): boolean {
  return !r.retired && r.home > 0 && r.runsOut;
}

export function filterRows(rows: readonly VartLagerRow[], f: StockFilter): VartLagerRow[] {
  if (f === "slut") return rows.filter(isOut);
  if (f === "lagt") return rows.filter(isLow);
  return [...rows];
}

export type StockSort = "rakcer" | "hemma" | "ute" | "totalt" | "titel";

/** Sortering i tabellen. Räcker: kortast först, okänd sist. */
export function sortRows(rows: readonly VartLagerRow[], by: StockSort): VartLagerRow[] {
  const days = (d: number | null) => (d === null ? Number.POSITIVE_INFINITY : d);
  const name = (a: VartLagerRow, b: VartLagerRow) => a.name.localeCompare(b.name, "sv");
  const list = [...rows];
  switch (by) {
    case "hemma":
      return list.sort((a, b) => b.home - a.home || name(a, b));
    case "ute":
      return list.sort((a, b) => b.inMachines - a.inMachines || name(a, b));
    case "totalt":
      return list.sort((a, b) => days(a.lastsDays) - days(b.lastsDays) || name(a, b));
    case "titel":
      return list.sort(name);
    default:
      return list.sort(
        (a, b) =>
          Number(a.retired) - Number(b.retired) ||
          days(a.daysLeft) - days(b.daysLeft) ||
          days(a.lastsDays) - days(b.lastsDays) ||
          name(a, b),
      );
  }
}

export interface BuyInfo {
  readonly leadTimeDays: number;
  readonly supplierName: string | null;
}

export interface BuyLine {
  readonly titleId: string;
  readonly name: string;
  readonly kind: "pack" | "order";
  /** "Beställ 400 Pokémon 151" · "Packa 2 omgångar Mystery Pack". */
  readonly text: string;
  readonly daysLeft: number | null;
  readonly leadTimeDays: number | null;
  /** Räcker − leverans (negativt = slut innan leveransen). */
  readonly gapDays: number | null;
  readonly supplierName: string | null;
  readonly own: boolean;
}

export function buyLines(
  rows: readonly VartLagerRow[],
  info: ReadonlyMap<string, BuyInfo>,
): BuyLine[] {
  return rows
    .filter((r) => r.action !== null && !r.retired)
    .map((r) => {
      const a = r.action!;
      const i = info.get(r.titleId) ?? null;
      const days = r.lastsDays;
      const lead = a.kind === "order" ? (i?.leadTimeDays ?? null) : null;
      const verb = a.kind === "pack" ? "Packa" : "Beställ";
      const qty =
        a.qty === null ? "" : ` ${formatInt(a.qty)}${a.unit === "st" ? "" : ` ${a.unit}`}`;
      return {
        titleId: r.titleId,
        name: r.name,
        kind: a.kind,
        text: `${verb}${qty} ${r.name}`,
        daysLeft: days,
        leadTimeDays: lead,
        gapDays: days !== null && lead !== null ? days - lead : null,
        supplierName: a.kind === "order" ? (i?.supplierName ?? null) : null,
        own: r.own,
      };
    })
    .sort(
      (a, b) =>
        Number(a.kind === "pack") - Number(b.kind === "pack") ||
        (a.gapDays ?? a.daysLeft ?? 9999) - (b.gapDays ?? b.daysLeft ?? 9999) ||
        a.name.localeCompare(b.name, "sv"),
    );
}

/** "−7 d" / "+3 d" / "0 d". */
export function gapText(days: number): string {
  if (days === 0) return "0 d";
  return days < 0 ? `${MINUS}${formatInt(-days)} d` : `+${formatInt(days)} d`;
}

/** Värde i automaterna: Σ pack × dagens inköpspris (titlar med pris). Öre. */
export function machineValueOre(rows: readonly VartLagerRow[]): number {
  return rows.reduce(
    (s, r) => s + (r.unitCostOre !== null ? Math.max(0, r.inMachines) * r.unitCostOre : 0),
    0,
  );
}

/** En händelse i ett eget lager (inte försäljning). */
export interface StockEventRow {
  readonly kind: string;
  readonly quantity: number;
  readonly occurredAt: string;
  readonly note: string | null;
  readonly titleName: string;
  readonly placeName: string;
  /** Flytt: det andra lagrets namn. */
  readonly counterpart: string | null;
}

export interface RecentEvent {
  readonly key: string;
  /** "Fyll på Kortkammaren" · "Räknat Hemma" · "Inköp Surging Sparks". */
  readonly title: string;
  /** "−28 pack" · "12 titlar" · "+120 pack · Hemma". */
  readonly detail: string;
  readonly occurredAt: string;
}

const REFILL = [/^Awish-påfyllning\s+/, /^Uttag till påfyllning(?: av)?:?\s*/];

function signedPacks(n: number): string {
  return n < 0 ? `${MINUS}${formatInt(-n)} pack` : `+${formatInt(n)} pack`;
}

/**
 * Lagrets senaste händelser, ihopslagna: påfyllningar per notering och dag, inventeringar per
 * lager och dag, och allt annat per titel. Nyast först, högst `limit`. `placeOf` ger butikens
 * namn för en automatkod ("NA-03" → "Kortkammaren").
 */
export function recentEvents(
  events: readonly StockEventRow[],
  placeOf: (code: string) => string | null,
  limit = 6,
): RecentEvent[] {
  const groups = new Map<
    string,
    { title: string; packs: number; titles: Set<string>; at: string; kind: string; place: string }
  >();
  for (const e of events) {
    const day = e.occurredAt.slice(0, 10);
    const note = e.note ?? "";
    let key: string;
    let title: string;
    let kind = e.kind;
    const refill = REFILL.find((re) => re.test(note));
    if (e.kind === "adjustment" && refill) {
      const codes = note
        .replace(refill, "")
        .split(/[,\s]+/)
        .filter((c) => /^[A-Z]{1,4}-\d+$/i.test(c));
      const names = [...new Set(codes.map((c) => placeOf(c) ?? c))];
      key = `refill:${day}:${names.join(",")}`;
      title = `Fyll på ${names.length > 0 ? names.join(", ") : "automater"}`;
      kind = "refill";
    } else if (note.startsWith("Produktbyte")) {
      key = `swap:${e.occurredAt}:${note}`;
      title = note.replace(/^Produktbyte/, "Produktbyte");
      kind = "swap";
    } else if (e.kind === "count") {
      key = `count:${day}:${e.placeName}`;
      title = `Räknat ${e.placeName}`;
    } else if (e.kind === "receipt") {
      key = `receipt:${day}:${e.titleName}`;
      title = `Inköp ${e.titleName}`;
    } else if (e.kind === "transfer_in" || e.kind === "transfer_out") {
      if (e.kind === "transfer_in") continue; // flytten syns en gång (ut)
      key = `move:${e.occurredAt}:${e.titleName}`;
      title = `Flytt ${e.titleName}${e.counterpart ? ` till ${e.counterpart}` : ""}`;
    } else if (note.startsWith("Packat ")) {
      key = `pack:${day}:${e.titleName}`;
      title = `Packat ${e.titleName}`;
      kind = "pack";
    } else {
      key = `other:${e.occurredAt}:${e.titleName}:${e.kind}`;
      title = `${e.kind === "waste" ? "Svinn" : "Ändrat"} ${e.titleName}`;
    }
    const g = groups.get(key);
    if (g) {
      g.packs += e.quantity;
      g.titles.add(e.titleName);
      if (e.occurredAt > g.at) g.at = e.occurredAt;
    } else {
      groups.set(key, {
        title,
        packs: e.quantity,
        titles: new Set([e.titleName]),
        at: e.occurredAt,
        kind,
        place: e.placeName,
      });
    }
  }
  return [...groups.entries()]
    .sort((a, b) => (a[1].at < b[1].at ? 1 : a[1].at > b[1].at ? -1 : 0))
    .slice(0, limit)
    .map(([key, g]) => ({
      key,
      title: g.title,
      detail:
        g.kind === "count"
          ? g.titles.size === 1
            ? "1 titel"
            : `${formatInt(g.titles.size)} titlar`
          : g.kind === "receipt"
            ? `${signedPacks(g.packs)} · ${g.place}`
            : signedPacks(g.packs),
      occurredAt: g.at,
    }));
}
