import { describe, expect, it } from "vitest";

import { addDays, dayOfWeek, type IsoDate } from "@/domain";

import { sellOut } from "./index";
import { sellOutPhrase } from "./text";
import {
  WEEK_SHAPE_DAYS,
  weekShape,
  weekShapes,
  weekShapeStart,
  type ShapeSale,
} from "./week-shape";

// I dag torsdag 12 nov. 2026; takten och formen räknas t.o.m. i går, onsdag 11 nov.
const TODAY = "2026-11-12" as IsoDate;
const AS_OF = "2026-11-11" as IsoDate;

/** `days` dagars försäljning t.o.m. `asOf`: `perDay(veckodag)` pack varje dag. */
function sales(
  machineId: string,
  days: number,
  perDay: (weekday: number) => number,
  asOf: IsoDate = AS_OF,
): ShapeSale[] {
  const out: ShapeSale[] = [];
  for (let d = 0; d < days; d++) {
    const date = addDays(asOf, -d);
    for (let i = 0; i < perDay(dayOfWeek(date)); i++) out.push({ machineId, businessDate: date });
  }
  return out;
}

/**
 * Helgen säljer mest: lördag 2,2 gånger snittet (22 pack), torsdag och fredag 1,4 (14 var),
 * övriga dagar 0,5 (5 var). 70 pack i veckan, snitt 10 per dag.
 */
const strongSaturday = (weekday: number) =>
  weekday === 6 ? 22 : weekday === 4 || weekday === 5 ? 14 : 5;

describe("weekShape", () => {
  it("fönstret är exakt 28 dagar t.o.m. asOf", () => {
    expect(WEEK_SHAPE_DAYS).toBe(28);
    expect(weekShapeStart(AS_OF)).toBe("2026-10-15");
  });

  it("andel per veckodag, måndag först, summan 1", () => {
    const shape = weekShape(sales("m1", 28, strongSaturday), { asOf: AS_OF })!;
    expect(shape).toHaveLength(7);
    expect(shape.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(shape[5]).toBeCloseTo(22 / 70, 12); // lördag
    expect(shape[0]).toBeCloseTo(5 / 70, 12); // måndag
    expect(shape[3]).toBeCloseTo(14 / 70, 12); // torsdag
    // Lördagen säljer 2,2 gånger snittet.
    expect(shape[5]! * 7).toBeCloseTo(2.2, 12);
  });

  it("20 dagars försäljning: ingen form (platt snitt)", () => {
    expect(weekShape(sales("m1", 20, strongSaturday), { asOf: AS_OF })).toBeNull();
    expect(weekShape(sales("m1", 27, strongSaturday), { asOf: AS_OF })).not.toBeNull();
    // Aktiv först inom fönstret: ingen form, även om orderna finns.
    expect(
      weekShape(sales("m1", 28, strongSaturday), { asOf: AS_OF, activeFrom: "2026-10-20" }),
    ).toBeNull();
    expect(
      weekShape(sales("m1", 28, strongSaturday), { asOf: AS_OF, activeFrom: "2026-10-15" }),
    ).not.toBeNull();
  });

  it("en vecka utan försäljning mitt i fönstret: ingen form", () => {
    const gap = sales("m1", 28, strongSaturday).filter(
      (s) => s.businessDate < "2026-10-22" || s.businessDate > "2026-10-28",
    );
    expect(weekShape(gap, { asOf: AS_OF })).toBeNull();
  });

  it("för få sålda pack: ingen form", () => {
    // Ett pack varje måndag, onsdag och lördag: 12 pack på fyra veckor.
    const few = sales("m1", 28, (w) => (w === 1 || w === 3 || w === 6 ? 1 : 0));
    expect(weekShape(few, { asOf: AS_OF })).toBeNull();
    expect(weekShape(few, { asOf: AS_OF, minUnits: 12 })).not.toBeNull();
  });

  it("dagens och framtida order räknas inte", () => {
    const base = sales("m1", 28, strongSaturday);
    const withToday = [...base, ...Array.from({ length: 50 }, () => ({ businessDate: TODAY }))];
    expect(weekShape(withToday, { asOf: AS_OF })).toEqual(weekShape(base, { asOf: AS_OF }));
  });
});

describe("weekShapes", () => {
  it("per automat; automater med för lite historik saknas", () => {
    const all = [
      ...sales("m1", 45, strongSaturday),
      ...sales("m2", 20, strongSaturday),
      ...sales("m3", 45, () => 3),
      { machineId: null, businessDate: AS_OF },
    ];
    const shapes = weekShapes(all, { asOf: AS_OF });
    expect([...shapes.keys()].sort()).toEqual(["m1", "m3"]);
    for (const s of shapes.get("m3")!) expect(s).toBeCloseTo(1 / 7, 12);
  });

  it("samma form oavsett hur långt bak laddningen går (45 eller 70 dagar)", () => {
    const a = weekShapes(sales("m1", 45, strongSaturday), { asOf: AS_OF }).get("m1");
    const b = weekShapes(sales("m1", 70, strongSaturday), { asOf: AS_OF }).get("m1");
    const c = weekShapes(sales("m1", 28, strongSaturday), { asOf: AS_OF, covered: true }).get("m1");
    expect(a).toBeDefined();
    expect(b).toEqual(a);
    expect(c).toEqual(a);
  });

  it("en laddning som inte täcker fönstret (15 dagar) ger inga former", () => {
    expect(weekShapes(sales("m1", 15, strongSaturday), { asOf: AS_OF }).size).toBe(0);
    // Exakt 28 dagar utan att säga att fönstret är täckt: inte heller.
    expect(weekShapes(sales("m1", 28, strongSaturday), { asOf: AS_OF }).size).toBe(0);
  });
});

describe("slutdagen med helgen", () => {
  // Titeln säljer 1 pack per dag i snitt (14 pack på 14 dagar).
  const avg = { units: 14, days: 14 };

  it("5 pack en torsdag, lördagen säljer 2,2 gånger snittet: slut på lördag; platt snitt säger måndag", () => {
    const shape = weekShapes(sales("m1", 45, strongSaturday), { asOf: AS_OF }).get("m1")!;
    // Titelns snitt 1 pack/dag × veckodagens styrka: tors 1,4 + fre 1,4 + lör 2,2 = 5,0.
    const weekday = sellOut({ onHand: 5, dailyAvg: avg, from: AS_OF, weekShare: shape });
    expect(weekday).toEqual({ date: "2026-11-14", daysLeft: 3, basis: "weekday" });
    expect(dayOfWeek(weekday!.date)).toBe(6); // lördag
    const flat = sellOut({ onHand: 5, dailyAvg: avg, from: AS_OF });
    expect(flat).toEqual({ date: "2026-11-16", daysLeft: 5, basis: "flat" });
    expect(dayOfWeek(flat!.date)).toBe(1); // måndag
    expect(sellOutPhrase(weekday!.date, TODAY)).toBe(
      "Tar slut på lördag – fyll på senast i morgon",
    );
    expect(sellOutPhrase(flat!.date, TODAY)).toBe("Tar slut på måndag – fyll på senast söndag");
  });

  it("svaga veckodagar räcker längre: 2 pack en söndag kväll räcker till torsdag, inte tisdag", () => {
    const shape = weekShapes(sales("m1", 45, strongSaturday), { asOf: AS_OF }).get("m1")!;
    const sunday = "2026-11-15" as IsoDate;
    // mån 0,5 + tis 0,5 + ons 0,5 + tors 1,4: sista packet säljs på torsdag.
    expect(sellOut({ onHand: 2, dailyAvg: avg, from: sunday, weekShare: shape })).toMatchObject({
      date: "2026-11-19",
      basis: "weekday",
    });
    expect(sellOut({ onHand: 2, dailyAvg: avg, from: sunday })).toMatchObject({
      date: "2026-11-17",
      basis: "flat",
    });
  });

  it("en automat med 20 dagars historik får basis 'flat'", () => {
    const shape = weekShapes(sales("m1", 20, strongSaturday), { asOf: AS_OF }).get("m1") ?? null;
    expect(shape).toBeNull();
    expect(sellOut({ onHand: 5, dailyAvg: avg, from: AS_OF, weekShare: shape })).toEqual({
      date: "2026-11-16",
      daysLeft: 5,
      basis: "flat",
    });
  });
});

describe("sellOutPhrase", () => {
  it("i dag, i morgon, veckodag inom en vecka, annars datum", () => {
    expect(sellOutPhrase("2026-11-11" as IsoDate, TODAY)).toBe("Tar slut i dag – fyll på nu");
    expect(sellOutPhrase(TODAY, TODAY)).toBe("Tar slut i dag – fyll på nu");
    expect(sellOutPhrase("2026-11-13" as IsoDate, TODAY)).toBe("Tar slut i morgon – fyll på i dag");
    expect(sellOutPhrase("2026-11-14" as IsoDate, TODAY)).toBe(
      "Tar slut på lördag – fyll på senast i morgon",
    );
    expect(sellOutPhrase("2026-11-14" as IsoDate, "2026-11-11" as IsoDate)).toBe(
      "Tar slut på lördag – fyll på senast fredag",
    );
    expect(sellOutPhrase("2026-11-18" as IsoDate, TODAY)).toBe(
      "Tar slut på onsdag – fyll på senast tisdag",
    );
    expect(sellOutPhrase("2026-11-21" as IsoDate, TODAY).replace(/ /g, " ")).toBe(
      "Tar slut lör 21 nov. – fyll på senast fre 20 nov.",
    );
  });
});
