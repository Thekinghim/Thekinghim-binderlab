/**
 * Orderlistan som CSV i svenskt Excel-format (src/lib/csv): semikolon, decimalkomma,
 * BOM. Tider i organisationens tidszon. Rent, testas i order.test.ts.
 */

import { csvFileName, toCsv, type CsvColumn } from "@/lib/csv";

import type { OrderRefs, OrderRow } from "./types";

const zoned = new Map<string, Intl.DateTimeFormat>();

function zonedFormat(timeZone: string): Intl.DateTimeFormat {
  let f = zoned.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    zoned.set(timeZone, f);
  }
  return f;
}

const HOUR = 3_600_000;
const MINUTE = 60_000;

/** Tidszonens förskjutning (ms) vid tidpunkten, exakt via Intl. */
function offsetAt(ms: number, timeZone: string): number {
  const p: Record<string, number> = {};
  for (const part of zonedFormat(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== "literal") p[part.type] = Number(part.value);
  }
  const wall = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!);
  return wall - Math.floor(ms / MINUTE) * MINUTE;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * Tider i en tidszon för många rader. Intl är långsamt per anrop (100 000 order tar
 * sekunder), så förskjutningen räknas en gång per timme och återanvänds när den är
 * densamma vid timmens början och slut (ett skifte inom timmen räknas exakt).
 */
export function csvTimeFormatter(timeZone: string): (iso: string) => string {
  const byHour = new Map<number, number | null>();
  return (iso) => {
    const ms = Date.parse(iso);
    if (!Number.isFinite(ms)) return "";
    const hour = Math.floor(ms / HOUR);
    let offset = byHour.get(hour);
    if (offset === undefined) {
      const a = offsetAt(hour * HOUR, timeZone);
      const b = offsetAt((hour + 1) * HOUR - MINUTE, timeZone);
      offset = a === b ? a : null;
      byHour.set(hour, offset);
    }
    const d = new Date(Math.floor(ms / MINUTE) * MINUTE + (offset ?? offsetAt(ms, timeZone)));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
  };
}

/** "2026-11-01 17:17" i tidszonen (minutnoggrannhet, som i listan). */
export function csvTime(iso: string, timeZone: string): string {
  return csvTimeFormatter(timeZone)(iso);
}

/**
 * Öre som kronor för CSV: "79987,00", "-3,50". Samma utdata som
 * formatCsvNumber(öre / 100, 2) men med heltal, utan Intl per rad.
 */
export function csvKronor(ore: number): string {
  if (!Number.isSafeInteger(ore)) return "";
  const abs = Math.abs(ore);
  return `${ore < 0 ? "-" : ""}${Math.floor(abs / 100)},${pad2(abs % 100)}`;
}

export function orderCsvColumns(refs: OrderRefs, timeZone: string): CsvColumn<OrderRow>[] {
  const titles = new Map(refs.titles.map((t) => [t.id, t.name]));
  const machines = new Map(refs.machines.map((m) => [m.id, m]));
  const stores = new Map(refs.stores.map((s) => [s.id, s.name]));
  const time = csvTimeFormatter(timeZone);
  return [
    { header: "Ordernummer", csv: (r) => r.externalId },
    { header: "Tid", csv: (r) => time(r.orderedAt) },
    { header: "Affärsdatum", csv: (r) => r.businessDate },
    { header: "Titel", csv: (r) => (r.titleId ? (titles.get(r.titleId) ?? "") : "") },
    { header: "Originaltitel", csv: (r) => r.rawTitle ?? "" },
    { header: "Automat", csv: (r) => (r.machineId ? (machines.get(r.machineId)?.code ?? "") : "") },
    {
      header: "Automatnamn",
      csv: (r) => (r.machineId ? (machines.get(r.machineId)?.name ?? "") : ""),
    },
    { header: "Butik", csv: (r) => (r.storeId ? (stores.get(r.storeId) ?? "") : "") },
    { header: "Belopp (kr)", csv: (r) => csvKronor(r.amountOre) },
  ];
}

export function orderCsv(rows: readonly OrderRow[], refs: OrderRefs, timeZone: string): string {
  return toCsv(rows, orderCsvColumns(refs, timeZone));
}

/** "order-2026-10-13--2026-11-01.csv" */
export function orderCsvFileName(period: { start: string; end: string }): string {
  return `${csvFileName(`order-${period.start}--${period.end}`)}.csv`;
}
