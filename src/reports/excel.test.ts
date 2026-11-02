import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildAccountantReport } from "./accountant-report";
import { buildAccountantWorkbook, KRONOR_FORMAT } from "./excel";
import { agreement, ord, placement, price, sources } from "./testing/fixtures";

const NOV = { start: "2026-11-01", end: "2026-11-30" };

function report() {
  return buildAccountantReport(
    sources({
      settings: { vatRateBp: 2500, cardFeeBp: 0 },
      orders: [
        ord("2026-11-01", { externalId: "10" }),
        ord("2026-11-02", { externalId: "11", amountOre: 5950 }),
        ord("2026-11-02", { externalId: "13", machineId: "m-2", amountOre: 12_900 }),
      ],
      placements: [
        placement("m-1", "s-1", "2025-01-01", null),
        placement("m-2", "s-2", "2025-01-01", null),
      ],
      prices: [price("t-a", 2000, "2025-01-01")],
      agreements: [
        agreement("s-1", "2025-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
      ],
    }),
    NOV,
  );
}

async function load(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return wb;
}

describe("Excel-arbetsboken", () => {
  it("går att läsa tillbaka med rätt blad, frysta rubriker och talformat", async () => {
    const r = report();
    const buf = await buildAccountantWorkbook(r);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.subarray(0, 2).toString("latin1")).toBe("PK");
    const wb = await load(buf);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Sammanfattning",
      "Per dag",
      "Per butik",
      "Per automat",
      "Avstämning",
    ]);
    for (const ws of wb.worksheets) {
      expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
      expect(ws.getRow(1).font?.bold).toBe(true);
    }
  });

  it("sammanfattningen visar totalerna i kronor", async () => {
    const r = report();
    const ws = (await load(await buildAccountantWorkbook(r))).getWorksheet("Sammanfattning")!;
    const rows = new Map<string, ExcelJS.Cell>();
    ws.eachRow((row) => rows.set(String(row.getCell(1).value), row.getCell(2)));
    expect(rows.get("Antal order")!.value).toBe(3);
    expect(rows.get("Försäljning inkl. moms")!.value).toBe(237.5);
    expect(rows.get("Försäljning inkl. moms")!.numFmt).toBe(KRONOR_FORMAT);
    expect(rows.get("Moms")!.value).toBe(r.totals.vatOre / 100);
    expect(rows.get("Slutsats")!.value).toBe(r.conclusion.text);
  });

  it("per dag: en rad per dag plus summa, datum som text", async () => {
    const r = report();
    const ws = (await load(await buildAccountantWorkbook(r))).getWorksheet("Per dag")!;
    expect(ws.getRow(1).values).toEqual([
      undefined,
      "Datum",
      "Antal order",
      "Inkl. moms",
      "Moms",
      "Exkl. moms",
      "Avgifter",
    ]);
    expect(ws.rowCount).toBe(1 + 30 + 1);
    expect(ws.getRow(2).getCell(1).value).toBe("2026-11-01");
    expect(ws.getRow(3).getCell(3).value).toBe(188.5);
    expect(ws.getRow(3).getCell(3).numFmt).toBe(KRONOR_FORMAT);
    expect(ws.getRow(32).getCell(1).value).toBe("Summa");
    expect(ws.getRow(32).getCell(3).value).toBe(237.5);
  });

  it("per butik, per automat och avstämning", async () => {
    const r = report();
    const wb = await load(await buildAccountantWorkbook(r));
    const store = wb.getWorksheet("Per butik")!;
    const names: string[] = [];
    store.eachRow((row, i) => i > 1 && names.push(String(row.getCell(1).value)));
    expect(names).toEqual(["Mobilia", "Nordstan", "Summa"]);
    expect(store.getRow(3).getCell(9).value).toBe(62);
    const machine = wb.getWorksheet("Per automat")!;
    expect(machine.getRow(2).getCell(2).value).toBe("Mobilia");
    const rec = wb.getWorksheet("Avstämning")!;
    const labels: string[] = [];
    rec.eachRow((row) => labels.push(`${row.getCell(1).value}=${row.getCell(2).value}`));
    expect(labels).toContain("Saknade nummer=1");
    expect(labels).toContain("Luckor=12");
    expect(labels.filter((l) => l.startsWith("Summa per")).length).toBe(3);
    rec.eachRow((row, i) => {
      if (i > 1 && i <= 1 + r.reconciliation.checks.length) expect(row.getCell(4).value).toBe("OK");
    });
  });
});
