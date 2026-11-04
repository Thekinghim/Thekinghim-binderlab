import { describe, expect, it } from "vitest";
import { DomainError, type OrderLine } from "@/domain";
import { detectPriceChanges, priceChangeEffect } from "./price-changes";
import { daily, ord, plain, sources } from "./test-fixtures";

const TITLES = [
  { id: "t-a", name: "30th Celebration" },
  { id: "t-b", name: "Paldea Evolved" },
];
const SRC = sources({ "t-a": 2_000, "t-b": 2_000 });

/**
 * 1 juni – 30 sep.: A 1/dag i m-1 och m-2 à 49 kr, B 2/dag i m-1 och m-2.
 * Från 1 okt. (28 dagar): A 59 kr, m-1 1/dag och m-2 varannan dag (42); B m-1 2/dag och m-2 3/dag (140).
 */
function scenario(): OrderLine[] {
  const start = "2026-06-01";
  const days = 122; // t.o.m. 30 sep.
  return [
    ...daily("a1", "t-a", "m-1", start, days, 1),
    ...daily("a2", "t-a", "m-2", start, days, 1),
    ...daily("b1", "t-b", "m-1", start, days, 2),
    ...daily("b2", "t-b", "m-2", start, days, 2),
    ...daily("A1", "t-a", "m-1", "2026-10-01", 28, 1, 5_900),
    ...daily("A2", "t-a", "m-2", "2026-10-01", 28, (d) => (d % 2 === 0 ? 1 : 0), 5_900),
    ...daily("B1", "t-b", "m-1", "2026-10-01", 28, 2),
    ...daily("B2", "t-b", "m-2", "2026-10-01", 28, 3),
  ];
}

describe("detectPriceChanges", () => {
  it("hittar höjningen när det nya priset är vanligast 3 dagar i rad", () => {
    const changes = detectPriceChanges(scenario(), { titles: TITLES });
    expect(changes).toHaveLength(1);
    const [c] = changes;
    expect(c).toMatchObject({
      titleId: "t-a",
      date: "2026-10-01",
      fromOre: 4_900,
      toOre: 5_900,
      changeBp: 2_041,
    });
    expect(c!.key).toBe("price-change:t-a:2026-10-01");
    expect(plain(c!.text)).toBe(
      "30th Celebration höjdes 1 okt. från 49,00 kr till 59,00 kr (+20 %).",
    );
    expect(c!.evidence.dates).toEqual(["2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03"]);
  });

  it("enstaka avvikande dag blir ingen ändring", () => {
    const orders = [
      ...daily("x", "t-a", "m-1", "2026-10-01", 10, 1),
      ord("blip", "t-a", "m-1", "2026-10-11", 9_900),
      ...daily("y", "t-a", "m-1", "2026-10-12", 10, 1),
    ];
    expect(detectPriceChanges(orders)).toEqual([]);
  });

  it("ett nytt pris som ännu inte hållit minDays dagar rapporteras inte", () => {
    const orders = [
      ...daily("x", "t-a", "m-1", "2026-10-01", 10, 1),
      ...daily("y", "t-a", "m-1", "2026-10-11", 2, 1, 5_900),
    ];
    expect(detectPriceChanges(orders)).toEqual([]);
    expect(detectPriceChanges(orders, { minDays: 2 })).toHaveLength(1);
  });

  it("sänkning och sedan höjning ger två ändringar", () => {
    const orders = [
      ...daily("x", "t-a", "m-1", "2026-10-01", 3, 1, 5_900),
      ...daily("y", "t-a", "m-1", "2026-10-04", 3, 1, 4_900),
      ...daily("z", "t-a", "m-1", "2026-10-07", 3, 1, 5_900),
    ];
    expect(detectPriceChanges(orders).map((c) => [c.date, c.toOre])).toEqual([
      ["2026-10-04", 4_900],
      ["2026-10-07", 5_900],
    ]);
  });

  it("filter på automat och titel", () => {
    expect(detectPriceChanges(scenario(), { machineIds: ["m-3"] })).toEqual([]);
    expect(detectPriceChanges(scenario(), { titleIds: ["t-b"] })).toEqual([]);
  });

  it("minDays under 1 kastar", () => {
    expect(() => detectPriceChanges([], { minDays: 0 })).toThrow(DomainError);
  });
});

describe("priceChangeEffect", () => {
  const base = {
    ...SRC,
    titleId: "t-a",
    changeDate: "2026-10-01",
    asOf: "2026-10-28",
    titles: TITLES,
  };

  it("difference-in-differences mot övriga titlar i samma automater", () => {
    const r = priceChangeEffect({ ...base, orders: scenario() });
    expect(r.control).toBe("titles");
    expect(r.windowDays).toBe(28);
    expect(r.before).toEqual({ start: "2026-09-03", end: "2026-09-30" });
    expect(r.after).toEqual({ start: "2026-10-01", end: "2026-10-28" });
    expect(r.machineIds).toEqual(["m-1", "m-2"]);
    expect([r.unitsBefore, r.unitsAfter, r.controlUnitsBefore, r.controlUnitsAfter]).toEqual([
      56, 42, 112, 140,
    ]);
    // väntat = 56 × 140 / 112 = 70; effekt = 42 / 70 − 1 = −40 %
    expect(r.expectedUnitsAfterTenths).toBe(700);
    expect(r.effectUnitsTenths).toBe(-280);
    expect(r.effectBp).toBe(-4_000);
    expect(r.priceChangeBp).toBe(2_041);
    // −4 000 / 2 041 = −1,96
    expect(r.elasticityHundredths).toBe(-196);
    // bidrag 2 410 före, 3 310 efter: (42 × 3 310 − 70 × 2 410) × 7 / 28
    expect([r.contributionPerPackBeforeOre, r.contributionPerPackAfterOre]).toEqual([2_410, 3_310]);
    expect(r.contributionEffectPerWeekOre).toBe(-7_420);
  });

  it("placeboperioder utan ändring ger noll variation och en tydlig slutsats", () => {
    const r = priceChangeEffect({ ...base, orders: scenario() });
    expect(r.placebos.map((p) => [p.changeDate, p.effectBp])).toEqual([
      ["2026-09-03", 0],
      ["2026-08-06", 0],
      ["2026-07-09", 0],
    ]);
    expect(r.noiseBp).toBe(0);
    expect(r.verdict).toBe("clear");
    expect(r.reasons).toEqual([]);
    expect(plain(r.text)).toBe(
      "Efter höjningen 1 okt. från 49,00 kr till 59,00 kr (+20 %) såldes 42 pack av 30th Celebration på 28 dagar, mot 56 de 28 dagarna före. Övriga titlar i samma automater ändrades +25 %, så utan ändringen väntades 70 pack. Effekt: −40 % (−28 pack), elasticitet −1,96. Bidrag: −74 kr/vecka. Vanlig variation (3 tidigare perioder): ±0 %. Slutsatsen är tydlig.",
    );
    expect(r.evidence.orderIds).toHaveLength(98);
    expect(r.evidence.machineIds).toEqual(["m-1", "m-2"]);
  });

  it("utan historik före: osäker, ingen placebo", () => {
    const orders = scenario().filter((o) => o.businessDate >= "2026-09-03");
    const r = priceChangeEffect({ ...base, orders });
    expect(r.placebos).toEqual([]);
    expect(r.noiseBp).toBeNull();
    expect(r.verdict).toBe("uncertain");
    expect(r.reasons).toContain("Ingen tidigare period att jämföra den vanliga variationen med.");
  });

  it("kort tid efter ändringen ger kortare fönster och osäker slutsats", () => {
    const r = priceChangeEffect({ ...base, orders: scenario(), asOf: "2026-10-14" });
    expect(r.windowDays).toBe(14);
    expect(r.before).toEqual({ start: "2026-09-17", end: "2026-09-30" });
    expect(r.unitsBefore).toBe(28);
    expect(r.unitsAfter).toBe(21);
    expect(r.verdict).toBe("uncertain");
    expect(plain(r.reasons[0]!)).toBe("Bara 14 dagar sedan ändringen (fönstret är 28).");
  });

  it("utan jämförelsegrupp räknas bara före och efter", () => {
    const orders = scenario().filter((o) => o.titleId === "t-a");
    const r = priceChangeEffect({ ...base, orders });
    expect(r.control).toBe("none");
    expect(r.effectBp).toBe(-2_500);
    expect(r.reasons).toContain("Ingen jämförelsegrupp: bara före och efter.");
  });

  it("excludeTitleIds tar bort titlar ur jämförelsegruppen", () => {
    const r = priceChangeEffect({ ...base, orders: scenario(), excludeTitleIds: ["t-b"] });
    expect(r.control).toBe("none");
  });

  it("underlag för jämförelsen: jämförelsegruppens order, titlar och placeboperioder", () => {
    const r = priceChangeEffect({ ...base, orders: scenario() });
    expect(r.controlTitleIds).toEqual(["t-b"]);
    expect(r.excludedTitleIds).toEqual([]);
    // 112 före + 140 efter
    expect(r.controlEvidence.orderIds).toHaveLength(252);
    expect(r.controlEvidence.titleIds).toEqual(["t-b"]);
    expect(r.controlEvidence.machineIds).toEqual(["m-1", "m-2"]);
    expect(r.controlEvidence.dates).toEqual([
      "2026-07-09",
      "2026-08-06",
      "2026-09-03",
      "2026-10-01",
    ]);
    expect(r.placeboWindows).toHaveLength(3);
    expect(r.placeboWindows[0]).toEqual({
      changeDate: "2026-09-03",
      before: { start: "2026-08-06", end: "2026-09-02" },
      after: { start: "2026-09-03", end: "2026-09-30" },
      unitsBefore: 56,
      unitsAfter: 56,
      controlUnitsBefore: 112,
      controlUnitsAfter: 112,
      effectBp: 0,
    });
    expect(r.placeboWindows.map((p) => p.effectBp)).toEqual(r.placebos.map((p) => p.effectBp));
  });

  it("övrig titel som själv bytte pris utesluts automatiskt ur jämförelsegruppen", () => {
    // t-c säljer 1/dag i m-1 och höjs 15 okt. (49 → 69 kr) med dubbel försäljning efter:
    // ingår den blir jämförelsegruppen 112 → 140 + 14 + 28 och effekten en annan.
    const orders = [
      ...scenario(),
      ...daily("c1", "t-c", "m-1", "2026-06-01", 136, 1),
      ...daily("c2", "t-c", "m-1", "2026-10-15", 14, 2, 6_900),
    ];
    const r = priceChangeEffect({ ...base, orders });
    expect(r.excludedTitleIds).toEqual(["t-c"]);
    expect(r.controlTitleIds).toEqual(["t-b"]);
    expect([r.controlUnitsBefore, r.controlUnitsAfter]).toEqual([112, 140]);
    expect(r.effectBp).toBe(-4_000);
    expect(plain(r.text)).toContain("Utanför jämförelsen: t-c.");
    const manual = priceChangeEffect({ ...base, orders, autoExcludePriceChanges: false });
    expect(manual.excludedTitleIds).toEqual([]);
    expect(manual.controlTitleIds).toEqual(["t-b", "t-c"]);
    expect(manual.controlUnitsAfter).toBe(140 + 14 + 28);
  });

  it("ändringen har inte börjat: too-early", () => {
    const r = priceChangeEffect({ ...base, orders: scenario(), asOf: "2026-09-30" });
    expect(r.verdict).toBe("too-early");
    expect(r.effectBp).toBeNull();
  });

  it("ingen försäljning efter: no-data", () => {
    const orders = scenario().filter(
      (o) => !(o.titleId === "t-a" && o.businessDate >= "2026-10-01"),
    );
    const r = priceChangeEffect({ ...base, orders });
    expect(r.verdict).toBe("no-data");
    expect(r.unitsBefore).toBe(0);
    expect(r.machineIds).toEqual([]);
  });

  it("pristest: samma titel i kontrollautomater som jämförelsegrupp", () => {
    const orders = [
      ...daily("t1", "t-a", "m-1", "2026-09-03", 28, 2),
      ...daily("c1", "t-a", "m-2", "2026-09-03", 28, 2),
      ...daily("T1", "t-a", "m-1", "2026-10-01", 28, (d) => (d % 2 === 0 ? 2 : 1), 5_400),
      ...daily("C1", "t-a", "m-2", "2026-10-01", 28, 2),
    ];
    const r = priceChangeEffect({
      ...base,
      orders,
      testMachineIds: ["m-1"],
      controlMachineIds: ["m-2"],
    });
    expect(r.control).toBe("machines");
    expect([r.unitsBefore, r.unitsAfter, r.controlUnitsBefore, r.controlUnitsAfter]).toEqual([
      56, 42, 56, 56,
    ]);
    expect(r.effectBp).toBe(-2_500);
    expect(r.evidence.machineIds).toEqual(["m-1", "m-2"]);
    expect(plain(r.text)).toContain("Samma titel i kontrollautomaterna (m-2) ändrades ±0 %");
  });

  it("test- och kontrollautomat får inte överlappa; testautomater krävs", () => {
    expect(() =>
      priceChangeEffect({
        ...base,
        orders: [],
        testMachineIds: ["m-1"],
        controlMachineIds: ["m-1"],
      }),
    ).toThrow(DomainError);
    expect(() =>
      priceChangeEffect({ ...base, orders: [], testMachineIds: [], controlMachineIds: ["m-2"] }),
    ).toThrow(DomainError);
  });

  it("ogiltiga datum och fönster kastar", () => {
    expect(() => priceChangeEffect({ ...base, orders: [], changeDate: "2026-02-30" })).toThrow(
      DomainError,
    );
    expect(() => priceChangeEffect({ ...base, orders: [], windowDays: 0 })).toThrow(DomainError);
  });
});

/**
 * Som produktionen: automaten startade 14 okt., Surging Sparks sänktes 5 kr 24 okt. medan
 * övriga titlar växte kraftigt (uppstart). Ingen skattning eller elasticitet ska visas som
 * en slutsats: "För tidigt att säga".
 */
describe("priceChangeEffect: nystartad automat och orimliga skattningar", () => {
  const SRC14 = {
    ...sources({ "t-a": 2_000, "t-b": 2_000 }),
    placements: [{ machineId: "m-1", storeId: "s-1", from: "2026-10-14", to: null }],
  };
  const orders = [
    ...daily("a", "t-a", "m-1", "2026-10-14", 10, 3, 12_500),
    ...daily("A", "t-a", "m-1", "2026-10-24", 10, 2, 12_000),
    ...daily("b", "t-b", "m-1", "2026-10-14", 10, 2),
    ...daily("B", "t-b", "m-1", "2026-10-24", 10, 6),
  ];
  const run = (placements = SRC14.placements) =>
    priceChangeEffect({
      ...SRC14,
      placements,
      orders,
      titleId: "t-a",
      changeDate: "2026-10-24",
      asOf: "2026-11-02",
      titles: TITLES,
    });

  it("före-fönstret i automatens första 28 dagar: för tidigt att säga", () => {
    const r = run();
    expect(r.verdict).toBe("too-early");
    expect(plain(r.reasons[0]!)).toMatch(/^För tidigt att säga: automaten startade 14 okt\./);
  });

  it("orimlig elasticitet (> 5) blir osäker även utan uppstart", () => {
    const r = run([{ machineId: "m-1", storeId: "s-1", from: "2025-01-01", to: null }]);
    expect(Math.abs(r.elasticityHundredths!)).toBeGreaterThan(500);
    expect(r.verdict).toBe("uncertain");
    expect(r.reasons).toContain("Skattningen är orimligt stor för en så liten prisändring.");
  });
});
