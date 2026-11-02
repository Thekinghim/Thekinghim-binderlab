import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { allocateToOwners } from "./owners";
import { rng } from "./testing/fixtures";

describe("allocateToOwners", () => {
  it("öret som blir över går till den största andelen", () => {
    expect(
      allocateToOwners(100_001, [
        { id: "agare", shareBp: 5000 },
        { id: "delagare", shareBp: 5000 },
      ]),
    ).toEqual([
      { id: "agare", shareBp: 5000, amountOre: 50_001 },
      { id: "delagare", shareBp: 5000, amountOre: 50_000 },
    ]);
    // 60/30/10 av 999,99 kr: 29 999,7 → 29 999; 9 999,9 → 9 999; största får 60 001
    expect(
      allocateToOwners(99_999, [
        { id: "b", shareBp: 3000 },
        { id: "a", shareBp: 6000 },
        { id: "c", shareBp: 1000 },
      ]).map((x) => x.amountOre),
    ).toEqual([29_999, 60_001, 9_999]);
  });

  it("negativt belopp (förlust) fördelas symmetriskt", () => {
    expect(
      allocateToOwners(-100_001, [
        { id: "a", shareBp: 5000 },
        { id: "b", shareBp: 5000 },
      ]).map((x) => x.amountOre),
    ).toEqual([-50_001, -50_000]);
  });

  it("andelarna måste summera till 10 000 bp", () => {
    expect(() => allocateToOwners(100, [{ id: "a", shareBp: 9999 }])).toThrow(
      expect.objectContaining({ code: "invalid_shares" }),
    );
    expect(() => allocateToOwners(100, [])).toThrow(DomainError);
    expect(() =>
      allocateToOwners(100, [
        { id: "a", shareBp: 5000 },
        { id: "a", shareBp: 5000 },
      ]),
    ).toThrow(DomainError);
    expect(() => allocateToOwners(1.5, [{ id: "a", shareBp: 10_000 }])).toThrow(DomainError);
  });

  it("summan stämmer alltid exakt (slumpade fall)", () => {
    const r = rng(99);
    for (let i = 0; i < 2000; i++) {
      const n = r.int(1, 6);
      const cuts = Array.from({ length: n - 1 }, () => r.int(0, 10_000)).sort((a, b) => a - b);
      const bounds = [0, ...cuts, 10_000];
      const shares = bounds.slice(1).map((b, k) => ({ id: `o${k}`, shareBp: b - bounds[k]! }));
      const amount = r.int(-10_000_000, 1_000_000_000);
      const parts = allocateToOwners(amount, shares);
      expect(parts.reduce((a, p) => a + p.amountOre, 0)).toBe(amount);
      parts.forEach((p) => {
        expect(Math.abs(p.amountOre - (amount * p.shareBp) / 10_000)).toBeLessThan(n);
      });
    }
  });
});
