import { describe, expect, it } from "vitest";

import {
  batchToCsv,
  extensionBatchSchema,
  MAX_BATCH_ROWS,
  parseAwishExtensionBatch,
  type ExtensionRow,
} from "./awish-extension";

const context = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  dataSourceId: "00000000-0000-4000-8000-000000000002",
  sourceTimezone: "Asia/Shanghai",
  config: { csvMapping: { columns: { externalId: "Finns inte" } } },
  secretRef: null,
};

function row(overrides: Partial<ExtensionRow> = {}): ExtensionRow {
  return {
    externalId: "42780",
    title: "Pokémon 151 Booster",
    machine: "Ica Kvantum Malmborgs",
    amount: "Amount: 170.00",
    isPaid: "Paid Success",
    paidAt: "2026-11-02 00:17:00",
    paymentMethod: "Swish",
    rowId: "9001",
    orderDate: "2026-11-02",
    page: 1,
    pageRow: 1,
    ...overrides,
  };
}

describe("awish_extension: batch från tillägget", () => {
  it("tolkar en betald rad med CSV-adapterns regler (belopp, Shanghai-tid, ordernummer)", () => {
    const result = parseAwishExtensionBatch({ context, rows: [row()] });
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
    const [order] = result.rows;
    expect(order).toMatchObject({
      externalId: "42780",
      rawTitle: "Pokémon 151 Booster",
      sourceMachineName: "Ica Kvantum Malmborgs",
      amountOre: 17_000,
      isPaid: true,
      paymentMethod: "Swish",
      sourceRowNumber: 1,
    });
    // docs/awish.md: Payment Time 2026-11-02 00:17 i Shanghai = 1 nov. 17:17 svensk tid.
    expect(order!.paidAtUtc.toISOString()).toBe("2026-11-01T16:17:00.000Z");
    expect(order!.raw).toMatchObject({ "Order No.": "42780", Sida: "1", "Rad på sidan": "1" });
    expect(result.machines).toEqual([
      { externalId: "Ica Kvantum Malmborgs", externalName: "Ica Kvantum Malmborgs" },
    ]);
    expect(result.parserVersion).toBe("awish_extension/1+awish_csv/2");
  });

  it("radnumret är platsen i batchen även när en cell har radbrytningar", () => {
    const result = parseAwishExtensionBatch({
      context,
      rows: [
        row({ externalId: "1", amount: "Amount: 79.00\nDiscount Amount: 0.00\r\nPaid Amount: 79.00" }),
        row({ externalId: "2", amount: "Amount: 1,234" }),
        row({ externalId: "3", isPaid: "Unpaid" }),
        row({ externalId: "4", title: "  " }),
      ],
    });
    expect(result.rows.map((r) => [r.externalId, r.sourceRowNumber, r.amountOre])).toEqual([
      ["1", 1, 7900],
      ["3", 3, 17_000],
    ]);
    expect(result.rows[1]!.isPaid).toBe(false);
    expect(result.errors.map((e) => [e.externalId, e.sourceRowNumber])).toEqual([
      ["2", 2],
      ["4", 4],
    ]);
  });

  it("tider med tidszon (Z eller +08:00) är redan entydiga", () => {
    const result = parseAwishExtensionBatch({
      context,
      rows: [row({ paidAt: "2026-11-01T16:17:00Z" }), row({ externalId: "2", paidAt: "2026-11-02T00:17:00+08:00" })],
    });
    expect(result.rows.map((r) => r.paidAtUtc.toISOString())).toEqual([
      "2026-11-01T16:17:00.000Z",
      "2026-11-01T16:17:00.000Z",
    ]);
  });

  it("utan Payment Method i källan jämförs betalmetoden inte", () => {
    const result = parseAwishExtensionBatch({
      context,
      rows: [row({ paymentMethod: undefined })],
      absent: ["paymentMethod"],
    });
    expect(result.absentFields).toEqual(["paymentMethod"]);
    expect(result.rows[0]!.paymentMethod).toBeNull();
  });

  it("en sparad CSV-mappning på datakällan används inte", () => {
    expect(() => parseAwishExtensionBatch({ context, rows: [row()] })).not.toThrow();
  });

  it("Excel-exponent och citattecken i fälten hanteras som i CSV", () => {
    const result = parseAwishExtensionBatch({
      context,
      rows: [row({ externalId: "4.27801E+11" }), row({ externalId: "5", title: 'Box "Elite" ,Trainer' })],
    });
    expect(result.errors).toHaveLength(1);
    expect(result.rows[0]!.rawTitle).toBe('Box "Elite" ,Trainer');
  });

  it("tom batch och för stor batch avvisas", () => {
    expect(() => parseAwishExtensionBatch({ context, rows: [] })).toThrow(/tom/);
    const many = Array.from({ length: MAX_BATCH_ROWS + 1 }, (_, i) => row({ externalId: String(i) }));
    expect(() => parseAwishExtensionBatch({ context, rows: many })).toThrow(/500/);
    expect(extensionBatchSchema.safeParse({ rows: many }).success).toBe(false);
  });

  it("schemat avvisar okända fält i en rad och för långa celler", () => {
    expect(extensionBatchSchema.safeParse({ rows: [{ ...row(), extra: "x" }] }).success).toBe(false);
    expect(
      extensionBatchSchema.safeParse({ rows: [row({ title: "x".repeat(2001) })] }).success,
    ).toBe(false);
  });

  it("batchToCsv räknar radnummer med radbrytningar", () => {
    const { rowByLine } = batchToCsv([row({ amount: "a\nb\nc" }), row()]);
    expect([...rowByLine.entries()]).toEqual([
      [2, 1],
      [5, 2],
    ]);
  });
});
