/**
 * Excel-filer (.xlsx) från Nayax till rader med text, så att samma tolkning som för CSV
 * används (./import-parse.ts). Första kalkylbladet med data; rubrikraden är första raden
 * med minst två ifyllda celler. Datum blir ÅÅÅÅ-MM-DD (UTC, som Excel lagrar dem) och tal
 * skrivs med punkt som decimaltecken utan tusentalsavgränsare.
 */

import ExcelJS from "exceljs";

export const XLSX_MAX_ROWS = 20_000;

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
): Promise<{ headers: string[]; rows: string[][] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(bytes as unknown as ArrayBuffer);
  for (const ws of wb.worksheets) {
    const all: string[][] = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      if (all.length > XLSX_MAX_ROWS) return;
      const values = row.values as ExcelJS.CellValue[];
      const cells: string[] = [];
      for (let i = 1; i < values.length; i++) cells.push(cellText(values[i]).trim());
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
    return { headers, rows };
  }
  return { headers: [], rows: [] };
}
