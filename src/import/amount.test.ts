import { describe, expect, it } from "vitest";

import { parseAmountOre } from "./amount";

const NBSP = String.fromCharCode(0xa0);
const NNBSP = String.fromCharCode(0x202f);
const MINUS = String.fromCharCode(0x2212);

describe("parseAmountOre", () => {
  it.each([
    ["170", 17000],
    ["170.00", 17000],
    ["170,00", 17000],
    ["170.5", 17050],
    ["170,05", 17005],
    ["0", 0],
    ["0.00", 0],
    [".50", 50],
    ["1 234,50", 123450],
    [`1${NBSP}234,50`, 123450],
    [`1${NNBSP}234${NNBSP}567`, 123456700],
    ["1,234.50", 123450],
    ["1.234,50", 123450],
    ["1.234.567", 123456700],
    ["1,234,567.89", 123456789],
    ["Amount: 170.00", 17000],
    ["amount:170", 17000],
    ["Order Amount: 189,00", 18900],
    ["Amount: 170.00\nDiscount: 0.00", 17000],
    ["Amount: 170.00 Paid: 170.00", 17000],
    ["SEK 170", 17000],
    ["170 SEK", 17000],
    ["170 kr", 17000],
    ["170kr", 17000],
    ["170:-", 17000],
    ["  170.00  ", 17000],
    ["+170", 17000],
    ["007", 700],
  ])("%j → %i öre", (input, expected) => {
    expect(parseAmountOre(input)).toEqual({ ok: true, ore: expected });
  });

  it.each([["-170"], [`${MINUS}170`], ["(170.00)"], ["170-"], ["Amount: -170.00"]])(
    "nekar negativt belopp %j",
    (input) => {
      const r = parseAmountOre(input);
      expect(r.ok).toBe(false);
      expect(r.ok ? "" : r.message).toMatch(/Negativa/);
    },
  );

  it.each([
    [""],
    ["   "],
    [null],
    [undefined],
    ["abc"],
    ["Amount: abc"],
    ["170.001"],
    ["1,234"],
    ["1.234"],
    ["12 34"],
    ["1 2345"],
    ["1,23,456.00"],
    ["170,00,00"],
    ["1.234.56"],
    ["170."],
    ["USD 170"],
    ["¥170"],
    ["170 EUR"],
    ["1e3"],
    ["NaN"],
    ["Infinity"],
    ["99999999999999"],
    ["10000000.01"],
  ])("nekar %j", (input) => {
    expect(parseAmountOre(input as string | null | undefined).ok).toBe(false);
  });

  it.each([
    ["Discount Amount: 20.00\nAmount: 170.00", 17000],
    ["Refund Amount: 0.00\nOrder Amount: 170.00", 17000],
    ["Paid Amount: 160.00\nAmount: 170.00", 17000],
    ["Amount: 170.00; Discount Amount: 20.00", 17000],
    ["Amount: 170.00\nAmount: 170.00", 17000],
  ])("tar bara beloppet märkt exakt Amount:/Order Amount: i %j", (input, expected) => {
    expect(parseAmountOre(input)).toEqual({ ok: true, ore: expected });
  });

  it.each([
    ["Discount Amount: 20.00"],
    ["Refund Amount: 0.00"],
    ["Paid Amount: 160.00 Amount: 170.00"],
    ["Amount: 170.00\nOrder Amount: 160.00"],
  ])("nekar %j (inget entydigt orderbelopp)", (input) => {
    expect(parseAmountOre(input).ok).toBe(false);
  });

  it("tar emot högsta tillåtna beloppet exakt", () => {
    expect(parseAmountOre("10 000 000,00")).toEqual({ ok: true, ore: 1_000_000_000 });
  });

  it("ger aldrig ett flyttal", () => {
    for (const s of ["0.1", "0.2", "0.30", "19.99", "1 234,57", "333,33"]) {
      const r = parseAmountOre(s);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(Number.isSafeInteger(r.ore)).toBe(true);
      }
    }
    expect(parseAmountOre("19.99")).toEqual({ ok: true, ore: 1999 });
    expect(parseAmountOre("0.1")).toEqual({ ok: true, ore: 10 });
  });
});
