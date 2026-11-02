import { describe, expect, it } from "vitest";
import { DomainError, type OrderLine } from "@/domain";
import { daily, MACHINES, ord, plain, sources } from "../pricing/test-fixtures";
import { assortmentFollowUp } from "./follow-up";
import { similarMachines, slotPerformance, type SlotAssignment } from "./performance";
import { recommendAssortment } from "./recommend";

const TITLES = [
  { id: "t-a", name: "30th Celebration" },
  { id: "t-b", name: "Paldea Evolved" },
  { id: "t-c", name: "Obsidian Flames" },
  { id: "t-d", name: "Surging Sparks" },
  { id: "t-e", name: "Okänd titel" },
];
const SRC = sources({ "t-a": 2_000, "t-b": 2_000, "t-c": 2_000, "t-d": 2_000 });
const OCT = { start: "2026-10-01", end: "2026-10-28" };

function slot(
  machineId: string,
  titleId: string,
  slots: number,
  from = "2026-09-01",
  to: string | null = null,
): SlotAssignment {
  return { machineId, titleId, slots, from, to };
}

/**
 * m-1 (4 fack): A 1 fack 2/dag (14/vecka), B 2 fack varannan dag (3,5/vecka), C 1 fack var 4:e dag (1,75/vecka).
 * m-2 (4 fack): A 1 fack 1/dag (7/vecka), D 3 fack 3/dag (21/vecka).
 * Bidrag 4 900 − 2 000 − 490 = 2 410 öre per pack.
 */
const ASSIGNMENTS = [
  slot("m-1", "t-a", 1),
  slot("m-1", "t-b", 2),
  slot("m-1", "t-c", 1),
  slot("m-2", "t-a", 1),
  slot("m-2", "t-d", 3),
];
function orders(): OrderLine[] {
  return [
    ...daily("1a", "t-a", "m-1", OCT.start, 28, 2),
    ...daily("1b", "t-b", "m-1", OCT.start, 28, (d) => (d % 2 === 0 ? 1 : 0)),
    ...daily("1c", "t-c", "m-1", OCT.start, 28, (d) => (d % 4 === 0 ? 1 : 0)),
    ...daily("2a", "t-a", "m-2", OCT.start, 28, 1),
    ...daily("2d", "t-d", "m-2", OCT.start, 28, 3),
  ];
}

const base = { ...SRC, machines: MACHINES, titles: TITLES, period: OCT, assignments: ASSIGNMENTS };

describe("slotPerformance", () => {
  it("exponering, fackdagar, efterfrågan och bidrag per pack", () => {
    const perf = slotPerformance({ ...base, orders: orders() });
    const b = perf.rows.find((r) => r.machineId === "m-1" && r.titleId === "t-b")!;
    expect(b).toMatchObject({
      currentSlots: 2,
      exposureDays: 28,
      slotDays: 56,
      units: 14,
      pricedUnits: 14,
    });
    expect(b.contributionOre).toBe(14 * 2_410);
    expect(b.demandPerWeek!.mul(2).round()).toBe(7);
    expect(b.contributionPerPack!.round()).toBe(2_410);
    // 14 × 70 / 56 = 17,5 → 1,8 pack per fack och vecka
    expect(b.unitsPerSlotWeekTenths).toBe(18);
    expect(perf.machines).toEqual([
      { machineId: "m-1", units: 77, slotDays: 112 },
      { machineId: "m-2", units: 112, slotDays: 112 },
    ]);
  });

  it("order på dagar utan fack räknas separat; för få exponeringsdagar ger ingen efterfrågan", () => {
    const perf = slotPerformance({
      ...base,
      assignments: [slot("m-1", "t-a", 1, "2026-10-20")],
      orders: daily("x", "t-a", "m-1", OCT.start, 28, 1),
    });
    const [a] = perf.rows;
    expect(a).toMatchObject({ exposureDays: 9, units: 9, unassignedUnits: 19 });
    expect(a!.demandPerWeek).toBeNull();
  });

  it("titel utan pris har inget bidrag per pack", () => {
    const perf = slotPerformance({
      ...base,
      assignments: [slot("m-1", "t-e", 1)],
      orders: daily("e", "t-e", "m-1", OCT.start, 28, 1),
    });
    expect(perf.rows[0]!.contributionPerPack).toBeNull();
    expect(perf.rows[0]!.pricedUnits).toBe(0);
  });

  it("överlappande fackperioder och negativa fack kastar", () => {
    expect(() =>
      slotPerformance({
        ...base,
        orders: [],
        assignments: [
          slot("m-1", "t-a", 1, "2026-09-01", "2026-10-10"),
          slot("m-1", "t-a", 2, "2026-10-10"),
        ],
      }),
    ).toThrow(DomainError);
    expect(() =>
      slotPerformance({ ...base, orders: [], assignments: [slot("m-1", "t-a", -1)] }),
    ).toThrow(DomainError);
    expect(() =>
      slotPerformance({
        ...base,
        orders: [],
        assignments: [slot("m-1", "t-a", 1, "2026-10-10", "2026-10-01")],
      }),
    ).toThrow(DomainError);
  });

  it("fackbyte mitt i perioden: fackdagar summeras per dag", () => {
    const perf = slotPerformance({
      ...base,
      orders: [],
      assignments: [
        slot("m-1", "t-a", 1, "2026-09-01", "2026-10-14"),
        slot("m-1", "t-a", 3, "2026-10-15"),
      ],
    });
    expect(perf.rows[0]).toMatchObject({
      slotDays: 14 + 14 * 3,
      exposureDays: 28,
      currentSlots: 3,
    });
  });
});

describe("similarMachines", () => {
  it("samma mix = 10 000, inga gemensamma titlar = 0, mest lik först", () => {
    const rows = slotPerformance({
      ...base,
      assignments: [],
      orders: [
        ...daily("1", "t-a", "m-1", OCT.start, 2, 1),
        ...daily("2", "t-a", "m-2", OCT.start, 4, 1),
        ...daily("3", "t-b", "m-3", OCT.start, 2, 1),
        ...daily("4a", "t-a", "m-4", OCT.start, 1, 1),
        ...daily("4b", "t-b", "m-4", OCT.start, 1, 1),
      ],
    }).rows;
    expect(similarMachines(rows, "m-1")).toEqual([
      { machineId: "m-2", similarityBp: 10_000 },
      { machineId: "m-4", similarityBp: 5_000 },
      { machineId: "m-3", similarityBp: 0 },
    ]);
    expect(similarMachines(rows, "m-1", 1)).toHaveLength(1);
    expect(similarMachines(rows, "m-9")).toEqual([]);
  });
});

describe("recommendAssortment", () => {
  it("fack delas där nästa fack ger mest bidrag; ny titel från liknande automat", () => {
    const [m1] = recommendAssortment({ ...base, orders: orders() });
    expect(m1!.machineId).toBe("m-1");
    expect(m1!.action).toBe("change");
    expect(m1!.capacity).toBe(4);
    expect(m1!.similar).toEqual([{ machineId: "m-2", similarityBp: 2_500 }]);
    expect(
      m1!.lines.map((l) => [
        l.titleId,
        l.currentSlots,
        l.recommendedSlots,
        l.source,
        l.demandPerWeekTenths,
      ]),
    ).toEqual([
      ["t-a", 1, 2, "observed", 140],
      // 21 × (77/112) / (112/112) = 14,4
      ["t-d", 0, 2, "similar", 144],
      ["t-b", 2, 0, "observed", 35],
      ["t-c", 1, 0, "observed", 18],
    ]);
    expect(m1!.changes.map((c) => [c.titleId, c.kind, c.effectPerWeekOre])).toEqual([
      ["t-d", "add", 34_794],
      ["t-a", "increase", 9_640],
      ["t-c", "remove", -4_218],
      ["t-b", "remove", -8_435],
    ]);
    // 68 534,375 − 36 752,5
    expect(m1!.effectPerWeekOre).toBe(31_782);
    expect(m1!.fingerprint).toBe("t-a:2,t-d:2");
    expect(plain(m1!.text)).toBe(
      [
        "Automat 1: 4 ändringar i 4 fack, väntad effekt +318 kr/vecka.",
        "Lägg till Surging Sparks i 2 fack: väntas sälja 14,4 pack/vecka här, enligt Automat 2 justerat för platsens nivå; 24,10 kr kvar per pack ger +348 kr/vecka.",
        "Ge 30th Celebration 2 fack i stället för 1: säljer 14 pack/vecka men 1 fack rymmer 10 pack/vecka; +96 kr/vecka.",
        "Ta bort Obsidian Flames (1 fack): säljer 1,8 pack/vecka med 24,10 kr kvar per pack, −42 kr/vecka; facken gör mer nytta för andra titlar.",
        "Ta bort Paldea Evolved (2 fack): säljer 3,5 pack/vecka med 24,10 kr kvar per pack, −84 kr/vecka; facken gör mer nytta för andra titlar.",
      ].join(" "),
    );
    expect(m1!.evidence.machineIds).toEqual(["m-1", "m-2"]);
    expect(m1!.evidence.titleIds).toEqual(["t-a", "t-b", "t-c", "t-d"]);
  });

  it("avtagande nytta: ett fack mindre när efterfrågan ryms, ny titel tar platsen", () => {
    const [, m2] = recommendAssortment({ ...base, orders: orders() });
    expect(m2!.lines.map((l) => [l.titleId, l.currentSlots, l.recommendedSlots])).toEqual([
      ["t-d", 3, 2],
      ["t-a", 1, 1],
      ["t-b", 0, 1],
      ["t-c", 0, 0],
    ]);
    expect(m2!.changes.map((c) => [c.titleId, c.kind])).toEqual([
      ["t-b", "add"],
      ["t-d", "decrease"],
    ]);
    expect(m2!.effectPerWeekOre).toBe(9_859);
    expect(plain(m2!.changes[1]!.text)).toBe(
      "Minska Surging Sparks till 2 fack (från 3): 21 pack/vecka ryms, −24 kr/vecka.",
    );
  });

  it("under minsta effekt: behåll sortimentet", () => {
    const [m1] = recommendAssortment({
      ...base,
      orders: orders(),
      options: { minEffectPerWeekOre: 50_000 },
    });
    expect(m1!.action).toBe("keep");
    expect(m1!.changes).toEqual([]);
    expect(m1!.effectPerWeekOre).toBe(0);
    expect(m1!.potentialEffectPerWeekOre).toBe(31_782);
    expect(plain(m1!.text)).toBe(
      "Automat 1: behåll sortimentet; bästa omfördelningen ger bara +318 kr/vecka (gräns +500 kr).",
    );
  });

  it("behåll: raderna, fingerprint och lediga fack visar nuvarande fördelning", () => {
    const [m1] = recommendAssortment({
      ...base,
      orders: orders(),
      options: { minEffectPerWeekOre: 50_000 },
    });
    expect(m1!.action).toBe("keep");
    expect(
      m1!.lines.map((l) => [l.titleId, l.currentSlots, l.recommendedSlots, l.potentialSlots]),
    ).toEqual([
      ["t-b", 2, 2, 0],
      ["t-a", 1, 1, 2],
      ["t-c", 1, 1, 0],
      ["t-d", 0, 0, 2],
    ]);
    for (const l of m1!.lines) {
      expect(l.recommendedContributionPerWeekOre).toBe(l.currentContributionPerWeekOre);
    }
    expect(m1!.fingerprint).toBe("t-a:1,t-b:2,t-c:1");
    expect(m1!.freeSlots).toBe(0);
  });

  it("titlar utan pris eller med för lite data är låsta och behåller sina fack", () => {
    const [m1] = recommendAssortment({
      ...base,
      machineIds: ["m-1"],
      assignments: [...ASSIGNMENTS, slot("m-1", "t-e", 1), slot("m-1", "t-f", 1, "2026-10-20")],
      orders: [
        ...orders(),
        ...daily("1e", "t-e", "m-1", OCT.start, 28, 5),
        ...daily("1f", "t-f", "m-1", "2026-10-20", 9, 1),
      ],
    });
    expect(m1!.capacity).toBe(6);
    const locked = m1!.lines
      .filter((l) => l.locked)
      .map((l) => [l.titleId, l.locked, l.recommendedSlots]);
    expect(locked).toEqual([
      ["t-e", "missing-price", 1],
      ["t-f", "too-little-data", 1],
    ]);
    expect(plain(m1!.text)).toContain(
      "Oförändrade: Okänd titel (saknar inköpspris) och t-f (under 14 dagar i automaten).",
    );
  });

  it("större kapacitet: lediga fack när ingen titel behöver fler", () => {
    const [m2] = recommendAssortment({
      ...base,
      orders: orders(),
      machineIds: ["m-2"],
      similarMachineIds: { "m-2": [] },
      capacityByMachine: { "m-2": 8 },
    });
    // D behöver 3 fack (21/vecka), A 1 fack → 4 av 8
    expect(m2!.freeSlots).toBe(4);
    expect(m2!.action).toBe("keep");
    expect(plain(m2!.text)).toContain("4 fack står lediga");
  });

  it("valda liknande automater ersätter likheten", () => {
    const [m1] = recommendAssortment({
      ...base,
      orders: orders(),
      machineIds: ["m-1"],
      similarMachineIds: { "m-1": [] },
    });
    expect(m1!.lines.map((l) => l.titleId)).not.toContain("t-d");
  });

  it("titel med förlust per pack får inga fack", () => {
    const [m1] = recommendAssortment({
      ...base,
      ...sources({ "t-a": 2_000, "t-b": 9_000, "t-c": 2_000, "t-d": 2_000 }),
      orders: orders(),
      machineIds: ["m-1"],
    });
    expect(m1!.lines.find((l) => l.titleId === "t-b")!.recommendedSlots).toBe(0);
  });

  it("ogiltiga inställningar kastar", () => {
    expect(() =>
      recommendAssortment({ ...base, orders: [], options: { slotCapacity: 0 } }),
    ).toThrow(DomainError);
    expect(() =>
      recommendAssortment({
        ...base,
        orders: [],
        period: { start: "2026-10-28", end: "2026-10-01" },
      }),
    ).toThrow(DomainError);
  });
});

describe("assortmentFollowUp", () => {
  const followOrders = (othersAfterPerDay: number): OrderLine[] => [
    ...daily("b1", "t-a", "m-1", "2026-10-04", 28, 2),
    ...daily("a1", "t-a", "m-1", "2026-11-01", 28, 3),
    ...daily("b2", "t-a", "m-2", "2026-10-04", 28, 1),
    ...daily("a2", "t-a", "m-2", "2026-11-01", 28, othersAfterPerDay),
    ord("u1", "t-e", "m-1", "2026-11-02"),
  ];
  const fb = {
    ...SRC,
    machineId: "m-1",
    implementedOn: "2026-11-01",
    asOf: "2026-11-28",
    machines: MACHINES,
    titles: TITLES,
  };

  it("samma längd före och efter; justerat med övriga automater; mot väntad effekt", () => {
    const r = assortmentFollowUp({
      ...fb,
      orders: followOrders(1),
      expectedEffectPerWeekOre: 20_000,
      changedTitleIds: ["t-a"],
    });
    expect(r.status).toBe("done");
    expect(r.before).toEqual({ start: "2026-10-04", end: "2026-10-31" });
    expect(r.after).toEqual({ start: "2026-11-01", end: "2026-11-28" });
    expect([r.unitsBefore, r.unitsAfter, r.unpricedAfter]).toEqual([56, 85, 1]);
    expect(r.contributionPerWeekBeforeOre).toBe(33_740);
    expect(r.contributionPerWeekAfterOre).toBe(50_610);
    expect(r.changePerWeekOre).toBe(16_870);
    expect(r.controlChangeBp).toBe(0);
    expect(r.adjustedChangePerWeekOre).toBe(16_870);
    expect(r.achievedBp).toBe(8_435);
    expect(r.titles).toEqual([{ titleId: "t-a", unitsBefore: 56, unitsAfter: 84 }]);
    expect(plain(r.text)).toBe(
      "Automat 1 28 dagar före och efter ändringen 1 nov.: bidraget gick från 337 kr/vecka till 506 kr/vecka (+169 kr), 56 → 85 pack. Övriga automater ändrades ±0 % under samma dagar; justerat +169 kr/vecka. Väntad effekt var +200 kr/vecka: 84 % uppnått. 30th Celebration 56 → 84 pack. 1 order saknar inköpspris och ingår inte i bidraget.",
    );
  });

  it("när övriga automater växer lika mycket blir justerad effekt mindre", () => {
    const r = assortmentFollowUp({ ...fb, orders: followOrders(2) });
    expect(r.controlChangeBp).toBe(10_000);
    // 50 610 − 33 740 × 2
    expect(r.adjustedChangePerWeekOre).toBe(-16_870);
    expect(r.achievedBp).toBeNull();
  });

  it("valda kontrollautomater; utan kontrollbidrag används ojusterad förändring", () => {
    const r = assortmentFollowUp({ ...fb, orders: followOrders(2), controlMachineIds: ["m-3"] });
    expect(r.controlChangeBp).toBeNull();
    expect(r.adjustedChangePerWeekOre).toBe(16_870);
  });

  it("underlaget visar jämförelseautomaterna och deras order", () => {
    const r = assortmentFollowUp({ ...fb, orders: followOrders(2) });
    expect(r.evidence.machineIds).toEqual(["m-1", "m-2"]);
    // Egna order: 56 före + 85 efter.
    expect(r.evidence.orderIds).toHaveLength(141);
    expect(r.control).toEqual({
      machineIds: ["m-2"],
      unitsBefore: 28,
      unitsAfter: 56,
      contributionPerWeekBeforeOre: 16_870,
      contributionPerWeekAfterOre: 33_740,
    });
    expect(r.controlEvidence.machineIds).toEqual(["m-2"]);
    expect(r.controlEvidence.orderIds).toHaveLength(84);
    expect(r.controlEvidence.period).toEqual({ start: "2026-10-04", end: "2026-11-28" });
    expect(r.evidence.figures.map((f) => f.key)).toContain("controlContributionPerWeekBeforeOre");
    // Valda kontrollautomater utan order: tom jämförelse.
    const none = assortmentFollowUp({ ...fb, orders: followOrders(2), controlMachineIds: ["m-3"] });
    expect(none.control.machineIds).toEqual([]);
    expect(none.evidence.machineIds).toEqual(["m-1"]);
  });

  it("status efter hur många dagar som gått", () => {
    expect(assortmentFollowUp({ ...fb, orders: followOrders(1), asOf: "2026-10-31" }).status).toBe(
      "not-started",
    );
    const early = assortmentFollowUp({ ...fb, orders: followOrders(1), asOf: "2026-11-05" });
    expect(early.status).toBe("too-early");
    expect(early.windowDays).toBe(5);
    expect(early.before).toEqual({ start: "2026-10-27", end: "2026-10-31" });
    expect(assortmentFollowUp({ ...fb, orders: followOrders(1), asOf: "2026-11-14" }).status).toBe(
      "running",
    );
  });

  it("ogiltig indata kastar", () => {
    expect(() => assortmentFollowUp({ ...fb, orders: [], windowDays: 0 })).toThrow(DomainError);
    expect(() => assortmentFollowUp({ ...fb, orders: [], expectedEffectPerWeekOre: 1.5 })).toThrow(
      DomainError,
    );
  });
});
