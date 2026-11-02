import { describe, expect, it } from "vitest";
import { DomainError, MONTH_LCM, type LedgerEntry } from "@/domain";
import {
  assertNonNegative,
  assertRateBp,
  hundredths,
  monthUnits,
  orderTrail,
  perMachineMonth,
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

describe("weightedMean, automatmånader och orderspår", () => {
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
  it("automatmånader följer domänens regel: dagar / dagar i kalendermånaden", () => {
    expect(monthUnits({ start: "2026-10-01", end: "2026-10-31" })).toBe(MONTH_LCM);
    expect(monthUnits({ start: "2026-02-01", end: "2026-02-28" })).toBe(MONTH_LCM);
    expect(monthUnits({ start: "2026-11-16", end: "2026-11-30" })).toBe(MONTH_LCM / 2);
    // 20 okt.–10 nov.: 12/31 + 10/30
    expect(monthUnits({ start: "2026-10-20", end: "2026-11-10" })).toBe(
      (12 * MONTH_LCM) / 31 + (10 * MONTH_LCM) / 30,
    );
  });
  it("per automatmånad: en hel månad ger beloppet, en halv dubbla", () => {
    expect(perMachineMonth(74_710, MONTH_LCM).round()).toBe(74_710);
    expect(perMachineMonth(1_000, MONTH_LCM / 2).round()).toBe(2_000);
    expect(() => perMachineMonth(1, 0)).toThrow(DomainError);
  });
  it("orderspåret filtrerar på butik, automat och prissatta order", () => {
    const entry = (id: string, storeId: string, machineId: string, d: string, priced = true) =>
      ({ order: { id, machineId, businessDate: d }, storeId, priced }) as unknown as LedgerEntry;
    const entries = [
      entry("o-2", "s-1", "m-1", "2026-10-02"),
      entry("o-1", "s-1", "m-1", "2026-10-01", false),
      entry("o-3", "s-2", "m-2", "2026-10-01"),
    ];
    expect(orderTrail(entries)).toEqual({
      orderIds: ["o-1", "o-2", "o-3"],
      dates: ["2026-10-01", "2026-10-02"],
    });
    expect(orderTrail(entries, { storeId: "s-1", pricedOnly: true })).toEqual({
      orderIds: ["o-2"],
      dates: ["2026-10-02"],
    });
    expect(orderTrail(entries, { machineId: "m-2" }).orderIds).toEqual(["o-3"]);
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
