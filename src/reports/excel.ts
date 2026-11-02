/**
 * Bokföringsrapporten som Excel-arbetsbok (exceljs).
 *
 * Blad: Sammanfattning, Per dag, Per butik, Per automat, Avstämning. Rubrikraden är
 * fryst på varje blad, beloppskolumner har talformat i kronor och en summarad avslutar
 * tabellerna. Belopp skrivs som kronor (öre / 100), eftersom Excel räknar med tal; de
 * är exakta på öret för alla belopp som ryms i beräkningslagret.
 *
 * Datum skrivs som text 'ÅÅÅÅ-MM-DD' (inte som Excel-datum), så att processens
 * tidszon inte kan flytta en dag. Arbetsbokens skapad/ändrad sätts till periodens sista
 * dag (UTC) så att innehållet blir detsamma varje gång.
 */

import ExcelJS from "exceljs";
import type { AccountantReport } from "./accountant-report";
import { gapsText } from "./accountant-report";
import { periodText } from "./text";

/** Talformat för kronor. */
export const KRONOR_FORMAT = '#,##0.00 "kr"';
/** Talformat för antal. */
export const COUNT_FORMAT = "0";

type Kind = "text" | "kr" | "count";
interface Column {
  readonly header: string;
  readonly kind: Kind;
  readonly width: number;
}

function kr(ore: number): number {
  return ore / 100;
}

function addTable(
  wb: ExcelJS.Workbook,
  name: string,
  columns: readonly Column[],
  rows: readonly (readonly (string | number)[])[],
  total?: readonly (string | number | null)[],
): ExcelJS.Worksheet {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, width: c.width }));
  ws.getRow(1).font = { bold: true };
  const format = (row: ExcelJS.Row): void => {
    columns.forEach((c, i) => {
      if (c.kind === "kr") row.getCell(i + 1).numFmt = KRONOR_FORMAT;
      if (c.kind === "count") row.getCell(i + 1).numFmt = COUNT_FORMAT;
    });
  };
  for (const r of rows) format(ws.addRow([...r]));
  if (total) {
    const row = ws.addRow(total.map((v) => (v === null ? "" : v)));
    row.font = { bold: true };
    format(row);
  }
  return ws;
}

/**
 * Bygger arbetsboken och returnerar den som en xlsx-fil i en Buffer.
 * Läses tillbaka med `new ExcelJS.Workbook().xlsx.load(buffer)`.
 */
export async function buildAccountantWorkbook(report: AccountantReport): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const [y, m, d] = report.period.end.split("-").map(Number) as [number, number, number];
  const stamp = new Date(Date.UTC(y, m - 1, d));
  wb.creator = "Binderlab";
  wb.created = stamp;
  wb.modified = stamp;
  const t = report.totals;

  addTable(
    wb,
    "Sammanfattning",
    [
      { header: "Post", kind: "text", width: 40 },
      { header: "Värde", kind: "text", width: 20 },
    ],
    [],
  );
  const summary = wb.getWorksheet("Sammanfattning")!;
  const put = (label: string, value: string | number, kind: Kind): void => {
    const row = summary.addRow([label, value]);
    if (kind === "kr") row.getCell(2).numFmt = KRONOR_FORMAT;
    if (kind === "count") row.getCell(2).numFmt = COUNT_FORMAT;
  };
  put("Period", periodText(report.period), "text");
  put("Slutsats", report.conclusion.text, "text");
  put("Antal order", t.orders, "count");
  put("Försäljning inkl. moms", kr(t.grossOre), "kr");
  put("Moms", kr(t.vatOre), "kr");
  put("Försäljning exkl. moms", kr(t.netOre), "kr");
  put("Avgifter", kr(t.feesOre), "kr");
  put("Inköp (order med inköpspris)", kr(t.costOre), "kr");
  put("Order utan inköpspris", t.unpricedOrders, "count");
  put("Provision", kr(t.commissionOre), "kr");
  put("Hyra", kr(t.rentOre), "kr");
  put("Butiksersättning", kr(t.compensationOre), "kr");
  put("Beräkningsversion", report.calcVersion, "text");

  const sumOf = <T>(rows: readonly T[], pick: (r: T) => number): number =>
    rows.reduce((s, r) => s + pick(r), 0);

  addTable(
    wb,
    "Per dag",
    [
      { header: "Datum", kind: "text", width: 12 },
      { header: "Antal order", kind: "count", width: 12 },
      { header: "Inkl. moms", kind: "kr", width: 16 },
      { header: "Moms", kind: "kr", width: 14 },
      { header: "Exkl. moms", kind: "kr", width: 16 },
      { header: "Avgifter", kind: "kr", width: 14 },
    ],
    report.days.map((r) => [
      r.date,
      r.orders,
      kr(r.grossOre),
      kr(r.vatOre),
      kr(r.netOre),
      kr(r.feesOre),
    ]),
    ["Summa", t.orders, kr(t.grossOre), kr(t.vatOre), kr(t.netOre), kr(t.feesOre)],
  );

  addTable(
    wb,
    "Per butik",
    [
      { header: "Butik", kind: "text", width: 28 },
      { header: "Antal order", kind: "count", width: 12 },
      { header: "Inkl. moms", kind: "kr", width: 16 },
      { header: "Moms", kind: "kr", width: 14 },
      { header: "Exkl. moms", kind: "kr", width: 16 },
      { header: "Avgifter", kind: "kr", width: 14 },
      { header: "Inköp", kind: "kr", width: 14 },
      { header: "Provision", kind: "kr", width: 14 },
      { header: "Hyra", kind: "kr", width: 14 },
      { header: "Butiksersättning", kind: "kr", width: 18 },
    ],
    report.stores.map((r) => [
      r.name,
      r.orders,
      kr(r.grossOre),
      kr(r.vatOre),
      kr(r.netOre),
      kr(r.feesOre),
      kr(r.costOre),
      kr(r.commissionOre),
      kr(r.rentOre),
      kr(r.compensationOre),
    ]),
    [
      "Summa",
      t.orders,
      kr(t.grossOre),
      kr(t.vatOre),
      kr(t.netOre),
      kr(t.feesOre),
      kr(sumOf(report.stores, (r) => r.costOre)),
      kr(t.commissionOre),
      kr(t.rentOre),
      kr(t.compensationOre),
    ],
  );

  addTable(
    wb,
    "Per automat",
    [
      { header: "Automat", kind: "text", width: 28 },
      { header: "Butik", kind: "text", width: 28 },
      { header: "Antal order", kind: "count", width: 12 },
      { header: "Inkl. moms", kind: "kr", width: 16 },
      { header: "Moms", kind: "kr", width: 14 },
      { header: "Exkl. moms", kind: "kr", width: 16 },
      { header: "Avgifter", kind: "kr", width: 14 },
      { header: "Inköp", kind: "kr", width: 14 },
      { header: "Provision", kind: "kr", width: 14 },
    ],
    report.machines.map((r) => [
      r.name,
      r.storeNames.join(", "),
      r.orders,
      kr(r.grossOre),
      kr(r.vatOre),
      kr(r.netOre),
      kr(r.feesOre),
      kr(r.costOre),
      kr(r.commissionOre),
    ]),
    [
      "Summa",
      "",
      t.orders,
      kr(t.grossOre),
      kr(t.vatOre),
      kr(t.netOre),
      kr(t.feesOre),
      kr(sumOf(report.machines, (r) => r.costOre)),
      kr(sumOf(report.machines, (r) => r.commissionOre)),
    ],
  );

  const rec = report.reconciliation;
  const ws = addTable(
    wb,
    "Avstämning",
    [
      { header: "Kontroll", kind: "text", width: 48 },
      { header: "Förväntat", kind: "text", width: 18 },
      { header: "Faktiskt", kind: "text", width: 18 },
      { header: "Status", kind: "text", width: 12 },
    ],
    [],
  );
  for (const c of rec.checks) {
    const row = ws.addRow([
      c.label,
      c.unit === "ore" ? kr(c.expected) : c.expected,
      c.unit === "ore" ? kr(c.actual) : c.actual,
      c.ok ? "OK" : "Avviker",
    ]);
    const fmt = c.unit === "ore" ? KRONOR_FORMAT : COUNT_FORMAT;
    row.getCell(2).numFmt = fmt;
    row.getCell(3).numFmt = fmt;
  }
  ws.addRow([]);
  const n = rec.numbers;
  ws.addRow(["Antal order i perioden", rec.orderCount]);
  if (n) {
    ws.addRow(["Första ordernummer", n.first]);
    ws.addRow(["Sista ordernummer", n.last]);
    ws.addRow(["Antal ordernummer", n.count]);
    ws.addRow(["Nummer i intervallet", n.span]);
    ws.addRow(["Saknade nummer", n.missing]);
    ws.addRow(["Luckor", n.gaps.length === 0 ? "Inga" : gapsText(n.gaps)]);
    if (n.outsidePeriod.length > 0) {
      ws.addRow(["Nummer med datum utanför perioden", n.outsidePeriod.join(", ")]);
    }
  } else {
    ws.addRow(["Ordernummer", "Inga numeriska ordernummer att stämma av"]);
  }
  if (rec.duplicateExternalIds.length > 0)
    ws.addRow(["Dubbletter", rec.duplicateExternalIds.join(", ")]);
  if (rec.nonNumericIds.length > 0)
    ws.addRow(["Ej numeriska ordernummer", rec.nonNumericIds.join(", ")]);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}
