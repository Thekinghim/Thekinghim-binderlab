import { describe, expect, it } from "vitest";

import { toSafeInteger } from "./types";

describe("toSafeInteger", () => {
  it("tar emot heltal som tal, sträng (postgres bigint) och bigint", () => {
    expect(toSafeInteger(7900)).toBe(7900);
    expect(toSafeInteger("7900")).toBe(7900);
    expect(toSafeInteger("-125")).toBe(-125);
    expect(toSafeInteger(9_007_199_254_740_991n)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("kastar i stället för att tappa precision", () => {
    expect(() => toSafeInteger("9007199254740993")).toThrow(RangeError);
    expect(() => toSafeInteger(2n ** 60n)).toThrow(RangeError);
    expect(() => toSafeInteger(2 ** 60)).toThrow(RangeError);
  });

  it("kastar för flyttal och annat som inte är heltal", () => {
    expect(() => toSafeInteger(12.5)).toThrow(RangeError);
    expect(() => toSafeInteger(Number.NaN)).toThrow(RangeError);
    expect(() => toSafeInteger("12.5")).toThrow(TypeError);
    expect(() => toSafeInteger(null)).toThrow(TypeError);
  });
});
