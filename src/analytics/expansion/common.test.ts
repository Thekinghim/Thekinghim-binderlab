import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain";
import {
  assertNonNegative,
  assertRateBp,
  hundredths,
  perMonth,
  Ratio,
  scenarioEvidence,
  signedKr,
  signedPct,
  weightedMean,
} from "./common";

describe("Ratio", () => {
  it("förkortar och håller nämnaren positiv", () => {
    const r = new Ratio(6, -4);
    expect([r.num, r.den]).toEqual([-3n, 2n]);
  });
  it("räknar exakt och avrundar halva bort från noll", () => {
    expect(new Ratio(5, 2).round()).toBe(3);
    expect(new Ratio(-5, 2).round()).toBe(-3);
    expect(new Ratio(1, 3).add(new Ratio(1, 6)).round()).toBe(1); // 0,5 → 1
    expect(new Ratio(1, 3).sub(new Ratio(1, 2)).sign()).toBe(-1);
    expect(new Ratio(7).mul(new Ratio(1, 7)).compare(new Ratio(1))).toBe(0);
    expect(new Ratio(10).div(4).round()).toBe(3);
  });
  it("stora tal utan avrundningsfel", () => {
    const big = new Ratio(2n ** 70n, 3n).mul(3);
    expect(big.num).toBe(2n ** 70n);
  });
  it("kastar för nämnare 0 och decimaltal", () => {
    expect(() => new Ratio(1, 0)).toThrow(DomainError);
    expect(() => new Ratio(1).div(0)).toThrow(DomainError);
    expect(() => new Ratio(1.5)).toThrow(DomainError);
  });
});

describe("weightedMean och perMonth", () => {
  it("viktat snitt", () => {
    const m = weightedMean([
      { value: new Ratio(100), weight: 3 },
      { value: new Ratio(200), weight: 1 },
    ]);
    expect(m.round()).toBe(125);
  });
  it("kastar när vikterna summerar till 0", () => {
    expect(() => weightedMean([{ value: new Ratio(1), weight: 0 }])).toThrow(DomainError);
  });
  it("per månad = per dag × 365 / 12", () => {
    expect(perMonth(new Ratio(1200)).round()).toBe(36_500);
  });
});

describe("text", () => {
  it("signedKr", () => {
    expect(signedKr(124_000)).toBe("+1 240 kr");
    expect(signedKr(-35_000)).toBe("−350 kr");
    expect(signedKr(49)).toBe("±0 kr");
  });
  it("signedPct", () => {
    expect(signedPct(2_312)).toBe("+23 %");
    expect(signedPct(-500)).toBe("−5 %");
    expect(signedPct(49)).toBe("±0 %");
  });
  it("hundredths", () => {
    expect(hundredths(-150)).toBe("−1,5");
    expect(hundredths(-125)).toBe("−1,25");
    expect(hundredths(-200)).toBe("−2");
    expect(hundredths(5)).toBe("0,05");
    expect(hundredths(0)).toBe("0");
  });
});

describe("kontroller och underlag", () => {
  it("assertNonNegative och assertRateBp", () => {
    expect(() => assertNonNegative(-1, "X")).toThrow(DomainError);
    expect(() => assertNonNegative(0, "X")).not.toThrow();
    expect(() => assertRateBp(10_001, "X")).toThrow(DomainError);
    expect(() => assertRateBp(10_000, "X")).not.toThrow();
  });
  it("scenarioEvidence sorterar och tar bort dubbletter", () => {
    const e = scenarioEvidence({
      rule: "r",
      storeIds: ["s-2", "s-1", "s-2"],
      dates: ["2026-10-02", "2026-10-01"],
      figures: [{ key: "k", label: "l", value: 1, unit: "minutes" }],
    });
    expect(e.storeIds).toEqual(["s-1", "s-2"]);
    expect(e.dates).toEqual(["2026-10-01", "2026-10-02"]);
    expect(e.orderIds).toEqual([]);
    expect(e.period).toBeNull();
    expect(e.figures[0]!.unit).toBe("minutes");
  });
});
