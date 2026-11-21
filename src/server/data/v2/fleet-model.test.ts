import { describe, expect, it } from "vitest";

import type { IsoDate } from "@/domain";

import { buildFleetState, type FleetInput } from "./fleet-model";
import { buildDayRoute, DEFAULT_ROUTE_LIMITS, localDate } from "./route-model";

const today = "2026-11-21" as IsoDate;
const now = new Date("2026-11-21T10:00:00Z");

function sales(machineId: string, titleId: string, perDay: number, days = 14) {
  const out: { machineId: string; titleId: string; businessDate: IsoDate }[] = [];
  for (let d = 1; d <= days; d++) {
    const date = new Date(Date.UTC(2026, 10, 21 - d)).toISOString().slice(0, 10) as IsoDate;
    for (let i = 0; i < perDay; i++) out.push({ machineId, titleId, businessDate: date });
  }
  return out;
}

const base: FleetInput = {
  today,
  now,
  timeZone: "Europe/Stockholm",
  machines: [
    { id: "m1", code: "BL-001", name: "Ett", storeId: "s1", activeFrom: null, activeTo: null },
    { id: "m2", code: "BL-002", name: "Två", storeId: null, activeFrom: null, activeTo: null },
    { id: "m3", code: "BL-003", name: "Tre", storeId: null, activeFrom: null, activeTo: null },
    {
      id: "m4",
      code: "BL-004",
      name: "Gammal",
      storeId: null,
      activeFrom: null,
      activeTo: "2026-01-01" as IsoDate,
    },
  ],
  stores: new Map([
    [
      "s1",
      {
        id: "s1",
        name: "Butiken",
        city: "Staden",
        address: null,
        phone: null,
        contactName: null,
        location: null,
        power: null,
      },
    ],
  ]),
  health: new Map([["m3", { status: "offline", since: "2026-11-21T08:00:00Z" }]]),
  power: new Map(),
  fills: new Map([
    [
      "m1",
      [
        { title_id: "a", units: 4, capacity: 10, channels: 1, empty: 0 },
        { title_id: "b", units: 0, capacity: 10, channels: 1, empty: 1 },
      ],
    ],
    ["m2", null],
  ]),
  stock: [{ machineId: "m2", titleId: "a", onHand: 30 }],
  sales: [...sales("m1", "b", 2), ...sales("m2", "a", 1)],
  lastRefill: new Map([["m1", "2026-11-21T07:30:00Z"]]),
  startklar: new Set(),
  economy: null,
};

describe("buildFleetState", () => {
  it("en rad per aktiv automat, sorterad på status; utan ekonomi inga öre", () => {
    const s = buildFleetState(base);
    expect(s.machines.map((m) => [m.code, m.status])).toEqual([
      ["BL-003", "offline"],
      ["BL-001", "fyll-pa"],
      ["BL-002", "i-drift"],
    ]);
    expect(s.machines.every((m) => m.economy === null)).toBe(true);
    expect(s.economy).toBe(false);
    expect(JSON.stringify(s)).not.toMatch(/Ore"/);
    expect(s.counts.offline).toBe(1);
    expect(s.counts["fyll-pa"]).toBe(1);
  });

  it("Awish-fyllnad, takt, tom om, butik och senaste påfyllning", () => {
    const m1 = buildFleetState(base).machines.find((m) => m.id === "m1")!;
    expect(m1.fill?.fillBp).toBe(2_000);
    expect(m1.units).toBe(4);
    expect(m1.unitsPerDayMilli).toBe(2_000);
    expect(m1.daysLeft).toBe(2);
    expect(m1.emptyTitleIds).toEqual(["b"]);
    expect(m1.store?.city).toBe("Staden");
    expect(m1.sales30).toHaveLength(30);
    expect(m1.sales30[29]).toBe(0);
    expect(m1.sales30[28]).toBe(2);
    // Utan Awish-läsning: lagret i appen.
    const m2 = buildFleetState(base).machines.find((m) => m.id === "m2")!;
    expect(m2.fill).toBeNull();
    expect(m2.units).toBe(30);
    expect(m2.daysLeft).toBe(30);
  });

  it("ekonomiroller får vinst per dag, mot medianen och förlust", () => {
    const s = buildFleetState({
      ...base,
      economy: {
        rows: new Map([
          ["m1", { profitPerDayOre: 20_000, vsMedianOre: 2_000, verdict: "good" }],
          ["m3", { profitPerDayOre: 15_000, vsMedianOre: -3_000, verdict: "good" }],
        ]),
        medianProfitPerDayOre: 18_000,
      },
    });
    const m3 = s.machines.find((m) => m.id === "m3")!;
    expect(m3.economy?.lossProfitPerDayOre).toBe(15_000);
    const m1 = s.machines.find((m) => m.id === "m1")!;
    // Fack b tomt: 2 pack/dag × 10 000 öre/pack (snitt) = 20 000, aldrig mer än vinsten per dag.
    expect(m1.economy?.lossProfitPerDayOre).toBe(20_000);
    expect(s.medianProfitPerDayOre).toBe(18_000);
  });
});

describe("buildDayRoute", () => {
  it("stopp ur besöksplanen med butik, status, klar och brist", () => {
    const fleet = buildFleetState(base);
    const route = buildDayRoute({
      date: today,
      fleet,
      limits: DEFAULT_ROUTE_LIMITS,
      day: {
        date: today,
        stops: [
          {
            machineId: "m1",
            machineName: "Ett",
            sequence: 1,
            needBy: today,
            late: false,
            reasons: ["Tom"],
            packs: [
              {
                titleId: "b",
                titleName: "Black Bolt",
                quantity: 10,
                onHandNow: 0,
                projectedAtVisit: 0,
                target: 10,
                capacity: 10,
                channels: ["A1"],
                shortBy: 4,
                stockoutDate: today,
              },
            ],
            totalPacks: 10,
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
            link: "/automater/m1",
          },
        ],
        load: [{ titleId: "b", titleName: "Black Bolt", quantity: 10 }],
        totalPacks: 10,
        totalMeters: null,
        routeMethod: "urgency",
        title: "",
      },
    });
    expect(route.stops[0]).toMatchObject({
      code: "BL-001",
      status: "fyll-pa",
      done: true,
      packs: 10,
    });
    expect(route.cities).toEqual(["Staden"]);
    expect(route.short).toEqual([{ titleId: "b", titleName: "Black Bolt", shortBy: 4 }]);
    expect(route.limits.maxStops).toBe(6);
    expect(
      buildDayRoute({ date: today, day: null, fleet, limits: DEFAULT_ROUTE_LIMITS }).stops,
    ).toEqual([]);
  });

  it("lokalt datum i tidszonen", () => {
    expect(localDate("2026-11-20T23:30:00Z", "Europe/Stockholm")).toBe("2026-11-21");
  });
});
