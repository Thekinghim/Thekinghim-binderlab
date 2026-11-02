import { describe, expect, it } from "vitest";
import {
  assertCount,
  assertOre,
  dateWithYear,
  financeEvidence,
  shiftMonths,
  toPeriod,
} from "./common";

describe("shiftMonths", () => {
  it("behåller dagen och kapar till månadens längd", () => {
    expect(shiftMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(shiftMonths("2024-01-31", 1)).toBe("2024-02-29");
    expect(shiftMonths("2027-03-31", -3)).toBe("2026-12-31");
    expect(shiftMonths("2026-11-02", -12)).toBe("2025-11-02");
    expect(shiftMonths("2026-11-02", 0)).toBe("2026-11-02");
    expect(() => shiftMonths("2026-11-02", 1.5)).toThrow(/heltal/);
  });
});

describe("toPeriod", () => {
  it("tar en månad eller en period och kontrollerar den", () => {
    expect(toPeriod("2026-02")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(toPeriod({ start: "2026-11-01", end: "2026-11-15" })).toEqual({
      start: "2026-11-01",
      end: "2026-11-15",
    });
    expect(() => toPeriod("2026-13")).toThrow(/ÅÅÅÅ-MM/);
    expect(() => toPeriod({ start: "2026-11-15", end: "2026-11-01" })).toThrow(/slutar/);
  });
});

describe("hjälp", () => {
  it("dateWithYear", () => {
    expect(dateWithYear("2027-03-31")).toBe("31 mars 2027");
  });

  it("financeEvidence sorterar och tar bort dubbletter", () => {
    const e = financeEvidence({
      rule: "r",
      orderIds: ["b", "a", "b"],
      dates: ["2026-11-02", "2026-11-01"],
      payoutReferences: ["U2", "U1", "U2"],
      contractIds: ["c"],
    });
    expect(e.orderIds).toEqual(["a", "b"]);
    expect(e.dates).toEqual(["2026-11-01", "2026-11-02"]);
    expect(e.payoutReferences).toEqual(["U1", "U2"]);
    expect(e.contractIds).toEqual(["c"]);
    expect(e.fixedCostIds).toEqual([]);
    expect(e.period).toBeNull();
  });

  it("kontroller av belopp och antal", () => {
    expect(assertOre(-5, "x", true)).toBe(-5);
    expect(() => assertOre(-5, "x")).toThrow(/negativt/);
    expect(() => assertOre(0.5, "x")).toThrow(/heltal/);
    expect(() => assertCount(-1, "x")).toThrow(/≥ 0/);
  });
});
