import { describe, expect, it } from "vitest";

import {
  columnsFromMapping,
  detectColumns,
  extractFromRows,
  headerSignature,
  mappingFromColumns,
  parseLooseDate,
  parseLooseOre,
} from "./import-parse";

describe("rubrikerna", () => {
  it("känner igen svenska och engelska rubriker", () => {
    expect(
      detectColumns(["Utbetalningsdatum", "Belopp", "Avgift", "Period från", "Period till"]),
    ).toEqual({
      paid_on: 0,
      amount: 1,
      fees: 2,
      period_from: 3,
      period_to: 4,
    });
    expect(detectColumns(["Settlement Date", "Net Amount", "Total Fees", "Gross Amount"])).toEqual({
      paid_on: 0,
      amount: 1,
      fees: 2,
      gross: 3,
    });
    expect(detectColumns(["Transaction ID", "Machine Serial", "Date", "Amount"])).toMatchObject({
      transaction_id: 0,
      device_serial: 1,
      transaction_date: 2,
      amount: 3,
    });
  });

  it("samma rubriker i annan ordning och skrivsätt ger samma fingeravtryck", () => {
    expect(headerSignature(["Belopp", "Datum"])).toBe(headerSignature(["datum", "BELOPP "]));
    expect(headerSignature(["Belopp", "Datum"])).not.toBe(headerSignature(["Belopp", "Dag"]));
  });

  it("en mappning går fram och tillbaka", () => {
    const headers = ["A", "B", "C"];
    const m = mappingFromColumns(headers, { amount: 2, paid_on: 0 });
    expect(m).toEqual({ paid_on: "A", amount: "C" });
    expect(columnsFromMapping(headers, m)).toEqual({ paid_on: 0, amount: 2 });
  });
});

describe("belopp och datum", () => {
  it("läser svenska och engelska belopp utan flyttal", () => {
    expect(parseLooseOre("1 234,56 kr")).toBe(123_456);
    expect(parseLooseOre("1,234.56")).toBe(123_456);
    expect(parseLooseOre("−373,00")).toBe(-37_300);
    expect(parseLooseOre("(373.00)")).toBe(-37_300);
    expect(parseLooseOre("SEK 48 210")).toBe(4_821_000);
    expect(parseLooseOre("")).toBeNull();
    expect(parseLooseOre("abc")).toBeNull();
  });
  it("läser datum i flera format", () => {
    expect(parseLooseDate("13.11.2026")).toBe("2026-11-13");
    expect(parseLooseDate("2026-11-13")).toBe("2026-11-13");
    expect(parseLooseDate("13/11/2026 10:22")).toBe("2026-11-13");
    expect(parseLooseDate("20261113")).toBe("2026-11-13");
    expect(parseLooseDate("31.02.2026")).toBeNull();
  });
});

describe("extractFromRows", () => {
  it("en sammanfattning: första raden, och kontrollen av summorna", () => {
    const cols = detectColumns(["Datum", "Netto", "Avgift", "Brutto"]);
    const ok = extractFromRows([["13.11.2026", "48 210,00", "1 790,00", "50 000,00"]], cols);
    expect(ok.extracted).toMatchObject({
      paidOn: "2026-11-13",
      amountOre: 4_821_000,
      feesOre: 179_000,
      grossOre: 5_000_000,
    });
    expect(ok.warnings).toEqual([]);
    const bad = extractFromRows([["13.11.2026", "48 210,00", "1 790,00", "52 000,00"]], cols);
    expect(bad.warnings).toContainEqual({ code: "SUMS_MISMATCH", diffOre: 200_000 });
  });

  it("transaktioner: summa, period och automater", () => {
    const cols = detectColumns(["Transaction ID", "Machine Serial", "Date", "Amount"]);
    const r = extractFromRows(
      [
        ["t1", "NX1", "2026-11-03 10:00", "79,00"],
        ["t2", "NX1", "2026-11-04", "79,00"],
        ["t3", "NX2", "2026-11-09", "89,00"],
        ["", "", "", ""],
      ],
      cols,
    );
    expect(r.extracted).toMatchObject({
      amountOre: 24_700,
      periodFrom: "2026-11-03",
      periodTo: "2026-11-09",
    });
    expect(r.extracted.transactions).toHaveLength(3);
    expect(r.extracted.devices).toEqual([
      { serial: "NX1", amountOre: 15_800 },
      { serial: "NX2", amountOre: 8900 },
    ]);
  });

  it("räknar beloppet från brutto − avgift när netto saknas", () => {
    const cols = detectColumns(["Gross", "Fee"]);
    expect(extractFromRows([["100,00", "5,00"]], cols).extracted.amountOre).toBe(9500);
  });
});
