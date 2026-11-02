import { describe, expect, it } from "vitest";
import { DomainError, type OrderLine } from "@/domain";
import { daily, machine, ord, plain } from "../pricing/test-fixtures";
import { releaseCurve, releaseProfiles } from "./curve";
import { releaseOutcome } from "./outcome";
import { suggestReleasePurchase } from "./suggest";

const MACHINES = [machine("m-1"), machine("m-2"), machine("m-3"), machine("m-4", "2026-09-01")];
const TITLES = [
  { id: "r1", name: "Surging Sparks" },
  { id: "r2", name: "Prismatic Evolutions" },
  { id: "r3", name: "Evolving Skies" },
  { id: "new", name: "Destined Rivals" },
];

/**
 * r1 (SV, 10 jan.): m-1 2/dag vecka 1 och sedan var 3:e dag (21), m-2 1/dag vecka 1 och sedan
 *   var 3:e dag (14), m-3 inget. Första veckan 21 av 35 = 60 %.
 * r2 (SV, första order 1 apr.): m-1 1/dag i 14 dagar, m-2 1/dag i 28, m-3 1/dag i 7.
 *   Första veckan 21 av 49 = 42,9 %.
 * r3 (SWSH, 1 juli): m-1 1/dag i 28 dagar.
 */
function history(): OrderLine[] {
  const later = (d: number) => (d >= 7 && d % 3 === 0 ? 1 : 0);
  return [
    ...daily("r1m1", "r1", "m-1", "2026-01-10", 28, (d) => (d < 7 ? 2 : later(d))),
    ...daily("r1m2", "r1", "m-2", "2026-01-10", 28, (d) => (d < 7 ? 1 : later(d))),
    ...daily("r2m1", "r2", "m-1", "2026-04-01", 14, 1),
    ...daily("r2m2", "r2", "m-2", "2026-04-01", 28, 1),
    ...daily("r2m3", "r2", "m-3", "2026-04-01", 7, 1),
    ...daily("r3m1", "r3", "m-1", "2026-07-01", 28, 1),
    // Försäljning efter horisonten räknas inte.
    ord("late", "r1", "m-1", "2026-03-01"),
  ];
}

const RELEASES = [
  { titleId: "r1", series: "SV", releaseDate: "2026-01-10" },
  { titleId: "r2", series: "sv " },
  { titleId: "r3", series: "SWSH", releaseDate: "2026-07-01" },
];

const base = {
  orders: history(),
  releases: RELEASES,
  machines: MACHINES,
  asOf: "2026-11-01",
  titles: TITLES,
  newRelease: { titleId: "new", series: "SV", releaseDate: "2026-11-07" },
};

describe("releaseProfiles", () => {
  it("släppdag angiven eller första order; pack per automat i drift hela horisonten", () => {
    const [r1, r2, r3] = releaseProfiles(base);
    expect(r1!.launchSource).toBe("given");
    expect(r2!.launchSource).toBe("first-sale");
    expect(r2!.launchDate).toBe("2026-04-01");
    expect(r1!.totalUnits).toBe(35);
    expect(r1!.machines).toEqual([
      { machineId: "m-1", units: 21 },
      { machineId: "m-2", units: 14 },
      { machineId: "m-3", units: 0 },
    ]);
    expect(r1!.cumulativeBp![6]).toBe(6_000);
    expect(r1!.cumulativeBp![27]).toBe(10_000);
    expect(r1!.orderIds).not.toContain("late");
    expect(r3!.complete).toBe(true);
  });

  it("pågående släpp är inte komplett och har bara dagar till och med asOf", () => {
    const [p] = releaseProfiles({
      ...base,
      releases: [{ titleId: "r3", releaseDate: "2026-07-01" }],
      asOf: "2026-07-10",
    });
    expect(p!.complete).toBe(false);
    expect(p!.observedDays).toBe(10);
    expect(p!.totalUnits).toBe(10);
  });

  it("släpp utan dag och utan order hoppas över; framtida släpp likaså", () => {
    expect(
      releaseProfiles({
        ...base,
        releases: [{ titleId: "x" }, { titleId: "y", releaseDate: "2027-01-01" }],
      }),
    ).toEqual([]);
  });

  it("dubblett kastar", () => {
    expect(() =>
      releaseProfiles({ ...base, releases: [{ titleId: "r1" }, { titleId: "r1" }] }),
    ).toThrow(DomainError);
  });
});

describe("releaseCurve", () => {
  it("medelvärde av släppens andelar; varje släpp väger lika", () => {
    const profiles = releaseProfiles(base).filter((p) => p.titleId !== "r3");
    const curve = releaseCurve(profiles, 28, TITLES)!;
    // (60 % + 42,86 %) / 2 = 51,43 %
    expect(curve.cumulativeBp[6]).toBe(5_143);
    expect(curve.cumulativeBp[27]).toBe(10_000);
    expect(curve.weeklyBp).toEqual([5_143, 2_000, 1_286, 1_571]);
    expect(curve.weeklyBp.reduce((s, v) => s + v, 0)).toBe(10_000);
    expect(plain(curve.text)).toBe(
      "Tidigare släpp (Surging Sparks och Prismatic Evolutions) sålde i snitt 51 % av de första 28 dagarnas försäljning under första veckan.",
    );
  });

  it("kortare sista vecka när horisonten inte är jämna veckor", () => {
    const profiles = releaseProfiles({ ...base, horizonDays: 10 });
    const curve = releaseCurve(profiles, 10)!;
    expect(curve.weeklyBp).toHaveLength(2);
    expect(curve.weeklyBp.reduce((s, v) => s + v, 0)).toBe(10_000);
  });

  it("null utan kompletta släpp med försäljning", () => {
    expect(releaseCurve([], 28)).toBeNull();
    expect(releaseCurve(releaseProfiles({ ...base, asOf: "2026-01-20" }), 28)).toBeNull();
  });
});

describe("suggestReleasePurchase", () => {
  it("jämför inom serien, median per automat och typisk automat för automater utan historik", () => {
    const s = suggestReleasePurchase(base);
    expect(s.status).toBe("ok");
    expect(s.basis).toBe("series");
    expect(s.comparableTitleIds).toEqual(["r1", "r2"]);
    // samlat: 0, 7, 14, 14, 21, 28 → 14
    expect(s.typicalUnitsPerMachineTenths).toBe(140);
    expect(s.allocations.map((a) => [a.machineId, a.expectedTenths, a.source, a.units])).toEqual([
      ["m-1", 175, "history", 18],
      ["m-2", 210, "history", 21],
      ["m-3", 35, "history", 3],
      ["m-4", 140, "typical", 14],
    ]);
    expect(s.machineUnits).toBe(56);
    expect(s.purchaseUnits).toBe(56);
    expect(s.warehouseUnits).toBe(0);
    expect(s.weeklyUnits).toEqual([29, 11, 7, 9]);
    expect(plain(s.allocations[0]!.text)).toBe(
      "Automat 1: 18 pack (median av 2 släpp: 21, 14 pack).",
    );
    expect(plain(s.allocations[3]!.text)).toBe(
      "Automat 4: 14 pack (ingen egen släpphistorik, typisk automat 14 pack).",
    );
    expect(plain(s.text)).toBe(
      "Förslag för Destined Rivals (7 nov.): köp 56 pack och lägg 56 i 4 automater. Underlag: 2 tidigare släpp i samma serie (Surging Sparks och Prismatic Evolutions) sålde i median 14 pack per automat de första 28 dagarna. 51 % brukar säljas första veckan.",
    );
  });

  it("för få släpp i serien: alla kompletta släpp jämförs", () => {
    const s = suggestReleasePurchase({ ...base, minComparable: 3 });
    expect(s.basis).toBe("all");
    expect(s.comparableTitleIds).toEqual(["r1", "r2", "r3"]);
    // m-1: 21, 14, 28 → 21
    expect(s.allocations[0]!.expectedTenths).toBe(210);
  });

  it("hela lådor, lager och minsta beställning", () => {
    const boxed = suggestReleasePurchase({ ...base, boxSize: 36 });
    expect([boxed.purchaseUnits, boxed.boxes, boxed.warehouseUnits]).toEqual([72, 2, 16]);
    expect(plain(boxed.text)).toContain(
      "köp 72 pack (2 lådor à 36) och lägg 56 i 4 automater; 16 blir kvar i lagret.",
    );
    const stocked = suggestReleasePurchase({ ...base, boxSize: 36, onHandUnits: 20 });
    expect([stocked.purchaseUnits, stocked.boxes, stocked.warehouseUnits]).toEqual([36, 1, 0]);
    const plenty = suggestReleasePurchase({ ...base, onHandUnits: 60 });
    expect([plenty.purchaseUnits, plenty.warehouseUnits]).toEqual([0, 4]);
    const moq = suggestReleasePurchase({ ...base, minOrderQty: 100 });
    expect([moq.purchaseUnits, moq.warehouseUnits]).toEqual([100, 44]);
  });

  it("manuellt antagande skalar förväntan och syns i texten", () => {
    const s = suggestReleasePurchase({ ...base, scaleBp: 12_000 });
    // 56 × 1,2 = 67,2 → 68
    expect(s.machineUnits).toBe(68);
    expect(s.allocations.reduce((sum, a) => sum + a.units, 0)).toBe(68);
    expect(plain(s.text)).toContain("Antagande: släppet blir 120 % av ett vanligt släpp.");
  });

  it("valda automater; det nya släppet ingår aldrig i sin egen historik", () => {
    const s = suggestReleasePurchase({
      ...base,
      releases: [...RELEASES, { titleId: "new", releaseDate: "2026-11-07" }],
      targetMachineIds: ["m-2", "m-2"],
    });
    expect(s.allocations.map((a) => a.machineId)).toEqual(["m-2"]);
    expect(s.machineUnits).toBe(21);
    expect(s.comparableTitleIds).not.toContain("new");
  });

  it("utan jämförbara släpp: inget förslag", () => {
    const s = suggestReleasePurchase({ ...base, releases: [] });
    expect(s.status).toBe("no-history");
    expect(s.purchaseUnits).toBe(0);
    expect(s.allocations).toEqual([]);
    expect(plain(s.text)).toContain("inget tidigare släpp har 28 dagars försäljning");
  });

  it("ogiltiga inställningar kastar", () => {
    expect(() => suggestReleasePurchase({ ...base, boxSize: 0 })).toThrow(DomainError);
    expect(() => suggestReleasePurchase({ ...base, horizonDays: 0 })).toThrow(DomainError);
    expect(() =>
      suggestReleasePurchase({ ...base, newRelease: { titleId: "new", releaseDate: "x" } }),
    ).toThrow(DomainError);
  });
});

describe("releaseOutcome", () => {
  const suggestion = suggestReleasePurchase(base);
  const outcomeBase = {
    titleId: "new",
    releaseDate: "2026-11-07",
    allocations: suggestion.allocations,
    curveCumulativeBp: suggestion.curve!.cumulativeBp,
    titles: TITLES,
    machines: MACHINES,
  };
  const sold = [
    ...daily("n1", "new", "m-1", "2026-11-07", 6, 3),
    ...daily("n2", "new", "m-2", "2026-11-07", 7, 1),
    ord("x1", "new", "m-9", "2026-11-08"),
    ord("x2", "new", null, "2026-11-09"),
  ];

  it("efter en vecka: väntat enligt släppkurvan, slutsålt och automater utan förslag", () => {
    const r = releaseOutcome({ ...outcomeBase, orders: sold, asOf: "2026-11-13" });
    expect(r.status).toBe("running");
    expect(r.elapsedDays).toBe(7);
    expect(r.actual).toBe(27);
    // 56 × 51,43 % = 28,8
    expect(r.expectedByNowTenths).toBe(288);
    expect(r.diffBp).toBe(-625);
    // Lika mot lika: 25 pack i automaterna med förslag mot 56 × 51,43 % = 28,8008 → −13,20 %.
    expect(r.plannedActual).toBe(25);
    expect(r.plannedDiffBp).toBe(-1_320);
    expect(r.pace).toBe("on-track");
    const m1 = r.machines.find((m) => m.machineId === "m-1")!;
    expect(m1).toMatchObject({
      allocated: 18,
      actual: 18,
      soldOut: true,
      soldOutDate: "2026-11-12",
      pace: "ahead",
    });
    const m3 = r.machines.find((m) => m.machineId === "m-3")!;
    expect(m3).toMatchObject({ actual: 0, diffBp: -10_000, pace: "behind", soldOut: false });
    expect(r.unplanned).toEqual([
      { machineId: null, actual: 1 },
      { machineId: "m-9", actual: 1 },
    ]);
    expect(plain(r.text)).toBe(
      "Destined Rivals efter 7 av 28 dagar: 27 pack sålda, varav 25 i automaterna med förslag, förslaget väntade 28,8 hittills (−13 %). I linje med förslaget. Slutsålt: Automat 1 (12 nov.); där kunde mer ha sålts. 2 pack såldes i automater utan förslag.",
    );
  });

  it("efter horisonten: sålt mot föreslaget; utan kurva jämn försäljning", () => {
    const r = releaseOutcome({
      ...outcomeBase,
      curveCumulativeBp: undefined,
      orders: sold,
      asOf: "2026-12-31",
    });
    expect(r.status).toBe("done");
    expect(r.elapsedDays).toBe(28);
    expect(r.expectedByNowTenths).toBe(560);
    expect(r.pace).toBe("behind");
    expect(plain(r.text)).toContain(
      "efter 28 dagar: 27 pack sålda, varav 25 i automaterna med förslag mot 56 föreslagna (−55 %). Efter förslaget.",
    );
    const half = releaseOutcome({
      ...outcomeBase,
      curveCumulativeBp: undefined,
      orders: sold,
      asOf: "2026-11-20",
    });
    expect(half.expectedByNowTenths).toBe(280);
  });

  it("oplanerad försäljning blåser inte upp riktningen: lika mot lika avgör", () => {
    // Förslag 10 pack i m-1, jämn försäljning: väntat efter 14 av 28 dagar = 5.
    // m-1 sålde 5 (i linje); m-9 utan förslag sålde 3 → totalt 8 (+60 %), men pace följer 5 mot 5.
    const r = releaseOutcome({
      titleId: "new",
      releaseDate: "2026-11-07",
      asOf: "2026-11-20",
      allocations: [{ machineId: "m-1", units: 10 }],
      orders: [
        ...daily("a", "new", "m-1", "2026-11-07", 5, 1),
        ...daily("b", "new", "m-9", "2026-11-07", 3, 1),
      ],
    });
    expect(r.actual).toBe(8);
    expect(r.diffBp).toBe(6_000);
    expect(r.plannedActual).toBe(5);
    expect(r.plannedDiffBp).toBe(0);
    expect(r.pace).toBe("on-track");
    expect(r.evidence.figures.find((f) => f.key === "plannedDiffBp")?.value).toBe(0);
  });

  it("före släppdagen: inget utfall", () => {
    const r = releaseOutcome({ ...outcomeBase, orders: sold, asOf: "2026-11-06" });
    expect(r.status).toBe("not-started");
    expect(r.diffBp).toBeNull();
  });

  it("för kort kurva och negativa antal kastar", () => {
    expect(() =>
      releaseOutcome({
        ...outcomeBase,
        orders: [],
        asOf: "2026-11-13",
        curveCumulativeBp: [10_000],
      }),
    ).toThrow(DomainError);
    expect(() =>
      releaseOutcome({
        ...outcomeBase,
        orders: [],
        asOf: "2026-11-13",
        allocations: [{ machineId: "m-1", units: -1 }],
      }),
    ).toThrow(DomainError);
  });
});
