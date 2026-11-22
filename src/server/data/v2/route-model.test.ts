import { describe, expect, it } from "vitest";

import type { PackLine, VisitDay, VisitStop } from "@/analytics/visits";
import type { IsoDate } from "@/domain";

import {
  buildDayRoute,
  DEFAULT_ROUTE_LIMITS,
  durationText,
  powerLine,
  roadKm,
  routeMinutes,
} from "./route-model";
import type { FleetMachine, FleetState } from "./types";

const today = "2026-11-21" as IsoDate;

function machine(id: string, city: string, over: Partial<FleetMachine> = {}): FleetMachine {
  return {
    id,
    code: id.toUpperCase(),
    name: `Automat ${id}`,
    store: {
      id: `s-${id}`,
      name: `Butik ${id}`,
      city,
      address: `Gatan 1, ${city}`,
      phone: null,
      contactName: null,
      location: null,
      power: null,
    },
    status: "fyll-pa",
    statusLabel: "Fyll på i dag",
    tone: "warning",
    fill: null,
    units: 10,
    unitsPerDayMilli: 1000,
    daysLeft: 2,
    lastRefillAt: null,
    sales30: [],
    powerOffNow: false,
    offlineSince: null,
    emptyTitleIds: [],
    economy: { profitPerDayOre: 10_000, vsMedianOre: 0, verdict: null, lossProfitPerDayOre: 4_000 },
    ...over,
  };
}

function fleet(machines: FleetMachine[], economy = true): FleetState {
  return {
    today,
    now: "2026-11-21T10:00:00Z",
    timeZone: "Europe/Stockholm",
    machines,
    counts: {} as FleetState["counts"],
    economy,
  };
}

const line = (titleId: string, quantity: number, over: Partial<PackLine> = {}): PackLine => ({
  titleId,
  titleName: titleId.toUpperCase(),
  quantity,
  onHandNow: 0,
  projectedAtVisit: 0,
  target: quantity,
  capacity: 20,
  channels: ["A1", "A2"],
  shortBy: 0,
  stockoutDate: null,
  ...over,
});

function stop(machineId: string, packs: PackLine[], sequence = 1): VisitStop {
  return {
    machineId,
    machineName: machineId,
    sequence,
    needBy: today,
    late: false,
    reasons: ["Tar slut"],
    packs,
    totalPacks: packs.reduce((s, p) => s + p.quantity, 0),
    distanceFromPreviousMeters: null,
    evidence: {
      rule: "",
      period: null,
      orderIds: [],
      dates: [],
      titleIds: [],
      machineIds: [],
      storeIds: [],
      recipientIds: [],
      figures: [],
    },
    link: "",
  };
}

function day(date: string, stops: VisitStop[], meters: number | null = null): VisitDay {
  return {
    date: date as IsoDate,
    stops,
    load: [],
    totalPacks: stops.reduce((s, x) => s + x.totalPacks, 0),
    totalMeters: meters,
    routeMethod: meters === null ? "urgency" : "distance",
    title: "",
  };
}

describe("buildDayRoute (V2)", () => {
  const machines = [
    machine("m1", "Borås"),
    machine("m2", "Borås"),
    machine("m3", "Uddevalla", { status: "offline", statusLabel: "Offline" }),
    machine("m4", "Lerum"),
  ];
  const plan = day(
    today,
    [
      stop("m1", [line("a", 10), line("b", 6, { shortBy: 4, projectedAtVisit: 2 })], 1),
      stop("m2", [line("a", 5)], 2),
      stop("m3", [], 3),
    ],
    200_000,
  );

  it("grupperar per stad, räknar km och tid ca, räddar och packlista mot lagret", () => {
    const r = buildDayRoute({
      date: today,
      day: plan,
      fleet: fleet(machines),
      limits: DEFAULT_ROUTE_LIMITS,
      home: new Map([
        ["a", 100],
        ["b", 6],
        ["c", 80],
      ]),
      later: [day("2026-11-23", [stop("m4", [line("c", 8)])])],
    });
    expect(r.cities).toEqual(["Borås", "Uddevalla"]);
    expect(r.groups.map((g) => [g.city, g.machineIds.length, g.packs])).toEqual([
      ["Borås", 2, 21],
      ["Uddevalla", 1, 0],
    ]);
    // 200 km fågelväg × 1,25 = 250 km; 250/65 h = 231 min + 2 × 18 + 1 × 12.
    expect(r.km).toBe(250);
    expect(r.minutes).toBe(231 + 36 + 12);
    expect(r.stops.map((s) => s.kind)).toEqual(["fill", "fill", "check"]);
    expect(r.stops[0]?.emptySlots).toBe(2); // a väntas vara slut i två fack
    expect(r.savesProfitPerDayOre).toBe(12_000);
    expect(r.load[0]).toMatchObject({ titleId: "b", quantity: 6, shortBy: 4, home: 6 });
    expect(r.short).toEqual([{ titleId: "b", titleName: "B", shortBy: 4 }]);
    // Ersättare: titeln vi har mest kvar av (a: 100 − 15 = 85), ett helt fack (10).
    expect(r.substitutes).toEqual([
      expect.objectContaining({
        machineId: "m1",
        forTitleId: "b",
        titleId: "a",
        packs: 10,
        slots: 1,
      }),
    ]);
    expect(r.upcoming).toEqual([
      {
        date: "2026-11-23",
        cities: ["Lerum"],
        packs: 8,
        stops: [{ machineId: "m4", name: "Automat m4", city: "Lerum", daysLeft: 2 }],
      },
    ]);
  });

  it("påfyllaren (utan ekonomi) får inget räddar-belopp", () => {
    const r = buildDayRoute({
      date: today,
      day: plan,
      fleet: fleet(machines, false),
      limits: DEFAULT_ROUTE_LIMITS,
    });
    expect(r.savesProfitPerDayOre).toBeNull();
  });

  it("hoppa över, till i morgon och lägg till; i går 'till i morgon' kommer med i dag", () => {
    const r = buildDayRoute({
      date: today,
      day: plan,
      fleet: fleet(machines),
      limits: DEFAULT_ROUTE_LIMITS,
      later: [day("2026-11-23", [stop("m4", [line("c", 8)])])],
      changes: [
        { id: "c1", day: today, machineId: "m2", change: "skip" },
        { id: "c2", day: today, machineId: "m3", change: "later" },
        { id: "c3", day: "2026-11-20" as IsoDate, machineId: "m4", change: "later" },
      ],
    });
    expect(r.stops.map((s) => [s.machineId, s.sequence, s.added])).toEqual([
      ["m1", 1, false],
      ["m4", 2, true],
    ]);
    expect(r.stops[1]?.packs).toBe(8);
    expect(r.removed.map((c) => [c.machineId, c.change])).toEqual([
      ["m2", "skip"],
      ["m3", "later"],
    ]);
    // Ändrad rutt: sträckan är okänd.
    expect(r.km).toBeNull();
    expect(r.upcoming).toEqual([]);
  });

  it("klar i dag räknas inte i räddar och inte i tiden", () => {
    const r = buildDayRoute({
      date: today,
      day: plan,
      fleet: fleet([
        machine("m1", "Borås", { lastRefillAt: "2026-11-21T08:00:00Z" }),
        ...machines.slice(1),
      ]),
      limits: DEFAULT_ROUTE_LIMITS,
    });
    expect(r.stops[0]?.done).toBe(true);
    expect(r.savesProfitPerDayOre).toBe(8_000);
    expect(r.minutes).toBe(231 + 18 + 12);
  });

  it("texter", () => {
    expect(roadKm(null)).toBeNull();
    expect(routeMinutes(null, 1, 1)).toBeNull();
    expect(durationText(440)).toBe("7 h 20 min");
    expect(durationText(45)).toBe("45 min");
    expect(powerLine({ off: "21:00", on: "08:00" })).toBe(
      "Strömmen av 21:00–08:00: fyll före 21:00",
    );
    expect(powerLine(null)).toBeNull();
  });
});
