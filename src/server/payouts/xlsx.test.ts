import { deflateRawSync } from "node:zlib";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { checkZipSize, readXlsxTable, XlsxTooLargeError } from "./xlsx";

/** En zip med en fil (`size` nollor), packad med deflate: liten fil, stor uppackad. */
function zipOf(size: number): Uint8Array {
  const data = deflateRawSync(Buffer.alloc(size));
  const name = Buffer.from("xl/sheet1.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  const cdOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return new Uint8Array(Buffer.concat([local, name, data, central, name, end]));
}

describe("Excel-filer", () => {
  it("nekar en zip-bomb innan något packas upp", () => {
    expect(() => checkZipSize(zipOf(60 * 1024 * 1024))).toThrow(XlsxTooLargeError);
    // Hårt packad men liten: förhållandet är för högt.
    expect(() => checkZipSize(zipOf(5 * 1024 * 1024))).toThrow(XlsxTooLargeError);
    expect(() => checkZipSize(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]))).toThrow(XlsxTooLargeError);
  });

  it("läser en vanlig Excel-fil, högst 100 kolumner", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Blad1");
    const wide = Array.from({ length: 150 }, (_, i) => (i === 0 ? "Belopp" : `K${i}`));
    ws.addRow(wide);
    ws.addRow(["1 234,56", ...Array.from({ length: 149 }, () => "x")]);
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer());
    expect(() => checkZipSize(bytes)).not.toThrow();
    const t = await readXlsxTable(bytes);
    expect(t.headers.length).toBe(100);
    expect(t.rows[0]![0]).toBe("1 234,56");
    expect(t.truncated).toBe(false);
  });
});
