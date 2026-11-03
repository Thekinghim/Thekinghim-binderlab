import { describe, expect, it } from "vitest";

import { calendarDays, calendarSummary, dayRouteStops, dayRouteView } from "./route";

const machines = [
  { id: "m1", code: "BL-001", name: "Automat 1", storeId: "s1" },
  { id: "m2", code: "BL-002", name: "Automat 2", storeId: "s2" },
  { id: "m3", code: "BL-003", name: "Automat 3", storeId: "s1" },
];

const places = new Map([
  ["s1", { id: "s1", name: "ICA Lund", address: "Storgatan 1", city: "Lund", location: null }],
  ["s2", { id: "s2", name: "Coop", address: null, city: null, location: null }],
]);

function day(ids: string[], routeMethod: "distance" | "urgency" = "urgency") {
  return {
    date: "2026-11-04",
    stops: ids.map((id, i) => ({ machineId: id, machineName: `Automat ${id}`, totalPacks: 5 + i })),
    totalPacks: ids.length * 5,
    routeMethod,
  } as never;
}

describe("dayRouteStops", () => {
  it("lägger till butikens namn och adress i besöksordning", () => {
    const stops = dayRouteStops(day(["m3", "m1"]), machines, places);
    expect(stops.map((s) => [s.machineId, s.storeName, s.address])).toEqual([
      ["m3", "ICA Lund", "Storgatan 1"],
      ["m1", "ICA Lund", "Storgatan 1"],
    ]);
    expect(stops[0]!.label).toBe("BL‑003 Automat m3");
  });
});

describe("dayRouteView", () => {
  it("listar butiker utan adress en gång och ger länk för resten", () => {
    const view = dayRouteView(day(["m1", "m2"]), machines, places);
    expect(view.missing).toEqual([{ storeId: "s2", name: "Coop" }]);
    expect(view.mapsUrls).toHaveLength(1);
    expect(view.needsLocation).toBe(false);
  });

  it("alla har adress men ordningen är efter brådska: be om plats", () => {
    expect(dayRouteView(day(["m1", "m3"]), machines, places).needsLocation).toBe(true);
    expect(dayRouteView(day(["m1", "m3"], "distance"), machines, places).needsLocation).toBe(false);
    expect(dayRouteView(day(["m1"]), machines, places).needsLocation).toBe(false);
  });
});

describe("kalenderdagar", () => {
  it("en dag eller alla, med kort rubrik", () => {
    const plan = {
      days: [day(["m1"]), { ...(day(["m3"]) as object), date: "2026-11-05" }],
    } as never;
    expect(calendarDays(plan, machines, places).map((d) => d.date)).toEqual([
      "2026-11-04",
      "2026-11-05",
    ]);
    expect(calendarDays(plan, machines, places, "2026-11-05").map((d) => d.date)).toEqual([
      "2026-11-05",
    ]);
    expect(calendarSummary(day(["m1", "m3"]))).toBe("Påfyllning: 2 besök, 10 pack");
  });
});
