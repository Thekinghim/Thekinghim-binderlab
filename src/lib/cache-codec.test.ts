import { describe, expect, it } from "vitest";

import { NotCacheableError, decodeFromCache, encodeForCache } from "./cache-codec";

/** Som datacachen: kodat, sparat som JSON och läst tillbaka. */
const roundTrip = (v: unknown) => decodeFromCache(JSON.parse(JSON.stringify(encodeForCache(v))));

describe("cache-codec", () => {
  it("ger tillbaka samma värde genom JSON", () => {
    const value = {
      a: 1,
      s: "text",
      b: false,
      n: null,
      u: undefined,
      nan: Number.NaN,
      inf: Number.POSITIVE_INFINITY,
      neg: Number.NEGATIVE_INFINITY,
      list: [1, undefined, { x: 2 }],
      map: new Map<string, unknown>([
        ["k", { y: new Set([1, 2]) }],
        ["l", [new Map([[1, "en"]])]],
      ]),
      date: new Date("2026-11-26T10:00:00.000Z"),
      nested: { $c: "u", v: 3 },
    };
    const back = roundTrip(value) as typeof value;
    expect(back).toEqual(value);
    expect(back.map).toBeInstanceOf(Map);
    expect((back.map.get("k") as { y: Set<number> }).y).toBeInstanceOf(Set);
    expect(back.date).toBeInstanceOf(Date);
    expect("u" in back).toBe(true);
    expect(back.nested).toEqual({ $c: "u", v: 3 });
  });

  it("vägrar klassinstanser, funktioner och bigint", () => {
    class Box {
      v = 1;
    }
    expect(() => encodeForCache({ b: new Box() })).toThrow(NotCacheableError);
    expect(() => encodeForCache({ f: () => 1 })).toThrow(NotCacheableError);
    expect(() => encodeForCache({ n: BigInt(1) })).toThrow(NotCacheableError);
  });

  it("tål objekt utan prototyp", () => {
    const o = Object.create(null) as Record<string, number>;
    o.x = 1;
    expect(roundTrip(o)).toEqual({ x: 1 });
  });
});
