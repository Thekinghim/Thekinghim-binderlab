import { describe, expect, it } from "vitest";

import { createRandom } from "./random";

describe("createRandom", () => {
  it("samma frö ger samma följd", () => {
    const a = createRandom(42);
    const b = createRandom(42);
    const xs = Array.from({ length: 20 }, () => a.nextUint32());
    expect(Array.from({ length: 20 }, () => b.nextUint32())).toEqual(xs);
    expect(xs.every((x) => Number.isInteger(x) && x >= 0 && x < 2 ** 32)).toBe(true);
  });

  it("fast följd för frö 1 (regressionsvakt: ändras den ändras all seed-data)", () => {
    const r = createRandom(1);
    expect([r.nextUint32(), r.nextUint32(), r.nextUint32()]).toEqual([
      2_693_262_067, 11_749_833, 2_265_367_787,
    ]);
  });

  it("int, between, weighted och shuffle håller sina intervall", () => {
    const r = createRandom(7);
    for (let i = 0; i < 1000; i++) {
      const n = r.int(10);
      expect(n >= 0 && n < 10).toBe(true);
      const m = r.between(-3, 3);
      expect(m >= -3 && m <= 3).toBe(true);
      expect(r.weighted([0, 5, 0])).toBe(1);
    }
    const list = [1, 2, 3, 4, 5, 6];
    const shuffled = r.shuffle(list);
    expect([...shuffled].sort()).toEqual(list);
    expect(list).toEqual([1, 2, 3, 4, 5, 6]);
    expect(() => r.int(0)).toThrow();
    expect(() => r.weighted([0, 0])).toThrow();
    expect(() => r.weighted([1.5])).toThrow();
  });
});
