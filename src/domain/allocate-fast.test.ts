/**
 * Prestanda (fas 7): allocateLargestRemainder räknar med vanliga tal när det är exakt.
 * Svaret ska vara detsamma som bigint-vägen (allocateLargestRemainderBig) för alla indata.
 */

import { describe, expect, it } from "vitest";

import { allocateLargestRemainder, allocateLargestRemainderBig } from "./money";
import { rng } from "./testing/fixtures";

function viaBigint(total: number, weights: number[]): number[] {
  return allocateLargestRemainderBig(
    total,
    weights.map((w) => BigInt(w)),
  );
}

describe("allocateLargestRemainder (talväg)", () => {
  it("ger samma fördelning som bigint-vägen på slumpade indata", () => {
    const r = rng(4711);
    for (let k = 0; k < 3_000; k++) {
      const n = r.int(1, 40);
      const scale = r.pick([1, 10, 1_000, 1_000_000, 1_000_000_000, 4_000_000_000_000]);
      const weights = Array.from({ length: n }, () => (r.int(0, 4) === 0 ? 0 : r.int(0, scale)));
      const total = r.pick([0, 1, -1, 7, -999, 123_456, -5_000_000, 2_000_000_000]);
      expect(allocateLargestRemainder(total, weights), `${total} ${weights.join(",")}`).toEqual(
        viaBigint(total, weights),
      );
    }
  });

  it("stämmer vid gränsen för säkra heltal och med lika rester", () => {
    const max = Number.MAX_SAFE_INTEGER;
    const cases: Array<[number, number[]]> = [
      [100, [1, 1, 1]],
      [-100, [1, 1, 1]],
      [5, [0, 0, 0]],
      [-5, [0, 0]],
      [3, [max, 1]],
      [1, [Math.floor(max / 2), Math.floor(max / 2)]],
      [2, [Math.floor(max / 2), Math.floor(max / 2) + 1]],
      [97, [max - 1]],
      [1_000_000, [3, 3, 3, 3, 3, 3, 3]],
    ];
    for (const [total, weights] of cases) {
      expect(allocateLargestRemainder(total, weights)).toEqual(viaBigint(total, weights));
    }
  });

  it("kastar som förut för ogiltiga vikter och tomma listor", () => {
    expect(() => allocateLargestRemainder(1, [])).toThrow();
    expect(() => allocateLargestRemainder(0, [-1])).toThrow();
    expect(() => allocateLargestRemainder(1, [1.5])).toThrow();
    expect(allocateLargestRemainder(0, [])).toEqual([]);
  });
});
