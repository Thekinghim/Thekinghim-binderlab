import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain";
import { Ratio } from "../expansion/common";
import { median, medianAbsoluteDeviation, robustZ } from "./robust";

describe("median", () => {
  it("udda antal: mittvärdet oavsett ordning", () => {
    expect(median([3, 1, 2])!.round()).toBe(2);
  });

  it("jämnt antal: snittet av de två mittersta, exakt bråk", () => {
    const m = median([1, 2, 3, 10])!;
    expect([m.num, m.den]).toEqual([5n, 2n]);
  });

  it("tom lista ger null", () => {
    expect(median([])).toBeNull();
  });

  it("påverkas inte av ett extremt värde", () => {
    expect(median([2_800, 2_900, 3_000, 1_000_000])!.round()).toBe(2_950);
  });

  it("tar bråk", () => {
    expect(
      median([new Ratio(1, 2), new Ratio(1, 3), new Ratio(3, 4)])!.compare(new Ratio(1, 2)),
    ).toBe(0);
  });

  it("flyttal kastar", () => {
    expect(() => median([1.5])).toThrow(DomainError);
  });
});

describe("medianAbsoluteDeviation", () => {
  it("median av absoluta avvikelser", () => {
    // median 3; avvikelser 2, 1, 0, 1, 97 → 1
    expect(medianAbsoluteDeviation([1, 2, 3, 4, 100])!.round()).toBe(1);
  });

  it("alla lika ger 0", () => {
    expect(medianAbsoluteDeviation([5, 5, 5])!.sign()).toBe(0);
  });

  it("tom lista ger null", () => {
    expect(medianAbsoluteDeviation([])).toBeNull();
  });
});

describe("robustZ", () => {
  it("0,6745 × (x − median) / MAD", () => {
    const z = robustZ(3_600, new Ratio(2_900), new Ratio(100))!;
    // 0,6745 × 700 / 100 = 4,7215
    expect(z.compare(new Ratio(47_215, 10_000))).toBe(0);
  });

  it("negativt under medianen", () => {
    expect(robustZ(2_500, new Ratio(2_900), new Ratio(100))!.sign()).toBe(-1);
  });

  it("MAD 0 ger null", () => {
    expect(robustZ(3_000, new Ratio(2_900), new Ratio(0))).toBeNull();
  });
});
