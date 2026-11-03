/**
 * Raderna i månadspaketet som Excel (exceljs): Verifikation, Butiker, Dagar, Kvitton.
 * Belopp i kronor med talformat, datum som text 'ÅÅÅÅ-MM-DD'. Arbetsbokens datum är
 * månadens sista dag (UTC), så att samma underlag ger samma innehåll.
 */

import ExcelJS from "exceljs";

import { monthEnd } from "@/domain";
import { KRONOR_FORMAT } from "@/reports";

import type { MonthBook } from "./month";
import type { MonthVerification } from "./sie";

export interface ReceiptIndexRow {
  readonly file: string;
  readonly originalName: string;
  readonly uploadedOn: string;
  readonly sizeBytes: number;
}

const kr = (ore: number) => ore / 100;

function sheet(
  wb: ExcelJS.Workbook,
  name: string,
  headers: readonly { h: string; w: number; kr?: boolean }[],
  rows: readonly (readonly (string | number)[])[],
): void {
  const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = headers.map((c) => ({ header: c.h, width: c.w }));
  ws.getRow(1).font = { bold: true };
  for (const r of rows) {
    const row = ws.addRow([...r]);
    headers.forEach((c, i) => {
      if (c.kr) row.getCell(i + 1).numFmt = KRONOR_FORMAT;
    });
  }
}

export async function buildMonthWorkbook(input: {
  readonly book: MonthBook;
  readonly verification: MonthVerification;
  readonly accountNames: ReadonlyMap<string, string>;
  readonly receipts: readonly ReceiptIndexRow[];
}): Promise<Uint8Array> {
  const { book, verification } = input;
  const wb = new ExcelJS.Workbook();
  const stamp = new Date(`${monthEnd(book.month)}T00:00:00Z`);
  wb.creator = "Binderlab";
  wb.created = stamp;
  wb.modified = stamp;

  sheet(
    wb,
    "Verifikation",
    [
      { h: "Datum", w: 12 },
      { h: "Serie", w: 7 },
      { h: "Nr", w: 6 },
      { h: "Konto", w: 8 },
      { h: "Kontonamn", w: 36 },
      { h: "Text", w: 36 },
      { h: "Debet", w: 14, kr: true },
      { h: "Kredit", w: 14, kr: true },
    ],
    verification.rows.map((r) => [
      verification.date,
      verification.series,
      verification.number,
      r.account,
      input.accountNames.get(r.account) ?? "",
      r.text,
      r.amountOre > 0 ? kr(r.amountOre) : "",
      r.amountOre < 0 ? kr(-r.amountOre) : "",
    ]),
  );
  sheet(
    wb,
    "Butiker",
    [
      { h: "Butik", w: 30 },
      { h: "Order", w: 8 },
      { h: "Försäljning inkl. moms", w: 20, kr: true },
      { h: "Andel", w: 14, kr: true },
      { h: "Hyra", w: 14, kr: true },
      { h: "Att betala", w: 14, kr: true },
    ],
    book.stores.map((s) => [
      s.name,
      s.orders,
      kr(s.salesInclVatOre),
      kr(s.shareOre),
      kr(s.rentOre),
      kr(s.totalOre),
    ]),
  );
  sheet(
    wb,
    "Dagar",
    [
      { h: "Datum", w: 12 },
      { h: "Order", w: 8 },
      { h: "Försäljning inkl. moms", w: 20, kr: true },
    ],
    book.days.map((d) => [d.date, d.orders, kr(d.salesInclVatOre)]),
  );
  sheet(
    wb,
    "Kvitton",
    [
      { h: "Fil i paketet", w: 40 },
      { h: "Uppladdat namn", w: 40 },
      { h: "Uppladdad", w: 12 },
      { h: "Storlek (kB)", w: 12 },
    ],
    input.receipts.map((r) => [
      r.file,
      r.originalName,
      r.uploadedOn,
      Math.ceil(r.sizeBytes / 1024),
    ]),
  );
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
