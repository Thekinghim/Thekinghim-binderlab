import { describe, expect, it } from "vitest";

import { awishRefillNote, refillDeductions, type DeductionLevel } from "./refill-deduction";

const lv = (quantity: number, counted = true): DeductionLevel => ({ quantity, counted });
const run = (
  syncedBefore: boolean,
  levels: Record<string, DeductionLevel>,
  awish: Record<string, number>,
) =>
  refillDeductions({
    syncedBefore,
    levels: new Map(Object.entries(levels)),
    awish: new Map(Object.entries(awish)),
  });

describe("refillDeductions", () => {
  it("automatens första läsning drar inget", () => {
    expect(run(false, { a: lv(2) }, { a: 10 })).toEqual([]);
  });

  it("titelns första saldo i automaten drar inget", () => {
    expect(run(true, {}, { a: 8 })).toEqual([]);
    // Bara försäljning, aldrig räknad: inget känt saldo att jämföra med.
    expect(run(true, { a: lv(-2, false) }, { a: 8 })).toEqual([]);
  });

  it("en ökning dras ur vårt lager", () => {
    expect(run(true, { a: lv(3) }, { a: 15 })).toEqual([{ titleId: "a", quantity: 12 }]);
  });

  it("minskning och samma antal drar inget", () => {
    expect(run(true, { a: lv(9), b: lv(4) }, { a: 7, b: 4 })).toEqual([]);
  });

  it("påfyllning registrerad i appen och sedan synk: ingen dubbeldragning", () => {
    // register_refill höjde saldot 3 → 15; Awish visar 15.
    expect(run(true, { a: lv(15) }, { a: 15 })).toEqual([]);
    // Två sålda sedan påfyllningen: Awish 13, saldot 13.
    expect(run(true, { a: lv(13) }, { a: 13 })).toEqual([]);
  });

  it("ett negativt saldo räknas som 0", () => {
    expect(run(true, { a: lv(-3) }, { a: 10 })).toEqual([{ titleId: "a", quantity: 10 }]);
  });

  it("två automater med samma titel ger två uttag", () => {
    const first = run(true, { a: lv(1) }, { a: 6 });
    const second = run(true, { a: lv(2) }, { a: 10 });
    expect([...first, ...second]).toEqual([
      { titleId: "a", quantity: 5 },
      { titleId: "a", quantity: 8 },
    ]);
  });

  it("flera titlar i samma automat, sorterade", () => {
    expect(run(true, { b: lv(0), a: lv(1), c: lv(5) }, { b: 4, a: 2, c: 1 })).toEqual([
      { titleId: "a", quantity: 1 },
      { titleId: "b", quantity: 4 },
    ]);
  });
});

describe("awishRefillNote", () => {
  it("kod och plats", () => {
    expect(awishRefillNote("BL-002", "Sega gubben")).toBe("Awish-påfyllning BL-002 Sega gubben");
    expect(awishRefillNote("BL-002", " ")).toBe("Awish-påfyllning BL-002");
  });
});
