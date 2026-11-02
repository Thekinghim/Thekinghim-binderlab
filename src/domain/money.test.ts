import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import {
  allocateLargestRemainder,
  applyBp,
  ceilDiv,
  floorDiv,
  mulDivRound,
  ratioBp,
  roundHalfUp,
  sumOre,
} from "./money";
import { rng } from "./testing/fixtures";

describe("roundHalfUp", () => {
  it.each([
    [5, 2, 3],
    [7, 2, 4],
    [4, 2, 2],
    [1, 3, 0],
    [2, 3, 1],
    [149, 100, 1],
    [150, 100, 2],
    [-5, 2, -3],
    [-4, 3, -1],
    [-1, 3, 0],
    [0, 7, 0],
    [5, -2, -3],
  ])("%i / %i → %i", (n, d, expected) => {
    expect(roundHalfUp(n, d)).toBe(expected);
  });

  it("ger aldrig −0", () => {
    expect(Object.is(roundHalfUp(-1, 3), 0)).toBe(true);
    expect(Object.is(mulDivRound(0, -5, 3), 0)).toBe(true);
  });

  it("bigint för stora täljare", () => {
    expect(roundHalfUp(10n ** 15n + 5n, 10n)).toBe(10 ** 14 + 1); // x,5 → uppåt
    expect(roundHalfUp(-(10n ** 15n) - 5n, 10n)).toBe(-(10 ** 14) - 1);
    expect(roundHalfUp(10n ** 20n, 10n ** 6n)).toBe(10 ** 14);
    expect(() => roundHalfUp(10n ** 30n, 1n)).toThrow(DomainError);
  });

  it("division med noll kastar", () => {
    expect(() => roundHalfUp(1, 0)).toThrow(DomainError);
  });

  it("flyttal och osäkra heltal avvisas", () => {
    expect(() => roundHalfUp(1.5, 1)).toThrow(DomainError);
    expect(() => roundHalfUp(2 ** 53, 1)).toThrow(DomainError);
  });

  it("stämmer med bigint-facit för slumpade tal", () => {
    const r = rng(7);
    for (let i = 0; i < 20_000; i++) {
      const n = r.int(-1_000_000_000, 1_000_000_000) * r.int(1, 1000);
      const d = r.int(1, 1_000_000);
      const N = BigInt(n);
      const D = BigInt(d);
      const abs = N < 0n ? -N : N;
      const q = (2n * abs + D) / (2n * D);
      const expected = Number(N < 0n ? -q : q);
      expect(roundHalfUp(n, d)).toBe(expected === 0 ? 0 : expected);
    }
  });
});

describe("mulDivRound och applyBp", () => {
  it("halva öre avrundas uppåt", () => {
    expect(applyBp(4900, 250)).toBe(123); // 122,5
    expect(applyBp(4900, 1000)).toBe(490);
    expect(applyBp(1, 5000)).toBe(1); // 0,5
    expect(applyBp(1, 4999)).toBe(0);
  });

  it("produkter över 2^53 räknas exakt", () => {
    const a = 9_000_000_000_000; // 90 miljarder kr i öre
    expect(mulDivRound(a, 2500, 12_500)).toBe(1_800_000_000_000);
    expect(mulDivRound(9_007_199_254_740_991, 3, 3)).toBe(9_007_199_254_740_991);
    expect(mulDivRound(9_007_199_254_740_991, 10_000, 20_000)).toBe(4_503_599_627_370_496);
  });

  it("ratioBp", () => {
    expect(ratioBp(1, 3)).toBe(3333);
    expect(ratioBp(2, 3)).toBe(6667);
    expect(ratioBp(-1, 8)).toBe(-1250);
    expect(ratioBp(5, 0)).toBeNull();
  });

  it("floorDiv/ceilDiv", () => {
    expect(floorDiv(7, 2)).toBe(3);
    expect(floorDiv(-7, 2)).toBe(-4);
    expect(ceilDiv(7, 2)).toBe(4);
    expect(ceilDiv(6, 2)).toBe(3);
    expect(ceilDiv(-7, 2)).toBe(-3);
  });

  it("sumOre stoppar spill", () => {
    expect(sumOre([1, 2, 3])).toBe(6);
    expect(() => sumOre([Number.MAX_SAFE_INTEGER, 1])).toThrow(DomainError);
  });
});

describe("allocateLargestRemainder", () => {
  it("summan blir exakt", () => {
    expect(allocateLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateLargestRemainder(10, [1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(allocateLargestRemainder(6200, [4900, 4900, 4900, 4900, 4900, 5900])).toEqual([
      1000, 1000, 999, 999, 999, 1203,
    ]);
  });

  it("störst rest får öret, lika rest → först i listan", () => {
    // 10 × 1/3 = 3,33…, 10 × 2/3 = 6,67 → [3, 7]
    expect(allocateLargestRemainder(10, [1, 2])).toEqual([3, 7]);
    expect(allocateLargestRemainder(1, [5, 5])).toEqual([1, 0]);
  });

  it("vikter 0 → lika fördelning; tom lista", () => {
    expect(allocateLargestRemainder(10, [0, 0, 0])).toEqual([4, 3, 3]);
    expect(allocateLargestRemainder(0, [])).toEqual([]);
    expect(() => allocateLargestRemainder(5, [])).toThrow(DomainError);
  });

  it("delar med vikt 0 får inget när andra har vikt", () => {
    expect(allocateLargestRemainder(100, [0, 3, 0, 1])).toEqual([0, 75, 0, 25]);
  });

  it("negativt belopp", () => {
    expect(allocateLargestRemainder(-100, [1, 1, 1])).toEqual([-34, -33, -33]);
  });

  it("negativ vikt kastar", () => {
    expect(() => allocateLargestRemainder(10, [1, -1])).toThrow(DomainError);
  });

  it("stora belopp och vikter", () => {
    const parts = allocateLargestRemainder(9_000_000_000_000, [3_000_000_000_000, 1, 7]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(9_000_000_000_000);
  });

  it("egenskaper för 2 000 slumpade fall", () => {
    const r = rng(42);
    for (let i = 0; i < 2000; i++) {
      const n = r.int(1, 30);
      const weights = Array.from({ length: n }, () => (r.chance(0.2) ? 0 : r.int(0, 2_000_000)));
      const total = r.int(-5_000_000, 50_000_000);
      const parts = allocateLargestRemainder(total, weights);
      expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
      const W = weights.reduce((a, b) => a + b, 0);
      parts.forEach((p, k) => {
        // Varje del avviker högst 1 öre från den exakta andelen.
        const exact = W === 0 ? total / n : (total * weights[k]!) / W;
        expect(Math.abs(p - exact)).toBeLessThan(1 + 1e-6);
      });
    }
  });
});
