/**
 * Excel-filer (.xlsx) från Nayax till rader med text, så att samma tolkning som för CSV
 * används (./import-parse.ts). Första kalkylbladet med data; rubrikraden är första raden
 * med minst två ifyllda celler. Datum blir ÅÅÅÅ-MM-DD (UTC, som Excel lagrar dem) och tal
 * skrivs med punkt som decimaltecken utan tusentalsavgränsare.
 *
 * Skydd mot filer som packas upp till mycket mer än de väger (zip-bomber): zip-filens
 * innehållsförteckning läses FÖRE ExcelJS och filen nekas om allt uppackat blir mer än
 * XLSX_MAX_UNPACKED_BYTES eller packas mer än XLSX_MAX_RATIO gånger (checkZipSize). Högst
 * XLSX_MAX_COLUMNS kolumner och XLSX_MAX_ROWS rader läses (fler rader: `truncated`).
 */

import ExcelJS from "exceljs";

export const XLSX_MAX_ROWS = 20_000;
export const XLSX_MAX_COLUMNS = 100;
export const XLSX_MAX_UNPACKED_BYTES = 50 * 1024 * 1024;
export const XLSX_MAX_RATIO = 100;

export class XlsxTooLargeError extends Error {
  constructor() {
    super("Excel-filen är för stor uppackad. Spara den som CSV och försök igen.");
    this.name = "XlsxTooLargeError";
  }
}

/**
 * Kontrollerar zip-filens innehållsförteckning (central directory) utan att packa upp
 * något. Kastar XlsxTooLargeError när filen är för stor uppackad, packad för hårt, är
 * Zip64 eller går inte att läsa.
 */
export function checkZipSize(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 22 - 0xffff);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new XlsxTooLargeError();
  const entries = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || at === 0xffffffff) throw new XlsxTooLargeError();
  let unpacked = 0;
  let packed = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) {
      throw new XlsxTooLargeError();
    }
    const c = view.getUint32(at + 20, true);
    const u = view.getUint32(at + 24, true);
    if (c === 0xffffffff || u === 0xffffffff) throw new XlsxTooLargeError();
    packed += c;
    unpacked += u;
    if (unpacked > XLSX_MAX_UNPACKED_BYTES) throw new XlsxTooLargeError();
    at +=
      46 +
      view.getUint16(at + 28, true) +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
  }
  if (packed > 0 && unpacked / packed > XLSX_MAX_RATIO) throw new XlsxTooLargeError();
}

/** Sant när innehållet ser ut som en xlsx-fil (zip). */
export function isXlsx(bytes: Uint8Array): boolean {
  return (
    bytes.length > 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04
  );
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    // Hela öre: två decimaler räcker, utan flyttalsbrus.
    return Number.isInteger(value) ? String(value) : (Math.round(value * 100) / 100).toFixed(2);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    if ("result" in value && value.result !== undefined) {
      return cellText(value.result as ExcelJS.CellValue);
    }
    if ("richText" in value && Array.isArray(value.richText)) {
      return value.richText.map((r) => r.text).join("");
    }
    if ("text" in value && typeof value.text === "string") return value.text;
  }
  return String(value);
}

/** Rubriker och datarader ur första bladet med data. */
export async function readXlsxTable(
  bytes: Uint8Array,
): Promise<{ headers: string[]; rows: string[][]; truncated: boolean }> {
  checkZipSize(bytes);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  for (const ws of wb.worksheets) {
    const all: string[][] = [];
    let truncated = false;
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (all.length > XLSX_MAX_ROWS) {
        truncated = true;
        return;
      }
      const values = row.values as ExcelJS.CellValue[];
      const cells: string[] = [];
      const last = Math.min(values.length, XLSX_MAX_COLUMNS + 1);
      for (let i = 1; i < last; i++) cells.push(cellText(values[i]).trim());
      all.push(cells);
    });
    const headerIndex = all.findIndex((r) => r.filter((c) => c !== "").length >= 2);
    if (headerIndex < 0) continue;
    const headers = all[headerIndex]!;
    const rows = all.slice(headerIndex + 1).map((r) => {
      const out = [...r];
      while (out.length < headers.length) out.push("");
      return out;
    });
    return { headers, rows, truncated };
  }
  return { headers: [], rows: [], truncated: false };
}
