import { describe, expect, it } from "vitest";
import { daily } from "@/analytics/todos/test-helpers";
import {
  distanceMeters,
  kmText,
  planRoute,
  planVisits,
  type VisitMachine,
  type VisitPlanInput,
} from "./index";

const t = (s: string | undefined) => (s ?? "").replace(/ /g, " ");
const NOW = "2026-11-02T09:00:00Z"; // måndag 2 nov. 10:00 svensk tid

const titles = [
  { id: "t1", name: "30th Celebration" },
  { id: "t2", name: "Surging Sparks" },
];

// Fyra automater längs en linje österut från depån (ca 1,1 km per 0,01° longitud på 59° N).
const DEPOT = { lat: 59.33, lng: 18.0 };
const m = (id: string, lngOffset: number | null, p: Partial<VisitMachine> = {}): VisitMachine => ({
  id,
  name: `Automat ${id.slice(1)}`,
  activeFrom: null,
  activeTo: null,
  location: lngOffset === null ? null : { lat: 59.33, lng: 18.0 + lngOffset },
  ...p,
});

function base(p: Partial<VisitPlanInput> = {}): VisitPlanInput {
  return {
    machines: [m("m1", 0.03), m("m2", 0.01), m("m3", 0.02), m("m4", 0.04)],
    titles,
    // 14 dagar t.o.m. i dag.
    orders: [
      ...daily("t1", "m1", "2026-10-20", 14, 2),
      ...daily("t1", "m2", "2026-10-20", 14, 1),
      ...daily("t1", "m3", "2026-10-20", 14, 1),
      ...daily("t2", "m4", "2026-10-20", 14, 2),
    ],
    stock: [
      { machineId: "m1", titleId: "t1", onHand: 5 }, // slut tor 5 nov.
      { machineId: "m2", titleId: "t1", onHand: 3 }, // slut tor 5 nov.
      { machineId: "m3", titleId: "t1", onHand: 20 }, // räcker
      { machineId: "m4", titleId: "t2", onHand: 0 }, // slut
    ],
    depot: DEPOT,
    ...p,
  };
}

describe("planVisits", () => {
  it("besöker så sent som möjligt före slut, och direkt när det redan är slut", () => {
    const plan = planVisits(base(), NOW);
    expect(plan.period).toEqual({ start: "2026-11-02", end: "2026-11-08" });
    expect(plan.days.map((d) => [d.date, d.stops.map((s) => s.machineId)])).toEqual([
      ["2026-11-02", ["m4"]],
      ["2026-11-04", ["m2", "m1"]], // ordnade efter avstånd från depån
    ]);
    expect(plan.notNeeded).toEqual([{ machineId: "m3", needBy: "2026-11-21" }]);
    const mon = plan.days[0];
    expect(mon?.stops[0]?.late).toBe(true);
    expect(t(mon?.stops[0]?.reasons[0])).toBe("Surging Sparks är slut (2,0 pack/dag)");
    const wed = plan.days[1];
    expect(t(wed?.stops[1]?.reasons[0])).toBe(
      "30th Celebration tar slut tor 5 nov. (5 kvar, 2,0 pack/dag)",
    );
    expect(wed?.stops.map((s) => s.needBy)).toEqual(["2026-11-04", "2026-11-04"]);
    expect(t(plan.summary)).toBe("3 besök på 2 dagar, 33 pack.");
  });

  it("packlista: fyller för 7 dagar räknat på lagret vid besöket, eller till kapacitet", () => {
    const plan = planVisits(base(), NOW);
    const m1 = plan.days[1]?.stops.find((s) => s.machineId === "m1");
    // Onsdag: 5 − golv(28 × 2 / 14) = 1 kvar; mål tak(28 × 7 / 14) = 14 → 13 pack.
    expect(m1?.packs).toEqual([
      {
        titleId: "t1",
        titleName: "30th Celebration",
        quantity: 13,
        onHandNow: 5,
        projectedAtVisit: 1,
        target: 14,
        capacity: null,
        channels: [],
        shortBy: 0,
        stockoutDate: "2026-11-05",
      },
    ]);
    const withCap = planVisits(
      base({ capacities: [{ machineId: "m1", titleId: "t1", capacity: 20 }] }),
      NOW,
    );
    expect(withCap.days[1]?.stops.find((s) => s.machineId === "m1")?.packs[0]?.quantity).toBe(19);
    expect(plan.days[1]?.load).toEqual([
      { titleId: "t1", titleName: "30th Celebration", quantity: 19 },
    ]);
  });

  it("kapacitet mindre än behovet: fyller bara till kapaciteten, med facken, och centrallagret begränsar", () => {
    // m1 säljer 2 pack/dag; 7 dagars mål vore 14, men facken rymmer 8.
    const capacities = [{ machineId: "m1", titleId: "t1", capacity: 8, channels: ["A3", "A4"] }];
    const plan = planVisits(base({ capacities }), NOW);
    const p = plan.days[1]?.stops.find((s) => s.machineId === "m1")?.packs[0];
    // Onsdag: 1 kvar vid besöket → 8 − 1 = 7 pack.
    expect(p).toMatchObject({ target: 8, capacity: 8, quantity: 7, projectedAtVisit: 1 });
    expect(p?.channels).toEqual(["A3", "A4"]);
    expect(t(plan.days[1]?.stops.find((s) => s.machineId === "m1")?.evidence.rule)).toContain(
      "fyll till kapacitet",
    );
    const capped = planVisits(
      base({
        capacities,
        warehouseStock: [
          { titleId: "t1", onHand: 3 },
          { titleId: "t2", onHand: 0 },
        ],
      }),
      NOW,
    );
    const all = capped.days.flatMap((d) => d.stops).flatMap((s) => s.packs);
    expect(all.filter((x) => x.titleId === "t1").reduce((n, x) => n + x.quantity, 0)).toBe(3);
    // Saldot vid besöket redan på kapaciteten: inget att ta med.
    const full = planVisits(
      base({
        capacities: [{ machineId: "m1", titleId: "t1", capacity: 1 }],
      }),
      NOW,
    );
    expect(
      full.days.flatMap((d) => d.stops).find((s) => s.machineId === "m1")?.packs ?? [],
    ).toEqual([]);
  });

  it("centrallagret begränsar i brådskeordning och bristen syns", () => {
    const plan = planVisits(
      base({
        warehouseStock: [
          { titleId: "t1", onHand: 10 },
          { titleId: "t2", onHand: 100 },
        ],
      }),
      NOW,
    );
    const wed = plan.days[1];
    // Samma needBy: Automat 1 före Automat 2 i namnordning.
    const m1 = wed?.stops.find((s) => s.machineId === "m1");
    const m2 = wed?.stops.find((s) => s.machineId === "m2");
    expect(m1?.packs[0]?.quantity).toBe(10);
    expect(m1?.packs[0]?.shortBy).toBe(3);
    expect(m2?.packs[0]?.quantity).toBe(0);
    expect(m2?.packs[0]?.shortBy).toBe(6);
    expect(t(m2?.reasons[1])).toBe("Vårt lager räcker inte: 6 × 30th Celebration saknas");
  });

  it("högst maxStopsPerDay: överskottet flyttas till en tidigare dag", () => {
    const plan = planVisits(base({ options: { maxStopsPerDay: 1, minStopsPerTrip: 1 } }), NOW);
    expect(plan.days.map((d) => [d.date, d.stops.map((s) => s.machineId)])).toEqual([
      ["2026-11-02", ["m4"]],
      ["2026-11-03", ["m2"]],
      ["2026-11-04", ["m1"]],
    ]);
    expect(plan.overflow).toEqual([]);
  });

  it("utan plats någonstans hamnar automaten i overflow", () => {
    const plan = planVisits(
      base({ options: { maxStopsPerDay: 1, minStopsPerTrip: 1, visitWeekdays: [1] } }),
      NOW,
    );
    expect(plan.days.map((d) => d.stops.length)).toEqual([1]);
    expect(plan.overflow).toHaveLength(2);
  });

  it("ensamt besök en senare dag slås ihop med en tidigare besöksdag", () => {
    const plan = planVisits(
      base({ extraVisits: [{ machineId: "m3", reason: "Misstänkt fel", needBy: "2026-11-06" }] }),
      NOW,
    );
    // m3 skulle ensam ha fått fredag; den följer med onsdagens tur i stället.
    expect(plan.days.map((d) => [d.date, d.stops.length])).toEqual([
      ["2026-11-02", 1],
      ["2026-11-04", 3],
    ]);
    const m3 = plan.days[1]?.stops.find((s) => s.machineId === "m3");
    expect(m3?.reasons[0]).toBe("Misstänkt fel");
    expect(m3?.late).toBe(false);
  });

  it("utan koordinater ordnas besöken efter brådska och sträckan är okänd", () => {
    const plan = planVisits(
      base({ machines: [m("m1", null), m("m2", 0.01), m("m3", 0.02), m("m4", 0.04)] }),
      NOW,
    );
    const wed = plan.days[1];
    expect(wed?.routeMethod).toBe("urgency");
    expect(wed?.totalMeters).toBeNull();
    expect(wed?.stops.map((s) => s.machineId)).toEqual(["m1", "m2"]);
    expect(t(wed?.title)).toBe("ons 4 nov.: 2 besök, 19 pack");
  });

  it("med koordinater: sträckor och dagens titel", () => {
    const plan = planVisits(base(), NOW);
    const wed = plan.days[1];
    expect(wed?.routeMethod).toBe("distance");
    expect(wed?.stops.map((s) => s.sequence)).toEqual([1, 2]);
    const legs = wed?.stops.map((s) => s.distanceFromPreviousMeters) ?? [];
    expect(legs[0]).toBe(distanceMeters(DEPOT, { lat: 59.33, lng: 18.01 }));
    expect(wed?.totalMeters).toBe(
      distanceMeters(DEPOT, { lat: 59.33, lng: 18.01 }) +
        distanceMeters({ lat: 59.33, lng: 18.01 }, { lat: 59.33, lng: 18.03 }) +
        distanceMeters({ lat: 59.33, lng: 18.03 }, DEPOT),
    );
    expect(t(wed?.title)).toMatch(/^ons 4 nov\.: 2 besök, 19 pack, \d+,\d km$/);
  });

  it("inaktiva automater och helgdagar", () => {
    const plan = planVisits(
      base({
        machines: [
          m("m1", 0.03, { activeTo: "2026-10-31" }),
          m("m2", 0.01),
          m("m3", 0.02),
          m("m4", 0.04),
        ],
      }),
      NOW,
    );
    expect(plan.days.flatMap((d) => d.stops.map((s) => s.machineId))).not.toContain("m1");
    // Plan som börjar lördag: första besöksdag är måndag.
    const weekend = planVisits(base({ options: { start: "2026-11-07" } }), NOW);
    expect(weekend.days.map((d) => d.date)).toEqual(["2026-11-09"]);
  });

  it("tom plan och ogiltiga inställningar", () => {
    const empty = planVisits(
      base({
        stock: [{ machineId: "m3", titleId: "t1", onHand: 50 }],
        orders: daily("t1", "m3", "2026-10-20", 14, 1),
      }),
      NOW,
    );
    expect(empty.days).toEqual([]);
    expect(t(empty.summary)).toBe("Inga besök behövs mån 2 nov.–sön 8 nov.");
    expect(() => planVisits(base({ options: { maxStopsPerDay: 0 } }), NOW)).toThrow();
    expect(() => planVisits(base({ options: { start: "2026-11-01" } }), NOW)).toThrow();
  });
});

describe("planRoute", () => {
  const p = (id: string, lng: number) => ({ id, location: { lat: 59.33, lng } });

  it("närmaste granne från depån och tillbaka", () => {
    const r = planRoute([p("c", 18.03), p("a", 18.01), p("d", 18.04), p("b", 18.02)], DEPOT);
    expect(r.order).toEqual(["a", "b", "c", "d"]);
    expect(r.totalMeters).toBe(
      r.legs.reduce((a, b) => a + b, 0) + distanceMeters({ lat: 59.33, lng: 18.04 }, DEPOT),
    );
    expect(r.legs[0]).toBe(distanceMeters(DEPOT, { lat: 59.33, lng: 18.01 }));
  });

  it("2-opt rättar korsande rutt", () => {
    // Fyra hörn i en rektangel; närmaste granne från (0,0) kan ge en korsning.
    const pts = [
      { id: "a", location: { lat: 59.3, lng: 18.0 } },
      { id: "b", location: { lat: 59.3, lng: 18.1 } },
      { id: "c", location: { lat: 59.31, lng: 18.0 } },
      { id: "d", location: { lat: 59.31, lng: 18.1 } },
    ];
    const r = planRoute(pts);
    expect(r.order[0]).toBe("a");
    // Optimal öppen rutt: a → c → d → b (eller a → b → d → c), aldrig a → d.
    expect(r.order[1]).not.toBe("d");
    expect(r.legs[0]).toBe(0);
  });

  it("tom rutt och avstånd", () => {
    expect(planRoute([])).toEqual({ order: [], legs: [], totalMeters: 0 });
    const d = distanceMeters({ lat: 59.3303, lng: 18.0586 }, { lat: 59.8586, lng: 17.6389 });
    expect(d).toBeGreaterThan(63_000);
    expect(d).toBeLessThan(66_000);
    expect(() => distanceMeters({ lat: 91, lng: 0 }, { lat: 0, lng: 0 })).toThrow();
    expect(t(kmText(12_430))).toBe("12,4 km");
    expect(t(kmText(950))).toBe("1,0 km");
  });
});
