/**
 * "Vad sålde vi i går?": det som såldes under en period (oftast en dag) per titel och per
 * automat, och per timme när perioden är en dag. Rena funktioner i öre.
 *
 * Ekonomiroller (salesFromLedger): ur liggaren (buildLedger, samma som Lönsamhet och Pengar).
 *   antal  = order (pack), med och utan inköpspris
 *   intäkt = intäkt exkl. moms för alla order (netRevenueOre), så att listan visar allt som
 *            såldes; order utan inköpspris har ingen vinst (null när ingen order på raden har
 *            pris), samma regel som Lönsamhet
 *   vinst  = intäkt − inköp − kortavgift − VMB-moms för order med inköpspris, och när
 *            butikernas andel dras (Settings.deductStoreShare) även provision och hyra som
 *            fördelats på ordern. Summan stämmer med Lönsamhets totalsumma utom ej fördelad hyra
 *            och vinstdelning, som inte hör till en enskild order (de syns på Pengar).
 *
 * Påfyllaren (salesFromCounts): bara antal ur lagret (loadSalesCounts), aldrig kronor:
 * fälten för belopp är null och sätts aldrig.
 */

import { localParts, tryParseInstant } from "@/analytics/todos/time";
import {
  buildLedger,
  entryProfitOre,
  storeShareDeducted,
  type IsoDate,
  type ProfitabilityInput,
} from "@/domain";

export interface DaySalesRow {
  /** titleId eller machineId ("" för order utan kopplad automat). */
  readonly id: string;
  readonly name: string;
  /** Automatens kod (bara automater). */
  readonly code?: string;
  readonly units: number;
  /** Intäkt exkl. moms (öre). null för påfyllaren. */
  readonly revenueOre: number | null;
  /** Vinst (öre). null för påfyllaren och när ingen order på raden har inköpspris. */
  readonly profitOre: number | null;
}

export interface DaySalesHour {
  /** 0–23 i organisationens tidszon. */
  readonly hour: number;
  readonly units: number;
  readonly revenueOre: number;
}

export interface DaySales {
  readonly units: number;
  readonly revenueOre: number | null;
  readonly profitOre: number | null;
  /** Störst först (antal, sedan intäkt, sedan namn). */
  readonly titles: readonly DaySalesRow[];
  readonly machines: readonly DaySalesRow[];
  /** 24 timmar när perioden är en dag och ordrarnas tid är känd, annars tom. */
  readonly hours: readonly DaySalesHour[];
  /** Sant när beloppen visas (ekonomiroll). */
  readonly economy: boolean;
}

export interface Names {
  title(id: string): string;
  machine(id: string): { name: string; code?: string };
}

type Acc = { units: number; revenueOre: number; profitOre: number; priced: number };

function byBiggest(a: DaySalesRow, b: DaySalesRow): number {
  return (
    b.units - a.units ||
    (b.revenueOre ?? 0) - (a.revenueOre ?? 0) ||
    a.name.localeCompare(b.name, "sv")
  );
}

/** Timmen (0–23) då en order betalades, räknat mot dess affärsdag; null utan tid. */
export function orderHour(
  order: { readonly businessDate: IsoDate; readonly orderedAt?: string | null },
  timeZone: string,
): number | null {
  if (!order.orderedAt) return null;
  const ms = tryParseInstant(order.orderedAt);
  if (ms === null) return null;
  const p = localParts(ms, timeZone);
  // Betaltid på en annan dag än affärsdagen: dagens första respektive sista timme.
  if (p.date < order.businessDate) return 0;
  if (p.date > order.businessDate) return 23;
  const h = Number(p.time.slice(0, 2));
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : null;
}

/** Ekonomiroller: antal, intäkt och vinst per titel, automat och timme ur liggaren. */
export function salesFromLedger(
  input: ProfitabilityInput,
  names: Names,
  timeZone: string,
): DaySales {
  const ledger = buildLedger(input);
  const deduct = storeShareDeducted(input.settings);
  const titles = new Map<string, Acc>();
  const machines = new Map<string, Acc>();
  const singleDay = input.period.start === input.period.end;
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, units: 0, revenueOre: 0 }));
  let anyHour = false;
  const total: Acc = { units: 0, revenueOre: 0, profitOre: 0, priced: 0 };
  const add = (map: Map<string, Acc>, key: string, revenue: number, profit: number | null) => {
    const a = map.get(key) ?? { units: 0, revenueOre: 0, profitOre: 0, priced: 0 };
    a.units += 1;
    a.revenueOre += revenue;
    if (profit !== null) {
      a.profitOre += profit;
      a.priced += 1;
    }
    map.set(key, a);
  };
  for (const e of ledger.entries) {
    const revenue = e.netRevenueOre;
    const profit = e.priced ? entryProfitOre(e, deduct) : null;
    add(titles, e.order.titleId, revenue, profit);
    add(machines, e.order.machineId ?? "", revenue, profit);
    total.units += 1;
    total.revenueOre += revenue;
    if (profit !== null) {
      total.profitOre += profit;
      total.priced += 1;
    }
    if (singleDay) {
      const h = orderHour(e.order as { businessDate: IsoDate; orderedAt?: string }, timeZone);
      if (h !== null) {
        const slot = hours[h]!;
        slot.units += 1;
        slot.revenueOre += revenue;
        anyHour = true;
      }
    }
  }
  const rows = (map: Map<string, Acc>, kind: "title" | "machine"): DaySalesRow[] =>
    [...map.entries()]
      .map(([id, a]) => {
        const label =
          kind === "title"
            ? { name: names.title(id) }
            : id === ""
              ? { name: "Okänd automat" }
              : names.machine(id);
        return {
          id,
          ...label,
          units: a.units,
          revenueOre: a.revenueOre,
          profitOre: a.priced > 0 ? a.profitOre : null,
        };
      })
      .sort(byBiggest);
  return {
    units: total.units,
    revenueOre: total.revenueOre,
    profitOre: total.priced > 0 ? total.profitOre : null,
    titles: rows(titles, "title"),
    machines: rows(machines, "machine"),
    hours: anyHour ? hours : [],
    economy: true,
  };
}

/** Påfyllaren: bara antal per titel och automat (ur lagrets försäljning). Inga kronor. */
export function salesFromCounts(
  rows: readonly {
    readonly titleId: string;
    readonly machineId: string | null;
    readonly units: number;
  }[],
  names: Names,
): DaySales {
  const titles = new Map<string, number>();
  const machines = new Map<string, number>();
  let units = 0;
  for (const r of rows) {
    if (r.units <= 0) continue;
    titles.set(r.titleId, (titles.get(r.titleId) ?? 0) + r.units);
    const m = r.machineId ?? "";
    machines.set(m, (machines.get(m) ?? 0) + r.units);
    units += r.units;
  }
  const list = (map: Map<string, number>, kind: "title" | "machine"): DaySalesRow[] =>
    [...map.entries()]
      .map(([id, n]) => ({
        id,
        ...(kind === "title"
          ? { name: names.title(id) }
          : id === ""
            ? { name: "Okänd automat" }
            : names.machine(id)),
        units: n,
        revenueOre: null,
        profitOre: null,
      }))
      .sort(byBiggest);
  return {
    units,
    revenueOre: null,
    profitOre: null,
    titles: list(titles, "title"),
    machines: list(machines, "machine"),
    hours: [],
    economy: false,
  };
}

function csvCell(v: string): string {
  return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function csvKr(ore: number | null): string {
  if (ore === null) return "";
  const sign = ore < 0 ? "-" : "";
  const abs = Math.abs(ore);
  return `${sign}${Math.floor(abs / 100)},${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Perioden som CSV (Pengar → Exportera): per titel, per automat och totalen, med semikolon
 * och svenska decimaler (kronor med två decimaler). Bara ekonomiroller anropar den.
 */
export function daySalesCsv(sales: DaySales, period: { start: IsoDate; end: IsoDate }): string {
  const lines: string[] = [];
  const row = (cells: string[]) => lines.push(cells.map(csvCell).join(";"));
  row(["Period", period.start === period.end ? period.start : `${period.start}–${period.end}`]);
  row([]);
  row(["Typ", "Namn", "Kod", "Sålda pack", "Intäkt exkl. moms (kr)", "Vinst (kr)"]);
  for (const t of sales.titles) {
    row(["Titel", t.name, "", String(t.units), csvKr(t.revenueOre), csvKr(t.profitOre)]);
  }
  for (const m of sales.machines) {
    row([
      "Automat",
      m.name,
      m.code ?? "",
      String(m.units),
      csvKr(m.revenueOre),
      csvKr(m.profitOre),
    ]);
  }
  row(["Totalt", "", "", String(sales.units), csvKr(sales.revenueOre), csvKr(sales.profitOre)]);
  return `﻿${lines.join("\r\n")}\r\n`;
}
