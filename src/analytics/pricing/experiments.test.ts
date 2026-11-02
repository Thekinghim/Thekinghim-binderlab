import { describe, expect, it } from "vitest";
import { DomainError, type OrderLine } from "@/domain";
import { proposePriceTests } from "./experiments";
import { priceChangeEffect } from "./price-changes";
import { daily, MACHINES, plain, sources } from "./test-fixtures";

const TITLES = [
  { id: "t-a", name: "30th Celebration" },
  { id: "t-b", name: "Paldea Evolved" },
];
const SRC = sources({ "t-a": 2_000, "t-b": 1_000, "t-c": 2_000, "t-d": 2_000, "t-f": 2_000 });
const START = "2026-10-01";

/** 1–28 okt. */
function orders(): OrderLine[] {
  return [
    ...daily("a1", "t-a", "m-1", START, 28, 3),
    ...daily("a2", "t-a", "m-2", START, 28, 2),
    ...daily("a3", "t-a", "m-3", START, 28, 2),
    ...daily("a4", "t-a", "m-4", START, 28, 1),
    ...daily("b1", "t-b", "m-1", START, 28, 2),
    ...daily("b2", "t-b", "m-2", START, 28, 1),
    // Bara en automat.
    ...daily("c1", "t-c", "m-1", START, 28, 3),
    // För lite volym: 28 pack → 14 per grupp.
    ...daily("d1", "t-d", "m-1", START, 28, (d) => (d % 2 === 0 ? 1 : 0)),
    ...daily("d2", "t-d", "m-2", START, 28, (d) => (d % 2 === 0 ? 1 : 0)),
    // Saknar inköpspris.
    ...daily("e1", "t-e", "m-1", START, 28, 2),
    ...daily("e2", "t-e", "m-2", START, 28, 2),
    // Priset ändrades 1 okt.
    ...daily("f0", "t-f", "m-1", "2026-09-01", 30, 2),
    ...daily("f1", "t-f", "m-1", START, 28, 2, 5_400),
    ...daily("f2", "t-f", "m-2", START, 28, 2, 5_400),
  ];
}

const base = { ...SRC, asOf: "2026-10-28", titles: TITLES, machines: MACHINES };

describe("proposePriceTests", () => {
  it("bara titlar med volym, flera automater, känt bidrag och utan nylig prisändring", () => {
    const tests = proposePriceTests({ ...base, orders: orders() });
    expect(tests.map((t) => [t.titleId, t.direction])).toEqual([
      ["t-a", "up"],
      ["t-b", "down"],
    ]);
  });

  it("höjning för titlar som säljer minst som medianen, med brytpunkt och ABBA-fördelning", () => {
    const [a] = proposePriceTests({ ...base, orders: orders() });
    expect(a!.experiment).toBe(true);
    expect(a!.label).toBe("Experiment");
    expect(a!.key).toBe("price-test:t-a:up:2026-10-29");
    expect([a!.fromOre, a!.toOre]).toEqual([4_900, 5_400]);
    // m-1 84, m-2 56, m-3 56, m-4 28 → test, kontroll, kontroll, test
    expect(a!.testMachineIds).toEqual(["m-1", "m-4"]);
    expect(a!.controlMachineIds).toEqual(["m-2", "m-3"]);
    expect(a!.period).toEqual({ start: "2026-10-29", end: "2026-11-25" });
    expect([a!.expectedTestUnits, a!.expectedControlUnits]).toEqual([112, 112]);
    // bidrag 4 900 − 2 000 − 490 = 2 410; med 54 kr 5 400 − 2 000 − 540 = 2 860
    expect([a!.contributionPerPackOre, a!.newContributionPerPackOre]).toEqual([2_410, 2_860]);
    // 2 410 / 2 860 − 1 = −15,7 %
    expect(a!.breakEvenVolumeChangeBp).toBe(-1_573);
    expect(a!.unitsPerWeekTenths).toBe(560);
    expect(a!.weeklyContributionOre).toBe(134_960);
    expect(plain(a!.text)).toBe(
      "Experiment: höj 30th Celebration från 49,00 kr till 54,00 kr i Automat 1 och Automat 4 under 4 veckor (29 okt. – 25 nov.); Automat 2 och Automat 3 behåller 49,00 kr som kontroll. Höjningen lönar sig om försäljningen minskar mindre än 16 %. Titeln säljer 56 pack/vecka med 24,10 kr kvar per pack (28,60 kr med nytt pris).",
    );
    expect(a!.evidence.orderIds).toHaveLength(224);
  });

  it("sänkning för titlar under medianen med bidrag minst 2 × steget", () => {
    const [, b] = proposePriceTests({ ...base, orders: orders() });
    expect([b!.fromOre, b!.toOre]).toEqual([4_900, 4_400]);
    // 3 410 / 2 960 − 1 = +15,2 %
    expect(b!.breakEvenVolumeChangeBp).toBe(1_520);
    expect(b!.testMachineIds).toEqual(["m-1"]);
    expect(b!.controlMachineIds).toEqual(["m-2"]);
    expect(plain(b!.text)).toContain("Sänkningen lönar sig om försäljningen ökar mer än 15 %.");
  });

  it("maxTests begränsar till de med mest bidrag per vecka", () => {
    expect(
      proposePriceTests({ ...base, orders: orders(), maxTests: 1 }).map((t) => t.titleId),
    ).toEqual(["t-a"]);
    expect(proposePriceTests({ ...base, orders: orders(), maxTests: 0 })).toEqual([]);
  });

  it("quietDays 0 släpper in titeln vars pris nyss ändrades", () => {
    const ids = proposePriceTests({ ...base, orders: orders(), quietDays: 0, maxTests: 10 }).map(
      (t) => t.titleId,
    );
    expect(ids).toContain("t-f");
  });

  it("minUnitsPerArm styr vilka titlar som har volym nog", () => {
    const ids = proposePriceTests({
      ...base,
      orders: orders(),
      minUnitsPerArm: 14,
      maxTests: 10,
    }).map((t) => t.titleId);
    expect(ids).toContain("t-d");
  });

  it("ingen data ger inga förslag; ogiltiga inställningar kastar", () => {
    expect(proposePriceTests({ ...base, orders: [] })).toEqual([]);
    expect(() => proposePriceTests({ ...base, orders: [], stepOre: 0 })).toThrow(DomainError);
    expect(() => proposePriceTests({ ...base, orders: [], asOf: "2026-10-32" })).toThrow(
      DomainError,
    );
  });

  it("utvärderingen kan matas direkt in i priceChangeEffect", () => {
    const [a] = proposePriceTests({ ...base, orders: orders(), maxTests: 1 });
    const ev = a!.evaluation;
    // Under testet: testautomaterna säljer 25 % färre (84 i stället för 112), kontrollen som förut.
    const during = [
      ...daily("T1", "t-a", "m-1", ev.changeDate, 28, (d) => (d % 4 === 0 ? 1 : 2), 5_400),
      ...daily("T4", "t-a", "m-4", ev.changeDate, 28, (d) => (d % 4 === 0 ? 1 : 1), 5_400),
      ...daily("C2", "t-a", "m-2", ev.changeDate, 28, 2),
      ...daily("C3", "t-a", "m-3", ev.changeDate, 28, 2),
    ];
    const r = priceChangeEffect({
      ...SRC,
      ...ev,
      orders: [...orders(), ...during],
      asOf: "2026-11-25",
    });
    expect(r.control).toBe("machines");
    expect(r.unitsBefore).toBe(112);
    expect(r.unitsAfter).toBe(77);
    expect(r.controlUnitsBefore).toBe(112);
    expect(r.controlUnitsAfter).toBe(112);
    // 77 / 112 − 1 = −31,25 %: större minskning än brytpunkten 15,7 %
    expect(r.effectBp).toBe(-3_125);
    expect(r.contributionEffectPerWeekOre).toBeLessThan(0);
  });
});
